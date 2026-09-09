import { ConvexError, v } from "convex/values";
import { mutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertRevision, boardEntity, requireMember } from "./lib/auth";
import {
  connect,
  putEntity,
  updateEntity,
  validateScope,
} from "./lib/entities";
import {
  blockingQuestions,
  enqueue,
  inputFingerprint,
  relevantEntities,
} from "./lib/jobs";
import { syncPlanDependencies, validatePlanScenes } from "./lib/planScope";
import { entitySchema, type EntityData } from "../src/domain/model";
import { effectivePlanSceneIds } from "../src/domain/scope";

/** Only an explicit producer selection creates branches; import creates none. */
export const createPlans = mutation({
  args: {
    boardId: v.id("boards"),
    plans: v.array(
      v.object({
        key: v.string(),
        name: v.string(),
        budgetMode: v.union(v.literal("fixed"), v.literal("uncapped")),
        budgetMinor: v.union(v.number(), v.null()),
        sceneScope: v.optional(
          v.object({
            mode: v.union(v.literal("all"), v.literal("selected")),
            sceneIds: v.array(v.string()),
          }),
        ),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.boardId, "editor");
    if (
      !args.plans.length ||
      args.plans.length > 8 ||
      new Set(args.plans.map((p) => p.key)).size !== args.plans.length
    )
      throw new ConvexError("Add one to eight distinct plans at a time.");
    const all = await ctx.db
      .query("entities")
      .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
      .collect();
    const script = all.find(
      (e) => e.kind === "script" && e.logicalKey === "script",
    );
    if (!script)
      throw new ConvexError("Upload a screenplay before choosing plans.");
    const existingPlans = all.filter((e) => e.kind === "plan");
    // Later branches inherit production inputs, never location choices or outputs.
    const template = existingPlans[0]?.data;
    const prepared = args.plans.map((input) => {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.key))
        throw new ConvexError("Invalid plan request key.");
      if (
        input.budgetMode === "fixed" &&
        (!Number.isSafeInteger(input.budgetMinor) || input.budgetMinor! <= 0)
      )
        throw new ConvexError(
          "Enter a positive cap for each fixed-budget plan.",
        );
      const data = entitySchema.parse({
        ...template,
        kind: "plan",
        name: input.name.trim(),
        budgetMode: input.budgetMode,
        budgetMinor: input.budgetMinor,
        currency: "USD",
        priority: input.budgetMode === "fixed" ? "cost" : "creative",
        ...(input.sceneScope ? { sceneScope: input.sceneScope } : {}),
      });
      if (data.kind !== "plan") throw new ConvexError("Choose plan records.");
      const logicalKey = `plan:user:${input.key}`;
      const existing = all.find((e) => e.logicalKey === logicalKey);
      if (
        existing &&
        (existing.kind !== "plan" ||
          existing.data.name !== data.name ||
          existing.data.budgetMode !== input.budgetMode ||
          existing.data.budgetMinor !== input.budgetMinor ||
          (input.sceneScope &&
            JSON.stringify(existing.data.sceneScope) !==
              JSON.stringify(data.sceneScope)))
      )
        throw new ConvexError(
          "This plan request was already saved with different settings. Reopen plan selection.",
        );
      return { data, logicalKey, existing };
    });
    for (const item of prepared) {
      if (item.data.kind !== "plan")
        throw new ConvexError("Choose plan records.");
      await validatePlanScenes(ctx, args.boardId, item.data);
      if (
        item.data.sceneScope?.mode === "selected" &&
        !item.data.sceneScope.sceneIds.length
      )
        throw new ConvexError(
          "Choose at least one scene before creating a plan.",
        );
    }
    const ids: Id<"entities">[] = [];
    for (const [index, item] of prepared.entries()) {
      if (item.existing) {
        ids.push(item.existing._id);
        continue;
      }
      const id = await putEntity(ctx, {
        boardId: args.boardId,
        actor: user._id,
        data: item.data,
        logicalKey: item.logicalKey,
        ownerId: script._id,
        scope: { kind: "workspace" },
        x: (existingPlans.length + index) * 440,
        y: 650,
      });
      await ctx.db.patch(id, { scope: { kind: "plan", planId: id } });
      await connect(ctx, args.boardId, script._id, id, "production-input");
      await syncPlanDependencies(ctx, (await ctx.db.get(id))!);
      ids.push(id);
    }
    await ctx.db.patch(args.boardId, { updatedAt: Date.now() });
    return ids;
  },
});

