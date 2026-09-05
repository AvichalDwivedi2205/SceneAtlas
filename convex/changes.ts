import { mutation, query, internalMutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireMember, boardEntity, assertRevision } from "./lib/auth";
import { connect, putEntity, updateEntity } from "./lib/entities";
import { affectedIds } from "../src/domain/planning";
import { entitySchema } from "../src/domain/model";
import { enqueue } from "./lib/jobs";
import { publishResult, resultSchema } from "./lib/results";
export const list = query({
  args: { boardId: v.id("boards") },
  handler: async (ctx, { boardId }) => {
    await requireMember(ctx, boardId);
    return await ctx.db
      .query("changes")
      .withIndex("by_board", (q) => q.eq("boardId", boardId))
      .order("desc")
      .take(30);
  },
});
export const history = query({
  args: { entityId: v.id("entities") },
  handler: async (ctx, { entityId }) => {
    const e = await ctx.db.get(entityId);
    if (!e) throw new ConvexError("Record not found.");
    await requireMember(ctx, e.boardId);
    return await ctx.db
      .query("versions")
      .withIndex("by_entity_revision", (q) => q.eq("entityId", entityId))
      .order("desc")
      .take(30);
  },
});
export const preview = mutation({
  args: {
    boardId: v.id("boards"),
    entityId: v.id("entities"),
    expectedRevision: v.number(),
    data: v.any(),
  },
  returns: v.id("changes"),
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.boardId, "editor");
    const target = await boardEntity(ctx, args.boardId, args.entityId);
    assertRevision(target.revision, args.expectedRevision);
    const data = entitySchema.parse(args.data);
    if (
      data.kind !== target.kind ||
      !["scene", "question", "plan", "note"].includes(data.kind)
    )
      throw new ConvexError(
        "Edit source inputs rather than generated evidence.",
      );
    if (data.kind === "question") {
      const old = entitySchema.parse(target.data);
      if (
        old.kind !== "question" ||
        data.key !== old.key ||
        data.prompt !== old.prompt ||
        JSON.stringify(data.blocks) !== JSON.stringify(old.blocks)
      )
        throw new ConvexError("Only the answer can be changed.");
      if (!data.answer?.trim())
        throw new ConvexError("Enter an answer or choose Not sure.");
      // Initial answers are recorded verbatim. Agent interpretations require a separate reviewed proposal.
      data.rule = null;
    }
    const deps = await ctx.db
      .query("dependencies")
      .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
      .collect();
    const affected = affectedIds(target._id, deps)
      .map((id) => ctx.db.normalizeId("entities", id))
      .filter((id): id is Id<"entities"> => id !== null);
    const records = await Promise.all(
      [target._id, ...affected].map((id) => ctx.db.get(id)),
    );
    return await ctx.db.insert("changes", {
      boardId: args.boardId,
      targetId: target._id,
      baseRevision: target.revision,
      before: target.data,
      proposed: data,
      affectedIds: affected,
      readVersions: records
        .filter((r) => r !== null)
        .map((r) => ({ id: r._id, revision: r.revision })),
      status: "preview",
      createdBy: user._id,
      createdAt: Date.now(),
      summary:
        data.kind === "question"
          ? `Answer: ${data.prompt}`
          : `Update ${data.kind}`,
      runIds: [],
    });
  },
});
export const commitInputs = mutation({
  args: { changeId: v.id("changes") },
  returns: v.null(),
  handler: async (ctx, { changeId }) => {
    const change = await ctx.db.get(changeId);
    if (!change?.targetId || !change.proposed || change.status !== "preview")
      throw new ConvexError("This change is no longer pending.");
    const { user } = await requireMember(ctx, change.boardId, "editor");
    const target = await boardEntity(ctx, change.boardId, change.targetId);
    assertRevision(target.revision, change.baseRevision!);
    const dependencies = await ctx.db
      .query("dependencies")
      .withIndex("by_board", (q) => q.eq("boardId", change.boardId))
      .collect();
    const ids = affectedIds(target._id, dependencies)
      .map((id) => ctx.db.normalizeId("entities", id))
      .filter((id): id is Id<"entities"> => id !== null);
    const before = await Promise.all(
      [target._id, ...ids].map((id) => ctx.db.get(id)),
    );
    const data = entitySchema.parse(change.proposed);
    const answerBefore =
      data.kind === "question"
        ? await ctx.db
            .query("entities")
            .withIndex("by_board_key", (q) =>
              q
                .eq("boardId", change.boardId)
                .eq("logicalKey", `${target._id}:answer`),
            )
            .unique()
        : null;
    const boardBefore = await ctx.db
      .query("entities")
      .withIndex("by_board", (q) => q.eq("boardId", change.boardId))
      .collect();
    const boardBeforeIds = new Set(boardBefore.map((entity) => entity._id));
    const reversibleBefore = [
      ...before.filter((entity) => entity !== null),
      ...(answerBefore &&
      !before.some((entity) => entity?._id === answerBefore._id)
        ? [answerBefore]
        : []),
    ];
    await updateEntity(ctx, target, data, user._id, changeId);
    for (const id of ids) {
      const e = await ctx.db.get(id);
      if (
        e &&
        !["question", "answer", "note", "script", "scene", "plan"].includes(
          e.kind,
        )
      )
        await updateEntity(
          ctx,
          e,
          entitySchema.parse(e.data),
          user._id,
          changeId,
          true,
        );
    }
    if (data.kind === "question" && target.ownerId) {
      const owner = await ctx.db.get(target.ownerId);
      if (owner)
        await updateEntity(
          ctx,
          owner,
          entitySchema.parse(owner.data),
          user._id,
          changeId,
          owner.stale,
        );
      const answerId = await putEntity(ctx, {
        boardId: change.boardId,
        data: {
          kind: "answer",
          questionId: target._id,
          question: data.prompt,
          original: data.answer!,
          rule: data.rule,
          resolution: data.resolution === "unknown" ? "unknown" : "answered",
        },
        scope: target.scope,
        ownerId: target.ownerId,
        logicalKey: `${target._id}:answer`,
        actor: user._id,
      });
      await connect(ctx, change.boardId, target._id, answerId, "answer", false);
    }
    const after = await Promise.all(
      reversibleBefore.map((entity) => ctx.db.get(entity._id)),
    );
    const boardAfter = await ctx.db
      .query("entities")
      .withIndex("by_board", (q) => q.eq("boardId", change.boardId))
      .collect();
    await ctx.db.patch(changeId, {
      status: "regenerating",
      affectedIds: ids,
      readVersions: after
        .filter((e) => e !== null)
        .map((e) => ({ id: e._id, revision: e.revision })),
      appliedVersions: reversibleBefore.map((entity) => ({
        id: entity._id,
        revision: after.find((current) => current?._id === entity._id)!
          .revision,
        before: entity.data,
        stale: entity.stale,
      })),
      createdVersions: boardAfter
        .filter((entity) => !boardBeforeIds.has(entity._id))
        .map((entity) => ({ id: entity._id, revision: entity.revision })),
    });
    const waiting = await ctx.db
      .query("runs")
      .withIndex("by_board", (q) => q.eq("boardId", change.boardId))
      .collect();
    for (const run of waiting)
      if (
        run.status === "waiting" &&
        (run.scope.kind === "workspace" ||
          run.scope.sceneId === target.scope.sceneId ||
          run.scope.planId === target.scope.planId)
      ) {
        await ctx.db.patch(run._id, { status: "superseded" });
        try {
          await enqueue(ctx, {
            boardId: run.boardId,
            userId: user._id,
            kind: run.kind as "research",
            scope: run.scope,
            targetId: run.targetId,
            request: run.request,
            changeId: run.changeId,
          });
        } catch {
          /* Remaining questions keep dependent work paused. */
        }
      }
    if (
      !ids.some((id) =>
        before.find(
          (e) =>
            e?._id === id &&
            ["location", "schedule", "requirement"].includes(e.kind),
        ),
      )
    )
      await ctx.db.patch(changeId, { status: "applied" });
    return null;
  },
});
export const regenerate = mutation({
  args: { changeId: v.id("changes") },
  handler: async (ctx, { changeId }) => {
    const change = await ctx.db.get(changeId);
    if (!change || change.status !== "regenerating")
      throw new ConvexError("Confirm this change first.");
    const { user } = await requireMember(ctx, change.boardId, "editor");
    const target = change.targetId ? await ctx.db.get(change.targetId) : null;
    const affected = await Promise.all(
      change.affectedIds.map((id) => ctx.db.get(id)),
    );
    const sceneIds = new Set<Id<"entities">>();
    if (target?.scope.sceneId && affected.some((e) => e?.kind === "location"))
      sceneIds.add(target.scope.sceneId as Id<"entities">);
    for (const e of affected) if (e?.kind === "scene") sceneIds.add(e._id);
    if (target?.scope.kind === "workspace")
      for (const e of affected)
        if (e?.kind === "location")
          for (const sid of e.data.sceneIds) sceneIds.add(sid);
    const runIds: Id<"runs">[] = [];
    for (const sceneId of sceneIds)
      runIds.push(
        await enqueue(ctx, {
          boardId: change.boardId,
          userId: user._id,
          kind: "research",
          scope: { kind: "scene", sceneId },
          targetId: sceneId,
          changeId,
        }),
      );
    if (!runIds.length) {
      for (const e of affected)
        if (e?.kind === "schedule")
          runIds.push(
            await enqueue(ctx, {
              boardId: change.boardId,
              userId: user._id,
              kind: "schedule",
              scope: e.scope,
              targetId: e.data.planId,
              changeId,
            }),
          );
    }
    await ctx.db.patch(changeId, {
      runIds,
      status: runIds.length ? "regenerating" : "ready",
    });
    return runIds;
  },
});
export const advance = internalMutation({
  args: { changeId: v.id("changes") },
  handler: async (ctx, { changeId }) => {
    const c = await ctx.db.get(changeId);
    if (!c || c.status !== "regenerating" || !c.runIds.length) return null;
    const runs = await Promise.all(c.runIds.map((id) => ctx.db.get(id)));
    if (runs.every((r) => r?.status === "complete"))
      await ctx.db.patch(changeId, { status: "ready" });
    return null;
  },
});
export const apply = mutation({
  args: { changeId: v.id("changes") },
  returns: v.null(),
  handler: async (ctx, { changeId }) => {
    const c = await ctx.db.get(changeId);
    if (!c || c.status !== "ready")
      throw new ConvexError("Wait for the revised results.");
    await requireMember(ctx, c.boardId, "editor");
    for (const v of c.readVersions) {
      const e = await ctx.db.get(v.id);
      if (!e) throw new ConvexError("A record was removed.");
      assertRevision(e.revision, v.revision);
    }
    const before = await ctx.db
      .query("entities")
      .withIndex("by_board", (q) => q.eq("boardId", c.boardId))
      .collect();
    const beforeIds = new Set(before.map((entity) => entity._id));
    const beforeAssets = await ctx.db
      .query("assets")
      .withIndex("by_board", (q) => q.eq("boardId", c.boardId))
      .collect();
    const beforeAssetIds = new Set(beforeAssets.map((asset) => asset._id));
    for (const id of c.runIds) {
      const run = await ctx.db.get(id);
      if (!run || run.status !== "complete")
        throw new ConvexError("A dependent task is not complete.");
      const result = resultSchema.parse(run.output);
      if (result.lockConflicts.length)
        throw new ConvexError(
          `Review locked choices before applying: ${result.lockConflicts.join(", ")}`,
        );
      await publishResult(ctx, run, result);
    }
    const previous = c.appliedVersions ?? [];
    const changed = [];
    for (const old of before) {
      const now = await ctx.db.get(old._id);
      if (
        now &&
        now.revision !== old.revision &&
        !previous.some((p) => p.id === old._id)
      )
        changed.push({
          id: old._id,
          revision: now.revision,
          before: old.data,
          stale: old.stale,
        });
    }
    const appliedVersions = await Promise.all(
      [...previous, ...changed].map(async (p) => ({
        ...p,
        revision: (await ctx.db.get(p.id))!.revision,
      })),
    );
    const afterEntities = await ctx.db
      .query("entities")
      .withIndex("by_board", (q) => q.eq("boardId", c.boardId))
      .collect();
    const createdById = new Map(
      (c.createdVersions ?? []).map((item) => [item.id, item]),
    );
    for (const entity of afterEntities)
      if (!beforeIds.has(entity._id))
        createdById.set(entity._id, {
          id: entity._id,
          revision: entity.revision,
        });
    const afterAssets = await ctx.db
      .query("assets")
      .withIndex("by_board", (q) => q.eq("boardId", c.boardId))
      .collect();
    const createdAssets = [
      ...(c.createdAssets ?? []),
      ...afterAssets
        .filter((asset) => !beforeAssetIds.has(asset._id))
        .map((asset) => ({ assetId: asset._id, storageId: asset.storageId })),
    ];
    await ctx.db.patch(changeId, {
      status: "applied",
      appliedVersions,
      createdVersions: [...createdById.values()],
      createdAssets,
    });
    return null;
  },
});
export const undo = mutation({
  args: { changeId: v.id("changes") },
  returns: v.null(),
  handler: async (ctx, { changeId }) => {
    const c = await ctx.db.get(changeId);
    if (
      !c ||
      !["applied", "regenerating", "ready"].includes(c.status) ||
      !c.appliedVersions
    )
      throw new ConvexError("This change cannot be undone.");
    const { user } = await requireMember(ctx, c.boardId, "editor");
    for (const saved of c.appliedVersions) {
      const current = await boardEntity(ctx, c.boardId, saved.id);
      assertRevision(current.revision, saved.revision);
    }
    for (const created of c.createdVersions ?? []) {
      const current = await boardEntity(ctx, c.boardId, created.id);
      assertRevision(current.revision, created.revision);
    }
    const choices = await ctx.db
      .query("choices")
      .withIndex("by_board", (q) => q.eq("boardId", c.boardId))
      .collect();
    const createdIds = new Set(
      (c.createdVersions ?? []).map((item) => item.id),
    );
    if (
      choices.some(
        (choice) =>
          createdIds.has(choice.locationId) ||
          createdIds.has(choice.sceneId) ||
          createdIds.has(choice.planId),
      )
    )
      throw new ConvexError(
        "A later location choice uses this revision. Review that choice before undoing.",
      );
    for (const saved of c.appliedVersions) {
      const current = await boardEntity(ctx, c.boardId, saved.id);
      await updateEntity(
        ctx,
        current,
        entitySchema.parse(saved.before),
        user._id,
        changeId,
        saved.stale,
      );
    }
    const edges = await ctx.db
      .query("edges")
      .withIndex("by_board", (q) => q.eq("boardId", c.boardId))
      .collect();
    const dependencies = await ctx.db
      .query("dependencies")
      .withIndex("by_board", (q) => q.eq("boardId", c.boardId))
      .collect();
    for (const edge of edges)
      if (createdIds.has(edge.sourceId) || createdIds.has(edge.targetId))
        await ctx.db.delete(edge._id);
    for (const dependency of dependencies)
      if (
        createdIds.has(dependency.sourceId) ||
        createdIds.has(dependency.targetId)
      )
        await ctx.db.delete(dependency._id);
    for (const created of c.createdVersions ?? []) {
      const node = await ctx.db
        .query("nodes")
        .withIndex("by_entity", (q) => q.eq("entityId", created.id))
        .unique();
      if (node) await ctx.db.delete(node._id);
      const versions = await ctx.db
        .query("versions")
        .withIndex("by_entity_revision", (q) => q.eq("entityId", created.id))
        .collect();
      for (const version of versions) await ctx.db.delete(version._id);
      await ctx.db.delete(created.id);
    }
    for (const artifact of c.createdAssets ?? []) {
      const asset = await ctx.db.get(artifact.assetId);
      if (asset?.boardId === c.boardId) {
        await ctx.storage.delete(artifact.storageId);
        await ctx.db.delete(artifact.assetId);
      }
    }
    for (const runId of c.runIds) {
      const run = await ctx.db.get(runId);
      if (run && ["queued", "running", "waiting"].includes(run.status))
        await ctx.db.patch(runId, {
          status: "cancelled",
          activity: "Revision undone",
        });
    }
    await ctx.db.patch(changeId, { status: "undone" });
    return null;
  },
});
export const discard = mutation({
  args: { changeId: v.id("changes") },
  returns: v.null(),
  handler: async (ctx, { changeId }) => {
    const c = await ctx.db.get(changeId);
    if (!c || c.status !== "preview")
      throw new ConvexError("Only unapplied proposals can be discarded.");
    await requireMember(ctx, c.boardId, "editor");
    await ctx.db.patch(changeId, { status: "discarded" });
    return null;
  },
});
export const messages = query({
  args: { boardId: v.id("boards") },
  handler: async (ctx, { boardId }) => {
    await requireMember(ctx, boardId);
    return await ctx.db
      .query("messages")
      .withIndex("by_board", (q) => q.eq("boardId", boardId))
      .order("desc")
      .take(100);
  },
});
