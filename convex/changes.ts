import {
  mutation,
  query,
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import { v, ConvexError } from "convex/values";
import type { Id, Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireMember, boardEntity, assertRevision } from "./lib/auth";
import { connect, putEntity, updateEntity } from "./lib/entities";
import { entitySchema, taskKindSchema } from "../src/domain/model";
import {
  enqueue,
  relevantEntities,
  blockingQuestions,
  inputsCurrent,
} from "./lib/jobs";
import { publishResult, resultSchema } from "./lib/results";
import { effectivePlanSceneIds, scopedPlan } from "../src/domain/scope";
import {
  validatePlanScenes,
  syncPlanDependencies,
  revisionImpact,
  sceneInputKind,
} from "./lib/planScope";
export const list = query({
  args: { boardId: v.id("boards") },
  handler: async (ctx, { boardId }) => {
    await requireMember(ctx, boardId);
    const changes = await ctx.db
      .query("changes")
      .withIndex("by_board", (q) => q.eq("boardId", boardId))
      .order("desc")
      .take(30);
    return await Promise.all(
      changes.map(async (change) => {
        const runs = await Promise.all(
          change.runIds.map((id) => ctx.db.get(id)),
        );
        const stagedSchedules = runs.flatMap((run) => {
          if (run?.status !== "complete" || run.kind !== "schedule") return [];
          const parsed = resultSchema.safeParse(run.output);
          return parsed.success && parsed.data.schedule?.kind === "schedule"
            ? [parsed.data.schedule]
            : [];
        });
        return {
          ...change,
          stagedSchedules,
          beforeSchedules: (change.appliedVersions ?? []).flatMap((v) =>
            v.before.kind === "schedule" ? [v.before] : [],
          ),
        };
      }),
    );
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
    if (data.kind === "plan") await validatePlanScenes(ctx, args.boardId, data);
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
    const all = await ctx.db
      .query("entities")
      .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
      .collect();
    const affected = revisionImpact(target, data, all, deps).affected.map(
      (entity) => entity._id,
    );
    const records = await Promise.all(
      [target._id, ...affected].map((id) => ctx.db.get(id)),
    );
    const choices = await ctx.db
      .query("choices")
      .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
      .collect();
    const plan =
      target.kind === "plan"
        ? target
        : all.find((e) => e._id === target.scope.planId);
    const saved = plan
      ? scopedPlan(plan, all, choices)
      : { entities: all, choices };
    const preservedDecisions = {
      choices: saved.choices.map(
        ({ planId, sceneId, locationId, locked, revision }) => ({
          planId,
          sceneId,
          locationId,
          locked,
          revision,
        }),
      ),
      answers: saved.entities
        .filter(
          (e) =>
            e.kind === "question" &&
            e.data.resolution === "answered" &&
            e._id !== target._id,
        )
        .map((e) => ({
          id: e._id,
          revision: e.revision,
          answer: e.data.answer as string | null,
        })),
    };
    return await ctx.db.insert("changes", {
      boardId: args.boardId,
      targetId: target._id,
      baseRevision: target.revision,
      before: target.data,
      preservedDecisions,
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
    const boardBefore = await ctx.db
      .query("entities")
      .withIndex("by_board", (q) => q.eq("boardId", change.boardId))
      .collect();
    const data = entitySchema.parse(change.proposed);
    const impact = revisionImpact(target, data, boardBefore, dependencies);
    const localInput = sceneInputKind(target, data, boardBefore);
    const questionOwnerId =
      target.scope.kind === "plan_scene"
        ? boardBefore.find(
            (entity) =>
              entity._id === target.scope.planId &&
              entity.kind === "plan" &&
              effectivePlanSceneIds(entity.data, boardBefore).includes(
                target.scope.sceneId!,
              ),
          )?._id
        : target.ownerId;
    const ids = impact.affected.map((entity) => entity._id);
    const before = await Promise.all(
      [target._id, ...ids].map((id) => ctx.db.get(id)),
    );
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
    const boardBeforeIds = new Set(boardBefore.map((entity) => entity._id));
    const reversibleBefore = [
      ...before.filter((entity) => entity !== null),
      ...(target.kind === "question" &&
      questionOwnerId &&
      !before.some((e) => e?._id === questionOwnerId)
        ? boardBefore.filter((e) => e._id === questionOwnerId)
        : []),
      ...(answerBefore &&
      !before.some((entity) => entity?._id === answerBefore._id)
        ? [answerBefore]
        : []),
    ];
    if (data.kind === "plan")
      await validatePlanScenes(ctx, change.boardId, data);
    await updateEntity(
      ctx,
      target,
      data,
      user._id,
      changeId,
      (["scene", "plan"].includes(target.kind) && target.stale) ||
        impact.researchSceneId === target._id ||
        (target.kind === "question" &&
          target.scope.kind === "plan_scene" &&
          (target.stale || (!!localInput && !localInput.timingOnly))),
    );
    if (data.kind === "plan")
      await syncPlanDependencies(ctx, (await ctx.db.get(target._id))!);
    for (const id of ids) {
      const e = await ctx.db.get(id);
      if (
        e &&
        !(
          impact.preserveResearch &&
          ["location", "cost", "requirement"].includes(e.kind)
        ) &&
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
      const owner = boardBefore.find(
        (entity) => entity._id === questionOwnerId,
      );
      if (owner)
        await updateEntity(
          ctx,
          owner,
          entitySchema.parse(owner.data),
          user._id,
          changeId,
          owner.stale ||
            impact.researchSceneId === owner._id ||
            impact.researchPlanId === owner._id,
        );
      const questionNode = await ctx.db
        .query("nodes")
        .withIndex("by_entity", (q) => q.eq("entityId", target._id))
        .unique();
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
        x: questionNode?.x,
        y: questionNode ? questionNode.y + questionNode.height + 60 : undefined,
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
      appliedVersions: reversibleBefore
        .filter((entity) =>
          after.some(
            (current) =>
              current?._id === entity._id &&
              current.revision !== entity.revision,
          ),
        )
        .map((entity) => ({
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
    // Ensure freshly answered/created shared facts have direct plan dependencies.
    for (const plan of boardAfter.filter((e) => e.kind === "plan"))
      await syncPlanDependencies(ctx, plan);
    const savedChoices = await ctx.db
      .query("choices")
      .withIndex("by_board", (q) => q.eq("boardId", change.boardId))
      .collect();
    const waiting = await ctx.db
      .query("runs")
      .withIndex("by_board", (q) => q.eq("boardId", change.boardId))
      .collect();
    for (const run of waiting) {
      const kind = taskKindSchema.parse(run.kind);
      const inputs = relevantEntities(
        boardAfter,
        run.scope,
        run.targetId,
        savedChoices,
        kind,
      );
      const relatedCheckpoint =
        run.status === "waiting" &&
        target.kind === "question" &&
        target.data.blocks.includes(run.kind) &&
        inputs.some((e) => e._id === target._id);
      if (relatedCheckpoint && run.changeId) {
        const origin = await ctx.db.get(run.changeId);
        if (origin?.status === "regenerating") {
          // Accept only revision increments made by this answer transaction.
          // A prior collaborator edit must still fail the later apply check.
          await ctx.db.patch(origin._id, {
            readVersions: origin.readVersions.map((version) => {
              const old = boardBefore.find(
                (entity) => entity._id === version.id,
              );
              const current = boardAfter.find(
                (entity) => entity._id === version.id,
              );
              return old?.revision === version.revision && current
                ? { id: version.id, revision: current.revision }
                : version;
            }),
          });
        }
      }
      if (relatedCheckpoint && blockingQuestions(inputs, kind).length === 0) {
        try {
          const next = await enqueue(ctx, {
            boardId: run.boardId,
            userId: user._id,
            kind,
            scope: run.scope,
            targetId: run.targetId,
            request: run.request,
            changeId: run.changeId,
          });
          if (next !== run._id)
            await ctx.db.patch(run._id, {
              status: "superseded",
              activity: "Resumed with your answers",
              updatedAt: Date.now(),
            });
        } catch {
          /* Keep the original checkpoint retryable if dispatch cannot be queued. */
        }
      }
    }
    if (
      !impact.researchSceneId &&
      !impact.researchPlanId &&
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
type RevisionJob = NonNullable<Doc<"changes">["pendingJobs"]>[number];

function revisionJobs(
  change: Doc<"changes">,
  all: Doc<"entities">[],
  userId: Id<"users">,
): RevisionJob[] {
  const target = all.find((entity) => entity._id === change.targetId);
  if (!target) return [];
  const affected = all.filter((entity) =>
    change.affectedIds.includes(entity._id),
  );
  const original = change.before ? { ...target, data: change.before } : target;
  const local = sceneInputKind(
    original,
    entitySchema.parse(change.proposed ?? target.data),
    all,
  );
  if (local && !local.timingOnly)
    return [
      {
        kind: "research",
        targetId: local.sceneId,
        scope: local.planId
          ? { kind: "plan_scene", sceneId: local.sceneId, planId: local.planId }
          : { kind: "scene", sceneId: local.sceneId },
        userId,
      },
    ];
  const locationOwner =
    target.kind === "question"
      ? all.find(
          (entity) =>
            entity._id === target.ownerId && entity.kind === "location",
        )
      : undefined;
  if (locationOwner)
    return [
      {
        kind: "requirements",
        targetId: locationOwner._id,
        scope: locationOwner.scope,
        userId,
      },
    ];
  if (
    !local &&
    target.scope.kind === "workspace" &&
    affected.some((entity) =>
      ["scene", "location", "requirement"].includes(entity.kind),
    )
  ) {
    const plans = all.filter(
      (entity) =>
        entity.kind === "plan" &&
        (change.affectedIds.includes(entity._id) ||
          affected.some(
            (output) =>
              ["schedule", "packet"].includes(output.kind) &&
              output.data.planId === entity._id,
          )),
    );
    const sceneIds = new Set(
      plans.flatMap((plan) => effectivePlanSceneIds(plan.data, all)),
    );
    return all
      .filter((entity) => entity.kind === "scene" && sceneIds.has(entity._id))
      .map((scene) => ({
        kind: "research",
        targetId: scene._id,
        scope: scene.scope,
        userId,
      }));
  }
  return affected
    .filter((entity) => entity.kind === "schedule")
    .map((schedule) => ({
      kind: "schedule",
      targetId: schedule.data.planId as Id<"entities">,
      scope: schedule.scope,
      userId,
    }));
}

/** Saved pending work only drains while slots are available; failed work remains retryable. */
async function drainRegeneration(
  ctx: MutationCtx,
  changeId: Id<"changes">,
): Promise<Id<"runs">[]> {
  const change = await ctx.db.get(changeId);
  if (!change || change.status !== "regenerating") return [];
  const boardRuns = await ctx.db
    .query("runs")
    .withIndex("by_board", (q) => q.eq("boardId", change.boardId))
    .order("desc")
    .take(100);
  const active = boardRuns.filter((run) =>
    ["queued", "running"].includes(run.status),
  );
  let available = Math.max(0, 8 - active.length);
  const pending: RevisionJob[] = [];
  const errors: string[] = [];
  let capacityLimited = false;
  for (const job of change.pendingJobs ?? []) {
    if (!available) {
      pending.push(job);
      capacityLimited = true;
      continue;
    }
    const member = await ctx.db
      .query("members")
      .withIndex("by_board_user", (q) =>
        q.eq("boardId", change.boardId).eq("userId", job.userId),
      )
      .unique();
    if (!member || member.role === "viewer") {
      pending.push(job);
      errors.push(
        "The editor who queued this revision no longer has editing access. An editor can retry it.",
      );
      continue;
    }
    try {
      await enqueue(ctx, { ...job, boardId: change.boardId, changeId });
      available--;
    } catch (error) {
      pending.push(job);
      errors.push(
        error instanceof Error
          ? error.message
          : "An update could not be queued. Retry the retained work.",
      );
    }
  }
  const saved = (await ctx.db.get(changeId))!;
  const runs = await Promise.all(saved.runIds.map((id) => ctx.db.get(id)));
  const failed = runs.filter(
    (run) => !run || ["failed", "cancelled", "superseded"].includes(run.status),
  );
  if (failed.length)
    errors.push(
      `${failed.length} update task${failed.length === 1 ? "" : "s"} interrupted. Retry retains the other staged results.`,
    );
  const complete =
    !pending.length &&
    (saved.pendingJobs !== undefined || runs.length > 0) &&
    runs.every((run) => run?.status === "complete");
  const continuationAt =
    capacityLimited && !saved.regenerationContinuationAt
      ? Date.now() + 15000
      : saved.regenerationContinuationAt;
  await ctx.db.patch(changeId, {
    pendingJobs: pending,
    regenerationError:
      [...new Set(errors)].join(" ").slice(0, 4000) || undefined,
    status: complete ? "ready" : "regenerating",
    regenerationContinuationAt:
      complete || !capacityLimited ? undefined : continuationAt,
  });
  // Complete/waiting callbacks also call advance. This fallback covers slots held by unrelated jobs.
  // Once all running work stops or remaining jobs need user input, no further wakeup is scheduled.
  if (
    capacityLimited &&
    !saved.regenerationContinuationAt &&
    (active.length > 0 || available < 8)
  )
    await ctx.scheduler.runAfter(15000, internal.changes.advance, {
      changeId,
      continuationAt,
    });
  return saved.runIds;
}

export const regenerate = mutation({
  args: { changeId: v.id("changes") },
  handler: async (ctx, { changeId }): Promise<Id<"runs">[]> => {
    const change = await ctx.db.get(changeId);
    if (!change || change.status !== "regenerating")
      throw new ConvexError("Confirm this change first.");
    const { user } = await requireMember(ctx, change.boardId, "editor");
    const all = await ctx.db
      .query("entities")
      .withIndex("by_board", (q) => q.eq("boardId", change.boardId))
      .collect();
    const jobs = revisionJobs(change, all, user._id);
    const previous = await Promise.all(
      change.runIds.map((id) => ctx.db.get(id)),
    );
    const pending: RevisionJob[] = [];
    for (const job of jobs) {
      const matching = previous.find(
        (run) =>
          run?.kind === job.kind &&
          run.targetId === job.targetId &&
          JSON.stringify(run.scope) === JSON.stringify(job.scope),
      );
      if (
        matching &&
        ["queued", "running", "waiting", "complete"].includes(
          matching.status,
        ) &&
        (await inputsCurrent(ctx, matching))
      )
        continue;
      pending.push(job);
    }
    await ctx.db.patch(changeId, {
      pendingJobs: pending,
      regenerationError: undefined,
    });
    return await drainRegeneration(ctx, changeId);
  },
});
export const advance = internalMutation({
  args: { changeId: v.id("changes"), continuationAt: v.optional(v.number()) },
  handler: async (ctx, { changeId, continuationAt }): Promise<null> => {
    const change = await ctx.db.get(changeId);
    if (!change || change.status !== "regenerating") return null;
    if (continuationAt !== undefined) {
      if (change.regenerationContinuationAt !== continuationAt) return null;
      await ctx.db.patch(changeId, { regenerationContinuationAt: undefined });
    }
    await drainRegeneration(ctx, changeId);
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
    const validated: {
      run: Doc<"runs">;
      result: ReturnType<typeof resultSchema.parse>;
    }[] = [];
    for (const id of c.runIds) {
      const run = await ctx.db.get(id);
      if (!run || run.status !== "complete")
        throw new ConvexError("A dependent task is not complete.");
      if (!(await inputsCurrent(ctx, run)))
        throw new ConvexError(
          "Inputs changed while this revision was generated. Review and regenerate again.",
        );
      const result = resultSchema.parse(run.output);
      if (result.lockConflicts.length)
        throw new ConvexError(
          `Review locked choices before applying: ${result.lockConflicts.join(", ")}`,
        );
      validated.push({ run, result });
    }
    // Validate the full batch before any publication changes shared evidence revisions.
    for (const { run, result } of validated)
      await publishResult(ctx, run, result);
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
    const restoredPlans = await ctx.db
      .query("entities")
      .withIndex("by_board", (q) => q.eq("boardId", c.boardId))
      .collect();
    for (const plan of restoredPlans.filter((e) => e.kind === "plan"))
      await syncPlanDependencies(ctx, plan);
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
    await ctx.db.patch(changeId, {
      status: "undone",
      pendingJobs: [],
      regenerationError: undefined,
      regenerationContinuationAt: undefined,
    });
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