async function selectedPlans(
  ctx: MutationCtx,
  boardId: Id<"boards">,
  ids: Id<"entities">[],
) {
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new ConvexError("Choose at least one plan without duplicates.");
  const plans = await Promise.all(
    ids.map((id) => boardEntity(ctx, boardId, id)),
  );
  return plans.map((plan) => {
    const data = entitySchema.parse(plan.data);
    if (data.kind !== "plan") throw new ConvexError("Choose plan records.");
    return { ...plan, data };
  });
}

/** Draft setup is atomic. Once research starts, producer edits use reviewed changes. */
export const configure = mutation({
  args: {
    boardId: v.id("boards"),
    plans: v.array(
      v.object({
        planId: v.id("entities"),
        expectedRevision: v.number(),
        budgetMinor: v.optional(v.number()),
      }),
    ),
    budgetMinor: v.optional(v.number()),
    idealShoot: v.string(),
    dates: v.array(v.string()),
    timezone: v.string(),
    dayStart: v.number(),
    dayEnd: v.number(),
    moveMinutes: v.union(v.number(), v.null()),
    setupMinutes: v.union(v.number(), v.null()),
    timingBasis: v.union(
      v.literal("confirmed"),
      v.literal("estimate"),
      v.literal("unknown"),
    ),
    sceneIds: v.optional(v.array(v.id("entities"))),
    durationMinutes: v.optional(v.number()),
    applyTimeWindows: v.optional(v.boolean()),
    answers: v.optional(
      v.array(
        v.object({
          entityId: v.id("entities"),
          expectedRevision: v.number(),
          answer: v.string(),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.boardId, "editor");
    const plans = await selectedPlans(
      ctx,
      args.boardId,
      args.plans.map((p) => p.planId),
    );
    for (const plan of plans)
      assertRevision(
        plan.revision,
        args.plans.find((p) => p.planId === plan._id)!.expectedRevision,
      );
    const [all, runs, choices] = await Promise.all([
      ctx.db
        .query("entities")
        .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
        .collect(),
      ctx.db
        .query("runs")
        .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
        .collect(),
      ctx.db
        .query("choices")
        .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
        .collect(),
    ]);
    if (
      runs.some((r) =>
        ["research", "requirements", "schedule", "packet"].includes(r.kind),
      ) ||
      all.some((e) =>
        ["location", "cost", "requirement", "schedule", "packet"].includes(
          e.kind,
        ),
      ) ||
      choices.length
    )
      throw new ConvexError(
        "Initial setup is complete. Review further production changes through the existing revision flow.",
      );
    if (
      runs.some(
        (r) =>
          ["ingest", "scenes"].includes(r.kind) &&
          ["queued", "running"].includes(r.status),
      )
    )
      throw new ConvexError(
        "Wait for screenplay processing to finish before saving setup.",
      );
    if (
      args.budgetMinor !== undefined &&
      (!Number.isSafeInteger(args.budgetMinor) || args.budgetMinor <= 0)
    )
      throw new ConvexError(
        "Enter a positive fixed budget in minor currency units.",
      );
    if (!args.idealShoot.trim())
      throw new ConvexError(
        "Describe the intended shoot for the selected plans.",
      );
    if (!args.dates.length || new Set(args.dates).size !== args.dates.length)
      throw new ConvexError(
        "Choose at least one shoot date without duplicates.",
      );
    try {
      new Intl.DateTimeFormat("en", { timeZone: args.timezone }).format(0);
    } catch {
      throw new ConvexError("Choose a valid shoot timezone.");
    }
    if (args.sceneIds && new Set(args.sceneIds).size !== args.sceneIds.length)
      throw new ConvexError("Choose each scene only once.");
    if (
      args.answers &&
      new Set(args.answers.map((a) => a.entityId)).size !== args.answers.length
    )
      throw new ConvexError("Answer each question only once.");

    // Collect and validate every write before updating any selected branch.
    const updates = new Map<
      Id<"entities">,
      { entity: Doc<"entities">; data: EntityData }
    >();
    const configured = plans.map((plan) => {
      const data = entitySchema.parse({
        ...plan.data,
        budgetMinor:
          plan.data.budgetMode === "fixed"
            ? (args.plans.find((p) => p.planId === plan._id)?.budgetMinor ??
              args.budgetMinor ??
              plan.data.budgetMinor)
            : null,
        idealShoot: args.idealShoot,
        dates: args.dates,
        timezone: args.timezone,
        dayStart: args.dayStart,
        dayEnd: args.dayEnd,
        moveMinutes: args.moveMinutes,
        setupMinutes: args.setupMinutes,
        timingBasis: args.timingBasis,
        ...(args.sceneIds === undefined
          ? {}
          : { sceneScope: { mode: "selected", sceneIds: args.sceneIds } }),
      });
      if (data.kind !== "plan") throw new ConvexError("Choose plan records.");
      if (
        data.budgetMode === "fixed" &&
        (!Number.isSafeInteger(data.budgetMinor) || data.budgetMinor! <= 0)
      )
        throw new ConvexError(
          "Enter a positive cap for each fixed-budget plan.",
        );
      updates.set(plan._id, { entity: plan, data });
      return { ...plan, data };
    });
    for (const plan of configured)
      await validatePlanScenes(ctx, args.boardId, plan.data);
    const selectedIds = effectivePlanSceneIds(configured[0].data, all);
    if (
      configured.some(
        (plan) =>
          JSON.stringify([...selectedIds].sort()) !==
          JSON.stringify(effectivePlanSceneIds(plan.data, all).sort()),
      )
    )
      throw new ConvexError(
        "The selected plans must include the same scenes. Choose their shared scene selection.",
      );
    if (
      (args.durationMinutes !== undefined || args.applyTimeWindows) &&
      !selectedIds.length
    )
      throw new ConvexError(
        "Choose scenes before applying scene duration or shooting windows.",
      );
    for (const scene of all.filter(
      (e) => e.kind === "scene" && selectedIds.includes(e._id),
    )) {
      if (args.durationMinutes === undefined && !args.applyTimeWindows)
        continue;
      const data = entitySchema.parse({
        ...scene.data,
        ...(args.durationMinutes === undefined
          ? {}
          : {
              durationMinutes: args.durationMinutes,
              durationBasis: args.timingBasis,
            }),
        ...(args.applyTimeWindows
          ? {
              windows: args.dates.map((date) => ({
                date,
                start: args.dayStart,
                end: args.dayEnd,
              })),
            }
          : {}),
      });
      updates.set(scene._id, { entity: scene, data });
    }
    const answers = [];
    const script = all.find(
      (e) => e.kind === "script" && e.logicalKey === "script",
    );
    if (!script)
      throw new ConvexError(
        "Import a screenplay before configuring its variants.",
      );
    const creativeBrief = all.find(
      (e) => e.logicalKey === "variant:creative-brief",
    );
    if (
      creativeBrief &&
      (creativeBrief.kind !== "question" ||
        creativeBrief.ownerId !== script._id ||
        creativeBrief.scope.kind !== "workspace")
    )
      throw new ConvexError(
        "The shared creative brief requires a reviewed production change.",
      );
    const creativeData = entitySchema.parse({
      kind: "question",
      key: "variant-creative-brief",
      prompt: "What creative priorities should the selected plans share?",
      reason:
        "Use the producer's creative brief when researching locations for the selected plans.",
      suggestions: [],
      blocks: ["research"],
      answer: args.idealShoot,
      resolution: "answered",
      rule: null,
    });
    if (creativeData.kind !== "question")
      throw new ConvexError("Invalid creative brief.");
    if (creativeBrief) {
      updates.set(creativeBrief._id, {
        entity: creativeBrief,
        data: creativeData,
      });
      answers.push({ question: creativeBrief, data: creativeData });
    }
    // Workspace answers are canonical research inputs; updating the owner also
    // preserves the same source version behavior as the reviewed answer flow.
    updates.set(script._id, {
      entity: script,
      data: entitySchema.parse(script.data),
    });
    for (const supplied of args.answers ?? []) {
      if (supplied.entityId === creativeBrief?._id)
        throw new ConvexError(
          "Set the shared creative brief through the intended-shoot field.",
        );
      const question = await boardEntity(ctx, args.boardId, supplied.entityId);
      assertRevision(question.revision, supplied.expectedRevision);
      if (question.kind !== "question")
        throw new ConvexError(
          "Only producer questions can be answered in setup.",
        );
      await validateScope(ctx, args.boardId, question.scope);
      if (
        question.scope.planId &&
        !plans.some((p) => p._id === question.scope.planId)
      )
        throw new ConvexError("This question belongs to another plan.");
      if (!supplied.answer.trim())
        throw new ConvexError("Enter an answer or choose Not sure.");
      const data = entitySchema.parse({
        ...question.data,
        answer: supplied.answer.trim(),
        rule: null,
        resolution:
          supplied.answer.trim().toLowerCase() === "not sure"
            ? "unknown"
            : "answered",
      });
      if (data.kind !== "question") throw new ConvexError("Invalid question.");
      updates.set(question._id, { entity: question, data });
      if (question.ownerId) {
        const owner = await boardEntity(ctx, args.boardId, question.ownerId);
        if (!["script", "scene", "plan"].includes(owner.kind))
          throw new ConvexError(
            "This question requires a reviewed production change.",
          );
        if (owner.kind === "plan" && !plans.some((p) => p._id === owner._id))
          throw new ConvexError("This question belongs to another plan.");
        if (!updates.has(owner._id))
          updates.set(owner._id, {
            entity: owner,
            data: entitySchema.parse(owner.data),
          });
      }
      answers.push({ question, data });
    }

    for (const { entity, data } of updates.values())
      await updateEntity(ctx, entity, data, user._id);
    if (!creativeBrief) {
      const questionId = await putEntity(ctx, {
        boardId: args.boardId,
        actor: user._id,
        logicalKey: "variant:creative-brief",
        data: creativeData,
        scope: { kind: "workspace" },
        ownerId: script._id,
      });
      await connect(ctx, args.boardId, questionId, script._id, "question");
      answers.push({
        question: (await ctx.db.get(questionId))!,
        data: creativeData,
      });
    }
    for (const { question, data } of answers) {
      const node = await ctx.db
        .query("nodes")
        .withIndex("by_entity", (q) => q.eq("entityId", question._id))
        .unique();
      const answerId = await putEntity(ctx, {
        boardId: args.boardId,
        actor: user._id,
        logicalKey: `${question._id}:answer`,
        scope: question.scope,
        ownerId: question.ownerId,
        data: {
          kind: "answer",
          questionId: question._id,
          question: data.prompt,
          original: data.answer!,
          rule: null,
          resolution: data.resolution === "unknown" ? "unknown" : "answered",
        },
        x: node?.x,
        y: node ? node.y + node.height + 60 : undefined,
      });
      await connect(ctx, args.boardId, question._id, answerId, "answer", false);
    }
    for (const plan of plans)
      await syncPlanDependencies(ctx, (await ctx.db.get(plan._id))!);
    await ctx.db.patch(args.boardId, { updatedAt: Date.now() });
    return await Promise.all(
      plans.map(async (p) => ({
        planId: p._id,
        revision: (await ctx.db.get(p._id))!.revision,
      })),
    );
  },
});

/** One canonical scene job feeds the selected branches; subsequent schedules stay independent. */
export const startResearch = mutation({
  args: { boardId: v.id("boards"), planIds: v.array(v.id("entities")) },
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.boardId, "editor");
    const plans = await selectedPlans(ctx, args.boardId, args.planIds);
    const [all, runs, choices] = await Promise.all([
      ctx.db
        .query("entities")
        .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
        .collect(),
      ctx.db
        .query("runs")
        .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
        .order("desc")
        .take(100),
      ctx.db
        .query("choices")
        .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
        .collect(),
    ]);
    for (const plan of plans)
      await validatePlanScenes(ctx, args.boardId, plan.data);
    const sceneIds = effectivePlanSceneIds(plans[0].data, all);
    if (
      !sceneIds.length ||
      plans.some(
        (plan) =>
          JSON.stringify([...sceneIds].sort()) !==
          JSON.stringify(effectivePlanSceneIds(plan.data, all).sort()),
      )
    )
      throw new ConvexError(
        "Choose the same nonempty scene selection for the selected plans.",
      );
    const work = sceneIds.map((sceneId) => {
      const scene = all.find((e) => e._id === sceneId)!;
      entitySchema.parse(scene.data);
      const relevant = relevantEntities(
        all,
        { kind: "scene", sceneId },
        sceneId,
        choices,
        "research",
      );
      const blockers = [
        ...blockingQuestions(relevant, "research"),
        ...plans.flatMap((plan) =>
          blockingQuestions(
            relevantEntities(
              all,
              { kind: "plan_scene", planId: plan._id, sceneId },
              sceneId,
              choices,
              "research",
            ),
            "research",
          ),
        ),
      ];
      if (blockers.length)
        throw new ConvexError(
          `Answer first: ${blockers
            .slice(0, 3)
            .map((q) => q.data.prompt)
            .join(" ")}`,
        );
      const sceneRuns = runs.filter(
        (r) => r.kind === "research" && r.targetId === sceneId,
      );
      const canonical = sceneRuns.filter(
        (r) =>
          r.scope.kind === "scene" &&
          !r.scope.planId &&
          !r.changeId &&
          r.request === undefined,
      );
      const fingerprint = JSON.stringify(
        inputFingerprint(relevant, "research"),
      );
      const active = canonical.find(
        (r) =>
          ["queued", "running", "waiting"].includes(r.status) &&
          JSON.stringify(r.inputVersions) === fingerprint,
      );
      if (
        sceneRuns.some(
          (r) =>
            ["queued", "running"].includes(r.status) && r._id !== active?._id,
        )
      )
        throw new ConvexError(
          `Scene ${scene.data.number} already has research in progress. Wait for it to finish before starting shared research.`,
        );
      // Outputs necessarily change the complete run's full fingerprint. Compare
      // its producer inputs instead, and require current sourced candidates.
      const producerInputs = inputFingerprint(
        relevant.filter((e) =>
          ["script", "scene", "question"].includes(e.kind),
        ),
        "research",
      );
      const complete =
        !scene.stale &&
        relevant.some(
          (e) =>
            e.kind === "location" &&
            !e.stale &&
            !e.data.rejected &&
            e.data.sources.length,
        )
          ? canonical.find(
              (r) =>
                r.status === "complete" &&
                JSON.stringify(
                  r.inputVersions.filter((input) => {
                    const entity = all.find((e) => e._id === input.id);
                    return (
                      !entity ||
                      ["script", "scene", "question"].includes(entity.kind)
                    );
                  }),
                ) === JSON.stringify(producerInputs),
            )
          : undefined;
      return {
        sceneId: scene._id,
        existing: active ?? complete,
        reused: !active && !!complete,
      };
    });
    const needed = work.filter((item) => !item.existing).length;
    const available = Math.max(
      0,
      8 - runs.filter((r) => ["queued", "running"].includes(r.status)).length,
    );
    if (needed > available)
      throw new ConvexError(
        `Shared research needs ${needed} new tasks, but ${available} of 8 task slots are available. Select fewer scenes or wait for active tasks to finish.`,
      );
    if (
      needed > 0 &&
      needed + runs.filter((r) => r.createdAt > Date.now() - 3600000).length >
        60
    )
      throw new ConvexError(
        "This shared research would exceed the board's hourly agent limit. Try again later.",
      );
    const outcomes = [];
    for (const item of work) {
      const runId =
        item.existing?._id ??
        (await enqueue(ctx, {
          boardId: args.boardId,
          userId: user._id,
          kind: "research",
          scope: { kind: "scene", sceneId: item.sceneId },
          targetId: item.sceneId,
        }));
      outcomes.push({
        sceneId: item.sceneId,
        runId,
        status: item.reused
          ? ("reused" as const)
          : item.existing
            ? ("active" as const)
            : ("queued" as const),
      });
    }
    return outcomes;
  },
});
