import {
  mutation,
  query,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { requireMember } from "./lib/auth";
import { scope } from "./schema";
import { enqueue, inputsCurrent, relevantEntities } from "./lib/jobs";
import {
  taskKindSchema,
  entitySchema,
  type PlanData,
  type SceneData,
} from "../src/domain/model";
import { proposeSchedule } from "../src/domain/planning";
import { publishResult, resultSchema } from "./lib/results";
export const start = mutation({
  args: {
    boardId: v.id("boards"),
    kind: v.string(),
    scope,
    targetId: v.optional(v.id("entities")),
    request: v.optional(v.any()),
    changeId: v.optional(v.id("changes")),
  },
  returns: v.id("runs"),
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.boardId, "editor");
    const kind = taskKindSchema.parse(args.kind);
    if (args.changeId) {
      const change = await ctx.db.get(args.changeId);
      if (
        !change ||
        change.boardId !== args.boardId ||
        change.status !== "regenerating"
      )
        throw new ConvexError("Revision is not ready to regenerate.");
    }
    if (kind === "ingest") {
      const id = ctx.db.normalizeId(
        "assets",
        String(args.request?.assetId || ""),
      );
      const asset = id ? await ctx.db.get(id) : null;
      if (!asset || asset.boardId !== args.boardId)
        throw new ConvexError("Upload the screenplay first.");
    }
    if (kind === "chat" || kind === "interpret") {
      const message = String(args.request?.message || "").trim();
      if (!message || message.length > 8000)
        throw new ConvexError("Write a message under 8,000 characters.");
      await ctx.db.insert("messages", {
        boardId: args.boardId,
        scope: args.scope,
        role: "user",
        text: message,
        createdAt: Date.now(),
        userId: user._id,
      });
    }
    return await enqueue(ctx, { ...args, userId: user._id, kind });
  },
});
export const cancel = mutation({
  args: { runId: v.id("runs") },
  returns: v.null(),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new ConvexError("Task not found.");
    await requireMember(ctx, run.boardId, "editor");
    if (["queued", "running", "waiting"].includes(run.status))
      await ctx.db.patch(runId, {
        status: "cancelled",
        activity: "Cancelled",
        updatedAt: Date.now(),
      });
    return null;
  },
});
export const retry = mutation({
  args: { runId: v.id("runs") },
  returns: v.id("runs"),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new ConvexError("Task not found.");
    const { user } = await requireMember(ctx, run.boardId, "editor");
    if (!["failed", "cancelled", "waiting", "superseded"].includes(run.status))
      throw new ConvexError("This task is still active or complete.");
    if (run.status === "waiting")
      await ctx.db.patch(runId, { status: "superseded" });
    return await enqueue(ctx, {
      boardId: run.boardId,
      kind: taskKindSchema.parse(run.kind),
      scope: run.scope,
      targetId: run.targetId,
      userId: user._id,
      request: run.request,
      changeId: run.changeId,
    });
  },
});
export const events = query({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new ConvexError("Task not found.");
    await requireMember(ctx, run.boardId);
    return await ctx.db
      .query("events")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .order("desc")
      .take(100);
  },
});
export const dispatchInfo = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    const outbox = await ctx.db
      .query("outbox")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .unique();
    return { run, outbox };
  },
});
export const dispatchResult = internalMutation({
  args: { runId: v.id("runs"), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    const item = await ctx.db
      .query("outbox")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .unique();
    if (!run || !item || run.status !== "queued") return null;
    const tries = item.tries + 1;
    await ctx.db.patch(item._id, {
      tries,
      status: args.error ? "pending" : "sent",
      updatedAt: Date.now(),
      error: args.error,
    });
    if (args.error) {
      if (tries >= 3)
        await ctx.db.patch(run._id, {
          status: "failed",
          activity: "Could not start agent",
          error: args.error,
          updatedAt: Date.now(),
        });
      else
        await ctx.scheduler.runAfter(tries * 5000, internal.dispatch.send, {
          runId: run._id,
        });
    }
    return null;
  },
});
export const claim = internalMutation({
  args: { runId: v.id("runs"), attempt: v.number() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.attempt !== args.attempt || run.status !== "queued")
      return false;
    const board = await ctx.db.get(run.boardId);
    const member = await ctx.db
      .query("members")
      .withIndex("by_board_user", (q) =>
        q.eq("boardId", run.boardId).eq("userId", run.createdBy),
      )
      .unique();
    if (!board || board.archived || !member || member.role === "viewer") {
      await ctx.db.patch(run._id, {
        status: "cancelled",
        activity: "Access revoked",
      });
      return false;
    }
    if (!(await inputsCurrent(ctx, run))) {
      await ctx.db.patch(run._id, {
        status: "superseded",
        activity: "Inputs changed",
      });
      return false;
    }
    await ctx.db.patch(run._id, {
      status: "running",
      activity: "Starting agent",
      updatedAt: Date.now(),
    });
    return true;
  },
});
export const context = internalQuery({
  args: { runId: v.id("runs"), attempt: v.number() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.attempt !== args.attempt || run.status !== "running")
      throw new ConvexError("Task is not active.");
    const all = await ctx.db
      .query("entities")
      .withIndex("by_board", (q) => q.eq("boardId", run.boardId))
      .collect();
    const entities = relevantEntities(all, run.scope, run.targetId);
    const choices = await ctx.db
      .query("choices")
      .withIndex("by_board", (q) => q.eq("boardId", run.boardId))
      .collect();
    const script = entities.find((e) => e.kind === "script");
    const assetId =
      run.kind === "ingest" ? run.request?.assetId : script?.data.assetId;
    const normalizedAssetId = assetId
      ? ctx.db.normalizeId("assets", String(assetId))
      : null;
    const asset = normalizedAssetId
      ? await ctx.db.get(normalizedAssetId)
      : null;
    const target = entities.find((e) => e._id === run.targetId);
    let schedule = null;
    if (run.kind === "schedule" && target) {
      const plan = entitySchema.parse(target.data) as PlanData;
      const scenes = entities.filter((e) => e.kind === "scene");
      const inputs = scenes.flatMap((scene) => {
        const choice = choices.find(
          (c) => c.sceneId === scene._id && c.planId === run.targetId,
        );
        const loc = choice && entities.find((e) => e._id === choice.locationId);
        return loc
          ? [
              {
                id: scene._id,
                data: entitySchema.parse(scene.data) as SceneData,
                locationId: loc._id,
                locationName: loc.data.name,
              },
            ]
          : [];
      });
      schedule = proposeSchedule(target._id, plan, inputs);
      if (inputs.length !== scenes.length)
        schedule.conflicts.push(
          "Select a location for every scene in this plan.",
        );
    }
    return {
      contractVersion: 1,
      run: { ...run, request: run.request ?? null },
      entities,
      choices,
      asset: asset
        ? { _id: asset._id, filename: asset.filename, mime: asset.mime }
        : null,
      schedule,
    };
  },
});
export const event = internalMutation({
  args: {
    runId: v.id("runs"),
    attempt: v.number(),
    sequence: v.number(),
    activity: v.string(),
    status: v.optional(v.string()),
    detail: v.optional(v.string()),
    providerId: v.optional(v.string()),
    result: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (
      !run ||
      run.attempt !== args.attempt ||
      run.status !== "running" ||
      args.sequence <= run.eventSequence
    )
      return { accepted: false };
    const membership = await ctx.db
      .query("members")
      .withIndex("by_board_user", (q) =>
        q.eq("boardId", run.boardId).eq("userId", run.createdBy),
      )
      .unique();
    if (!membership || membership.role === "viewer") {
      await ctx.db.patch(run._id, {
        status: "cancelled",
        activity: "Access revoked",
      });
      return { accepted: false };
    }
    if (!(await inputsCurrent(ctx, run))) {
      await ctx.db.patch(run._id, {
        status: "superseded",
        activity: "Inputs changed; result retained in history",
        output: args.result,
        updatedAt: Date.now(),
      });
      return { accepted: false };
    }
    await ctx.db.insert("events", {
      boardId: run.boardId,
      runId: run._id,
      attempt: args.attempt,
      sequence: args.sequence,
      activity: args.activity.slice(0, 200),
      detail: args.detail?.slice(0, 4000),
      providerId: args.providerId,
      createdAt: Date.now(),
    });
    await ctx.db.patch(run._id, {
      eventSequence: args.sequence,
      activity: args.activity.slice(0, 200),
      updatedAt: Date.now(),
    });
    if (args.status === "failed")
      await ctx.db.patch(run._id, {
        status: "failed",
        error: args.detail || "Agent task failed.",
      });
    if (args.status === "complete" || args.status === "waiting") {
      const result = resultSchema.parse(args.result);
      if (run.changeId) {
        await ctx.db.patch(run._id, {
          status: args.status === "waiting" ? "waiting" : "complete",
          output: result,
        });
        if (result.questions.length)
          await publishResult(ctx, run, {
            ...result,
            locations: [],
            scenes: [],
            script: undefined,
            schedule: undefined,
            packet: undefined,
            proposals: [],
          });
        await ctx.scheduler.runAfter(0, internal.changes.advance, {
          changeId: run.changeId,
        });
      } else {
        const publishable =
          args.status === "waiting"
            ? {
                ...result,
                script: run.kind === "ingest" ? result.script : undefined,
                scenes: [],
                locations: [],
                schedule: undefined,
                packet: undefined,
                proposals: [],
              }
            : result;
        await publishResult(ctx, run, publishable);
        await ctx.db.patch(run._id, {
          status: args.status === "waiting" ? "waiting" : "complete",
          // Scene content already has versioned canonical records. Keep run history
          // small so a feature-length screenplay cannot exceed one document's budget.
          output:
            run.kind === "scenes" && args.status === "complete"
              ? { message: result.message, sceneCount: result.scenes.length }
              : result,
        });
      }
    }
    return { accepted: true };
  },
});
export const reap = internalMutation({
  args: {},
  handler: async (ctx) => {
    const unclaimed = await ctx.db
      .query("runs")
      .withIndex("by_status_updated", (q) =>
        q.eq("status", "queued").lt("updatedAt", Date.now() - 5 * 60000),
      )
      .take(50);
    for (const run of unclaimed) {
      const outbox = await ctx.db
        .query("outbox")
        .withIndex("by_run", (q) => q.eq("runId", run._id))
        .unique();
      if (outbox?.status === "sent")
        await ctx.db.patch(run._id, {
          status: "failed",
          activity: "Agent worker did not start",
          error:
            "The queued worker did not claim this task. Retry from the same saved inputs.",
          updatedAt: Date.now(),
        });
    }
    const abandoned = await ctx.db
      .query("runs")
      .withIndex("by_status_updated", (q) =>
        q.eq("status", "running").lt("updatedAt", Date.now() - 8 * 60000),
      )
      .take(50);
    for (const run of abandoned)
      await ctx.db.patch(run._id, {
        status: "failed",
        activity: "Agent disconnected",
        error:
          "The worker stopped reporting progress. Retry from the last saved inputs.",
        updatedAt: Date.now(),
      });
    const pending = await ctx.db
      .query("outbox")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(50);
    for (const item of pending)
      if (item.updatedAt < Date.now() - 60000 && item.tries < 3)
        await ctx.scheduler.runAfter(0, internal.dispatch.send, {
          runId: item.runId,
        });
    return null;
  },
});
