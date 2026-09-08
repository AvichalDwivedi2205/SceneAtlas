import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import {
  taskKindSchema,
  type Scope,
  type TaskKind,
  entitySchema,
} from "../../src/domain/model";
import { validateScope } from "./entities";
import { planReadiness } from "../../src/domain/plan-readiness";
import { scopeEntities } from "../../src/domain/scope";
export function relevantEntities(
  entities: Doc<"entities">[],
  scope: Scope,
  targetId?: string,
  choices: Doc<"choices">[] = [],
  kind?: TaskKind,
) {
  return scopeEntities(entities, scope, targetId, choices, kind);
}
export function blockingQuestions(entities: Doc<"entities">[], kind: TaskKind) {
  return entities.filter(
    (e) =>
      e.kind === "question" &&
      e.data.resolution !== "answered" &&
      e.data.blocks.includes(kind),
  );
}
export function inputFingerprint(entities: Doc<"entities">[], kind: TaskKind) {
  return entities
    .filter(
      (e) =>
        !["note", "answer", "packet"].includes(e.kind) &&
        (kind === "packet" || e.kind !== "schedule"),
    )
    .map((e) => ({ id: e._id, revision: e.revision }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
export async function enqueue(
  ctx: MutationCtx,
  args: {
    boardId: Id<"boards">;
    userId: Id<"users">;
    kind: TaskKind;
    scope: Scope;
    targetId?: Id<"entities">;
    request?: unknown;
    changeId?: Id<"changes">;
  },
) {
  taskKindSchema.parse(args.kind);
  const change = args.changeId ? await ctx.db.get(args.changeId) : null;
  if (
    args.changeId &&
    (!change ||
      change.boardId !== args.boardId ||
      change.status !== "regenerating")
  )
    throw new ConvexError("Revision is not ready to regenerate.");
  await validateScope(ctx, args.boardId, args.scope);
  const all = await ctx.db
    .query("entities")
    .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
    .collect();
  const choices = await ctx.db
    .query("choices")
    .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
    .collect();
  const relevant = relevantEntities(
    all,
    args.scope,
    args.targetId,
    choices,
    args.kind,
  );
  if (
    ["schedule", "packet"].includes(args.kind) &&
    (args.scope.kind !== "plan" || args.scope.planId !== args.targetId)
  )
    throw new ConvexError("Choose this plan as the task scope.");
  const target = args.targetId
    ? relevant.find((e) => e._id === args.targetId)
    : undefined;
  if (args.targetId && !target)
    throw new ConvexError("Task target is not on this board.");
  const expectedKind: Partial<Record<TaskKind, string>> = {
    scenes: "script",
    research: "scene",
    requirements: "location",
    schedule: "plan",
    packet: "plan",
  };
  if (expectedKind[args.kind] && target?.kind !== expectedKind[args.kind])
    throw new ConvexError("Choose the correct card for this task.");
  const blocking = blockingQuestions(relevant, args.kind);
  if (blocking.length)
    throw new ConvexError(
      `Answer first: ${blocking
        .slice(0, 3)
        .map((e) => e.data.prompt)
        .join(" ")}`,
    );
  if (args.kind === "scenes" && all.some((e) => e.kind === "scene"))
    throw new ConvexError(
      "Scenes already exist. Edit or regenerate their connected outputs.",
    );
  if (args.kind === "ingest" && all.some((e) => e.kind === "script"))
    throw new ConvexError(
      "This workspace already has a screenplay. Create another workspace for a new script.",
    );
  if (args.kind === "research" && target) entitySchema.parse(target.data);
  if (
    args.kind === "packet" &&
    relevant.some(
      (e) =>
        e.stale &&
        ["location", "cost", "requirement", "schedule"].includes(e.kind),
    )
  )
    throw new ConvexError(
      "Refresh affected results before building a current packet.",
    );
  if ((args.kind === "schedule" || args.kind === "packet") && target) {
    const ready = planReadiness(target, all, choices);
    const blockers = [...ready.blockers];
    if (args.kind === "packet" && !ready.currentSchedule)
      blockers.push(
        "Generate and apply a current schedule for the included scenes.",
      );
    if (blockers.length) throw new ConvexError(blockers.join(" "));
  }
  const inputVersions = inputFingerprint(relevant, args.kind);
  const workKey = JSON.stringify([
    args.boardId,
    args.kind,
    args.scope,
    args.targetId,
    inputVersions,
    args.changeId,
    args.request,
  ]).slice(0, 30000);
  const matching = await ctx.db
    .query("runs")
    .withIndex("by_work_key", (q) => q.eq("workKey", workKey))
    .collect();
  const existing = matching.find((r) =>
    ["queued", "running", "waiting"].includes(r.status),
  );
  if (existing) return existing._id;
  const active = await ctx.db
    .query("runs")
    .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
    .order("desc")
    .take(100);
  if (
    active.filter((r) => ["queued", "running"].includes(r.status)).length >= 8
  )
    throw new ConvexError(
      "Eight tasks are already active. Wait for one to finish.",
    );
  if (active.filter((r) => r.createdAt > Date.now() - 3600000).length >= 60)
    throw new ConvexError(
      "This board reached its hourly agent limit. Try again later.",
    );
  const now = Date.now();
  const runId = await ctx.db.insert("runs", {
    boardId: args.boardId,
    kind: args.kind,
    scope: args.scope,
    targetId: args.targetId,
    status: "queued",
    activity: "Queued",
    createdBy: args.userId,
    createdAt: now,
    updatedAt: now,
    inputVersions,
    workKey,
    attempt: 1,
    eventSequence: 0,
    request: args.request,
    changeId: args.changeId,
  });
  if (change) {
    const previous = await Promise.all(
      change.runIds.map((id) => ctx.db.get(id)),
    );
    const retained = previous.filter(
      (run) =>
        run &&
        !(
          run.kind === args.kind &&
          run.targetId === args.targetId &&
          JSON.stringify(run.scope) === JSON.stringify(args.scope)
        ),
    );
    await ctx.db.patch(change._id, {
      runIds: [...retained.map((run) => run!._id), runId],
    });
  }
  await ctx.db.insert("outbox", {
    runId,
    attempt: 1,
    status: "pending",
    tries: 0,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.dispatch.send, { runId });
  return runId;
}
export async function inputsCurrent(ctx: MutationCtx, run: Doc<"runs">) {
  const all = await ctx.db
    .query("entities")
    .withIndex("by_board", (q) => q.eq("boardId", run.boardId))
    .collect();
  const choices = await ctx.db
    .query("choices")
    .withIndex("by_board", (q) => q.eq("boardId", run.boardId))
    .collect();
  const kind = taskKindSchema.parse(run.kind);
  const current = inputFingerprint(
    relevantEntities(all, run.scope, run.targetId, choices, kind),
    kind,
  );
  return JSON.stringify(current) === JSON.stringify(run.inputVersions);
}
