import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { connect, putEntity } from "../convex/lib/entities";
import { syncPlanDependencies } from "../convex/lib/planScope";
import {
  entitySchema,
  type EntityData,
  type PlanData,
  type SceneData,
} from "../src/domain/model";
import { proposeSchedule } from "../src/domain/planning";

const modules = import.meta.glob("../convex/**/*.ts");

async function fixture(count = 3, included = [[0], [1]]) {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity({
    tokenIdentifier: "https://clerk.test|revision-owner",
    subject: "revision-owner",
    name: "Producer",
    email: "revision@example.com",
    emailVerified: true,
  });
  const userId = await owner.mutation(api.boards.initialize);
  const boardId = await owner.mutation(api.boards.create, {
    name: "Shared location revision",
  });
  const records = await t.run(async (ctx) => {
    const scriptId = await putEntity(ctx, {
      boardId,
      actor: userId,
      logicalKey: "script",
      scope: { kind: "workspace" },
      data: entitySchema.parse({
        kind: "script",
        filename: "Original.txt",
        pageCount: count,
        summary: "A rehearsal",
        sceneCount: count,
      }),
    });
    const sceneIds: Id<"entities">[] = [];
    for (let index = 0; index < count; index++) {
      const sceneId = await putEntity(ctx, {
        boardId,
        actor: userId,
        logicalKey: `scene:${index + 1}`,
        scope: { kind: "workspace" },
        ownerId: scriptId,
        data: entitySchema.parse({
          kind: "scene",
          number: index + 1,
          heading: `EXT. BEACH ${index + 1} - DAY`,
          setting: "Beach",
          excerpt: "They rehearse.",
          pageStart: index + 1,
          pageEnd: index + 1,
          interiorExterior: "EXT",
          timeOfDay: "DAY",
          needs: [],
          durationMinutes: 10,
          durationBasis: "confirmed",
          windows: [{ date: "2026-11-14", start: 480, end: 1080 }],
        }),
      });
      sceneIds.push(sceneId);
      await ctx.db.patch(sceneId, { scope: { kind: "scene", sceneId } });
      await connect(ctx, boardId, scriptId, sceneId, "scene");
    }
    const locationId = await putEntity(ctx, {
      boardId,
      actor: userId,
      logicalKey: "shared-location",
      scope: { kind: "scene", sceneId: sceneIds[0] },
      ownerId: sceneIds[0],
      data: entitySchema.parse({
        kind: "location",
        name: "Shared beach",
        address: "California",
        description: "Retrieved coast",
        creativeFit: "Open sand",
        authority: "Park authority",
        restrictions: [],
        sources: [
          {
            url: "https://film.ca.gov/state-permits/",
            title: "Official guidance",
            excerpt: "Observed guidance",
            provider: "parallel",
            retrievedAt: 1,
          },
        ],
        sceneIds,
        costs: [],
        requirements: [],
      }),
    });
    for (const sceneId of sceneIds)
      await connect(ctx, boardId, sceneId, locationId, "candidate");
    const planIds: Id<"entities">[] = [];
    const scheduleIds: Id<"entities">[] = [];
    for (const [index, indexes] of included.entries()) {
      const plan = entitySchema.parse({
        kind: "plan",
        name: index ? "Creative" : "Budget",
        budgetMode: index ? "uncapped" : "fixed",
        budgetMinor: index ? null : 800000,
        priority: index ? "creative" : "cost",
        sceneScope: {
          mode: "selected",
          sceneIds: indexes.map((i) => sceneIds[i]),
        },
        dates: ["2026-11-14"],
        setupMinutes: 5,
        moveMinutes: 10,
        timingBasis: "confirmed",
      }) as PlanData;
      const planId = await putEntity(ctx, {
        boardId,
        actor: userId,
        logicalKey: `plan:${index}`,
        scope: { kind: "workspace" },
        data: plan,
      });
      planIds.push(planId);
      await ctx.db.patch(planId, { scope: { kind: "plan", planId } });
      for (const sceneId of sceneIds)
        await ctx.db.insert("choices", {
          boardId,
          planId,
          sceneId,
          locationId,
          locked: true,
          revision: 1,
        });
      const scenes = await Promise.all(
        indexes.map((i) => ctx.db.get(sceneIds[i])),
      );
      const schedule = proposeSchedule(
        planId,
        plan,
        scenes.map((scene) => ({
          id: scene!._id,
          data: scene!.data as SceneData,
          locationId,
          locationName: "Shared beach",
        })),
      );
      const scheduleId = await putEntity(ctx, {
        boardId,
        actor: userId,
        logicalKey: `${planId}:schedule`,
        scope: { kind: "plan", planId },
        ownerId: planId,
        data: schedule,
      });
      scheduleIds.push(scheduleId);
      await connect(ctx, boardId, planId, scheduleId, "schedule");
      await syncPlanDependencies(ctx, (await ctx.db.get(planId))!);
    }
    const questionId = await putEntity(ctx, {
      boardId,
      actor: userId,
      logicalKey: `${scriptId}:question:crew_size`,
      scope: { kind: "workspace" },
      ownerId: scriptId,
      data: entitySchema.parse({
        kind: "question",
        key: "crew_size",
        prompt: "Crew size?",
        reason: "Production requirements",
        suggestions: [],
        blocks: ["requirements"],
        answer: "10",
        resolution: "answered",
      }),
    });
    await connect(ctx, boardId, questionId, scriptId, "question");
    for (const planId of planIds)
      await syncPlanDependencies(ctx, (await ctx.db.get(planId))!);
    return { scriptId, sceneIds, locationId, planIds, scheduleIds, questionId };
  });
  return { t, owner, boardId, userId, ...records };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function edit(
  f: Fixture,
  id: Id<"entities">,
  patch: Partial<EntityData>,
) {
  const before = await f.t.run((ctx) => ctx.db.get(id));
  const changeId = await f.owner.mutation(api.changes.preview, {
    boardId: f.boardId,
    entityId: id,
    expectedRevision: before!.revision,
    data: entitySchema.parse({ ...before!.data, ...patch }),
  });
  await f.owner.mutation(api.changes.commitInputs, { changeId });
  return changeId;
}

describe("revision invalidation follows active scene membership", () => {
  it("publishes distinct plan-scene questions without changing global or other-plan inputs", async () => {
    const f = await fixture(3, [
      [0, 1],
      [0, 1],
    ]);
    const questionData = entitySchema.parse({
      kind: "question",
      key: "shelter",
      prompt: "Need shelter for this plan?",
      reason: "Location fit",
      suggestions: [],
      blocks: ["research"],
      resolution: "open",
    });
    const firstRun = await f.owner.mutation(api.runs.start, {
      boardId: f.boardId,
      kind: "research",
      targetId: f.sceneIds[0],
      scope: {
        kind: "plan_scene",
        planId: f.planIds[0],
        sceneId: f.sceneIds[0],
      },
    });
    const otherRun = await f.owner.mutation(api.runs.start, {
      boardId: f.boardId,
      kind: "schedule",
      targetId: f.planIds[1],
      scope: { kind: "plan", planId: f.planIds[1] },
    });
    await f.t.mutation(internal.runs.claim, { runId: firstRun, attempt: 1 });
    await expect(
      f.t.mutation(internal.runs.event, {
        runId: firstRun,
        attempt: 1,
        sequence: 1,
        status: "waiting",
        activity: "Wrong scene question",
        result: { questions: [{ ownerId: f.sceneIds[1], data: questionData }] },
      }),
    ).rejects.toThrow("selected scene scope");
    await f.t.mutation(internal.runs.event, {
      runId: firstRun,
      attempt: 1,
      sequence: 1,
      status: "waiting",
      activity: "Local clarification",
      result: { questions: [{ data: questionData }] },
    });
    const after = await f.owner.query(api.boards.snapshot, {
      boardId: f.boardId,
    });
    const firstQuestion = after.entities.find(
      (e) => e.data.kind === "question" && e.data.key === "shelter",
    )!;
    expect(firstQuestion).toMatchObject({
      ownerId: f.sceneIds[0],
      stale: true,
      scope: {
        kind: "plan_scene",
        planId: f.planIds[0],
        sceneId: f.sceneIds[0],
      },
    });
    for (const id of [f.sceneIds[0], f.sceneIds[1], f.locationId, f.planIds[1]])
      expect(after.entities.find((e) => e._id === id)).toMatchObject({
        revision: 1,
        stale: false,
      });
    expect(after.entities.find((e) => e._id === f.planIds[0])).toMatchObject({
      stale: true,
      revision: 2,
    });
    expect(
      await f.t.mutation(internal.runs.claim, { runId: otherRun, attempt: 1 }),
    ).toBe(true);

    const secondRun = await f.owner.mutation(api.runs.start, {
      boardId: f.boardId,
      kind: "requirements",
      targetId: f.locationId,
      scope: {
        kind: "plan_scene",
        planId: f.planIds[1],
        sceneId: f.sceneIds[0],
      },
    });
    await f.t.mutation(internal.runs.claim, { runId: secondRun, attempt: 1 });
    const context = await f.t.query(internal.runs.context, {
      runId: secondRun,
      attempt: 1,
    });
    expect(context.entities.some((e) => e._id === firstQuestion._id)).toBe(
      false,
    );
    await f.t.mutation(internal.runs.event, {
      runId: secondRun,
      attempt: 1,
      sequence: 1,
      status: "waiting",
      activity: "Other plan clarification",
      result: {
        questions: [
          { ownerId: f.sceneIds[0], data: questionData },
          {
            ownerId: f.locationId,
            data: { ...questionData, key: "location_shelter" },
          },
        ],
      },
    });
    const questions = await f.t.run((ctx) =>
      ctx.db
        .query("entities")
        .withIndex("by_board_kind", (q) =>
          q.eq("boardId", f.boardId).eq("kind", "question"),
        )
        .collect(),
    );
    const scoped = questions.filter((q) => q.data.key === "shelter");
    expect(scoped).toHaveLength(2);
    expect(new Set(scoped.map((q) => q.logicalKey)).size).toBe(2);
    expect(scoped.every((q) => q.ownerId === f.sceneIds[0])).toBe(true);
    expect(new Set(scoped.map((q) => q.scope.planId))).toEqual(
      new Set(f.planIds),
    );
    expect(
      questions.find((q) => q.data.key === "location_shelter"),
    ).toMatchObject({
      ownerId: f.locationId,
      scope: {
        kind: "plan_scene",
        planId: f.planIds[1],
        sceneId: f.sceneIds[0],
      },
    });
  });

  it("retains undo versions when staged research publishes a new scoped clarification", async () => {
    const f = await fixture(3, [[0], [0]]);
    const scopedQuestionId = await f.t.run(async (ctx) => {
      const id = await putEntity(ctx, {
        boardId: f.boardId,
        actor: f.userId,
        logicalKey: "scoped-answer",
        ownerId: f.sceneIds[0],
        scope: {
          kind: "plan_scene",
          planId: f.planIds[0],
          sceneId: f.sceneIds[0],
        },
        data: entitySchema.parse({
          kind: "question",
          key: "shelter",
          prompt: "Shelter?",
          reason: "Fit",
          suggestions: [],
          blocks: ["research"],
          answer: "No",
          resolution: "answered",
        }),
      });
      await connect(ctx, f.boardId, id, f.planIds[0], "question");
      await syncPlanDependencies(ctx, (await ctx.db.get(f.planIds[0]))!);
      return id;
    });
    const changeId = await edit(f, scopedQuestionId, { answer: "Yes" });
    const runs = await f.owner.mutation(api.changes.regenerate, { changeId });
    await f.t.mutation(internal.runs.claim, { runId: runs[0], attempt: 1 });
    await f.t.mutation(internal.runs.event, {
      runId: runs[0],
      attempt: 1,
      sequence: 1,
      status: "waiting",
      activity: "Follow-up needed",
      result: {
        questions: [
          {
            data: entitySchema.parse({
              kind: "question",
              key: "shelter_size",
              prompt: "How much shelter?",
              reason: "Fit",
              suggestions: [],
              blocks: ["research"],
              resolution: "open",
            }),
          },
        ],
      },
    });
    const beforeUndo = await f.t.run(async (ctx) => ({
      change: await ctx.db.get(changeId),
      plan: await ctx.db.get(f.planIds[0]),
    }));
    expect(
      beforeUndo.change!.appliedVersions!.find((v) => v.id === f.planIds[0])!
        .revision,
    ).toBe(beforeUndo.plan!.revision);
    expect(
      beforeUndo.change!.readVersions.find((v) => v.id === f.planIds[0])!
        .revision,
    ).toBe(beforeUndo.plan!.revision);
    await f.owner.mutation(api.changes.undo, { changeId });
    const restored = await f.owner.query(api.boards.snapshot, {
      boardId: f.boardId,
    });
    expect(
      restored.entities.some(
        (e) => e.data.kind === "question" && e.data.key === "shelter_size",
      ),
    ).toBe(false);
    expect(
      restored.entities.find((e) => e._id === scopedQuestionId)!.data.answer,
    ).toBe("No");
    expect(restored.entities.find((e) => e._id === f.planIds[0])!.stale).toBe(
      false,
    );
  });

  it("keeps a plan-scene answer and its research marker inside that plan", async () => {
    const f = await fixture(3, [[0], [0]]);
    const questionId = await f.t.run(async (ctx) => {
      const id = await putEntity(ctx, {
        boardId: f.boardId,
        actor: f.userId,
        logicalKey: "plan-scene-question",
        scope: {
          kind: "plan_scene",
          planId: f.planIds[0],
          sceneId: f.sceneIds[0],
        },
        ownerId: f.sceneIds[0],
        data: entitySchema.parse({
          kind: "question",
          key: "creative_detail",
          prompt: "Sheltered courtyard for Budget?",
          reason: "This plan's location fit",
          suggestions: [],
          blocks: ["research"],
          answer: "No",
          resolution: "answered",
        }),
      });
      await connect(ctx, f.boardId, id, f.sceneIds[0], "question");
      for (const planId of f.planIds)
        await syncPlanDependencies(ctx, (await ctx.db.get(planId))!);
      return id;
    });
    const alternateRun = await f.owner.mutation(api.runs.start, {
      boardId: f.boardId,
      kind: "schedule",
      targetId: f.planIds[1],
      scope: { kind: "plan", planId: f.planIds[1] },
    });
    const changeId = await edit(f, questionId, { answer: "Yes" });
    expect(await f.t.run((ctx) => ctx.db.get(f.sceneIds[0]))).toMatchObject({
      stale: false,
      revision: 1,
    });
    expect(await f.t.run((ctx) => ctx.db.get(f.locationId))).toMatchObject({
      stale: false,
      revision: 1,
    });
    expect(await f.t.run((ctx) => ctx.db.get(f.planIds[0]))).toMatchObject({
      stale: true,
    });
    expect(await f.t.run((ctx) => ctx.db.get(f.planIds[1]))).toMatchObject({
      stale: false,
      revision: 1,
    });
    expect(
      await f.t.mutation(internal.runs.claim, {
        runId: alternateRun,
        attempt: 1,
      }),
    ).toBe(true);
    const researchRuns = await f.owner.mutation(api.changes.regenerate, {
      changeId,
    });
    expect(await f.t.run((ctx) => ctx.db.get(researchRuns[0]))).toMatchObject({
      scope: {
        kind: "plan_scene",
        planId: f.planIds[0],
        sceneId: f.sceneIds[0],
      },
    });
    await f.t.mutation(internal.runs.claim, {
      runId: researchRuns[0],
      attempt: 1,
    });
    const context = await f.t.query(internal.runs.context, {
      runId: researchRuns[0],
      attempt: 1,
    });
    expect(
      context.entities.some(
        (entity) => entity._id === questionId && entity.data.answer === "Yes",
      ),
    ).toBe(true);
    const location = (await f.t.run((ctx) => ctx.db.get(f.locationId)))!;
    await f.t.mutation(internal.runs.event, {
      runId: researchRuns[0],
      attempt: 1,
      sequence: 1,
      activity: "Scoped research ready",
      status: "complete",
      result: {
        locations: [{ ...location.data, name: "Plan-specific courtyard" }],
      },
    });
    await f.t.mutation(internal.changes.advance, { changeId });
    await f.owner.mutation(api.changes.apply, { changeId });
    expect(await f.t.run((ctx) => ctx.db.get(questionId))).toMatchObject({
      stale: false,
    });
    expect(await f.t.run((ctx) => ctx.db.get(f.planIds[0]))).toMatchObject({
      stale: false,
    });
    expect(await f.t.run((ctx) => ctx.db.get(f.sceneIds[0]))).toMatchObject({
      stale: false,
      revision: 1,
    });
    expect(await f.t.run((ctx) => ctx.db.get(f.scheduleIds[1]))).toMatchObject({
      stale: false,
      revision: 1,
    });
  });

  it("retimes an included scene without invalidating shared research or the other plan, and undo restores timing", async () => {
    const f = await fixture();
    const changeId = await edit(f, f.sceneIds[0], { durationMinutes: 20 });
    const changed = await f.owner.query(api.boards.snapshot, {
      boardId: f.boardId,
    });
    expect(changed.entities.find((e) => e._id === f.locationId)).toMatchObject({
      stale: false,
      revision: 1,
    });
    expect(
      changed.entities.find((e) => e._id === f.scheduleIds[0])!.stale,
    ).toBe(true);
    expect(
      changed.entities.find((e) => e._id === f.scheduleIds[1]),
    ).toMatchObject({ stale: false, revision: 1 });
    const runIds = await f.owner.mutation(api.changes.regenerate, { changeId });
    const run = await f.t.run((ctx) => ctx.db.get(runIds[0]));
    expect(run?.kind).toBe("schedule");
    expect(run?.targetId).toBe(f.planIds[0]);
    await f.owner.mutation(api.changes.undo, { changeId });
    const restored = await f.owner.query(api.boards.snapshot, {
      boardId: f.boardId,
    });
    expect(
      restored.entities.find((e) => e._id === f.sceneIds[0])!.data
        .durationMinutes,
    ).toBe(10);
    expect(restored.entities.find((e) => e._id === f.locationId)).toMatchObject(
      { stale: false, revision: 1 },
    );
    expect(
      restored.entities.find((e) => e._id === f.scheduleIds[1]),
    ).toMatchObject({ stale: false, revision: 1 });
  });

  it("keeps both plans current after an excluded scene's time window changes despite sharing their location", async () => {
    const f = await fixture();
    await edit(f, f.sceneIds[2], {
      windows: [{ date: "2026-11-14", start: 600, end: 1080 }],
    });
    const changed = await f.owner.query(api.boards.snapshot, {
      boardId: f.boardId,
    });
    for (const id of [f.locationId, ...f.scheduleIds])
      expect(changed.entities.find((e) => e._id === id)).toMatchObject({
        stale: false,
        revision: 1,
      });
  });

  it("re-researches excluded scene needs without marking unchanged shared evidence or other plans stale", async () => {
    const f = await fixture();
    const changeId = await edit(f, f.sceneIds[2], {
      needs: ["A sheltered rehearsal area"],
    });
    const changed = await f.owner.query(api.boards.snapshot, {
      boardId: f.boardId,
    });
    expect(changed.entities.find((e) => e._id === f.sceneIds[2])!.stale).toBe(
      true,
    );
    for (const id of [f.locationId, ...f.scheduleIds])
      expect(changed.entities.find((e) => e._id === id)).toMatchObject({
        stale: false,
        revision: 1,
      });
    const runIds = await f.owner.mutation(api.changes.regenerate, { changeId });
    expect(runIds).toHaveLength(1);
    expect(await f.t.run((ctx) => ctx.db.get(runIds[0]))).toMatchObject({
      kind: "research",
      targetId: f.sceneIds[2],
    });
  });

  it("marks a scene-owned research answer stale locally and preserves the shared source", async () => {
    const f = await fixture();
    const question = await f.t.run(async (ctx) => {
      const id = await putEntity(ctx, {
        boardId: f.boardId,
        actor: f.userId,
        logicalKey: "local-question",
        scope: { kind: "scene", sceneId: f.sceneIds[0] },
        ownerId: f.sceneIds[0],
        data: entitySchema.parse({
          kind: "question",
          key: "scene_access",
          prompt: "Accessible ramp needed?",
          reason: "Location fit",
          suggestions: [],
          blocks: ["research"],
          answer: "No",
          resolution: "answered",
        }),
      });
      await connect(ctx, f.boardId, id, f.sceneIds[0], "question");
      return id;
    });
    const changeId = await edit(f, question, { answer: "Yes" });
    const changed = await f.owner.query(api.boards.snapshot, {
      boardId: f.boardId,
    });
    expect(changed.entities.find((e) => e._id === f.sceneIds[0])!.stale).toBe(
      true,
    );
    expect(changed.entities.find((e) => e._id === f.locationId)).toMatchObject({
      stale: false,
      revision: 1,
    });
    expect(
      changed.entities.find((e) => e._id === f.scheduleIds[1]),
    ).toMatchObject({ stale: false, revision: 1 });
    await f.owner.mutation(api.changes.undo, { changeId });
    expect((await f.t.run((ctx) => ctx.db.get(f.sceneIds[0])))!.stale).toBe(
      false,
    );
  });
});

describe("durable bounded revision regeneration", () => {
  it("queues only the effective scene union after a workspace answer changes", async () => {
    const f = await fixture(11, [
      [0, 1, 2],
      [0, 1, 2],
    ]);
    await f.t.run(async (ctx) => {
      const id = await putEntity(ctx, {
        boardId: f.boardId,
        actor: f.userId,
        logicalKey: "excluded-blocker",
        scope: { kind: "scene", sceneId: f.sceneIds[10] },
        ownerId: f.sceneIds[10],
        data: entitySchema.parse({
          kind: "question",
          key: "excluded",
          prompt: "Excluded-scene decision",
          reason: "Not in either plan",
          suggestions: [],
          blocks: ["research"],
          resolution: "open",
        }),
      });
      await connect(ctx, f.boardId, id, f.sceneIds[10], "question");
    });
    const changeId = await edit(f, f.questionId, { answer: "12" });
    const runIds = await f.owner.mutation(api.changes.regenerate, { changeId });
    const runs = await f.t.run((ctx) =>
      Promise.all(runIds.map((id) => ctx.db.get(id))),
    );
    expect(runs.map((run) => run!.targetId).sort()).toEqual(
      f.sceneIds.slice(0, 3).sort(),
    );
    expect(
      (await f.t.run((ctx) => ctx.db.get(changeId)))?.regenerationError,
    ).toBeUndefined();
  });

  it("retains work beyond eight jobs and drains it after a real completion without becoming ready early", async () => {
    const indexes = Array.from({ length: 10 }, (_, index) => index);
    const f = await fixture(11, [indexes, indexes]);
    const changeId = await edit(f, f.questionId, { answer: "12" });
    const initial = await f.owner.mutation(api.changes.regenerate, {
      changeId,
    });
    expect(initial).toHaveLength(8);
    const before = await f.t.run((ctx) => ctx.db.get(changeId));
    expect(before?.pendingJobs).toHaveLength(2);
    expect(before?.status).toBe("regenerating");
    expect(
      await f.t.mutation(internal.runs.claim, {
        runId: initial[0],
        attempt: 1,
      }),
    ).toBe(true);
    await f.t.mutation(internal.runs.event, {
      runId: initial[0],
      attempt: 1,
      sequence: 1,
      activity: "Research complete",
      status: "complete",
      result: {},
    });
    await f.t.mutation(internal.changes.advance, { changeId });
    const next = await f.t.run((ctx) => ctx.db.get(changeId));
    expect(next?.runIds).toHaveLength(9);
    expect(next?.pendingJobs).toHaveLength(1);
    expect(next?.status).toBe("regenerating");
    expect((await f.t.run((ctx) => ctx.db.get(initial[0])))?.status).toBe(
      "complete",
    );
    await f.owner.mutation(api.changes.undo, { changeId });
    const undone = await f.t.run((ctx) => ctx.db.get(changeId));
    expect(undone?.pendingJobs).toEqual([]);
    await f.t.mutation(internal.changes.advance, {
      changeId,
      continuationAt: before?.regenerationContinuationAt,
    });
    expect((await f.t.run((ctx) => ctx.db.get(changeId)))?.runIds).toHaveLength(
      9,
    );
  });

  it("retains a blocked scene for retry while queuing independent scenes", async () => {
    const f = await fixture(3, [
      [0, 1],
      [0, 1],
    ]);
    const blockerId = await f.t.run(async (ctx) => {
      const id = await putEntity(ctx, {
        boardId: f.boardId,
        actor: f.userId,
        logicalKey: "included-blocker",
        scope: { kind: "scene", sceneId: f.sceneIds[0] },
        ownerId: f.sceneIds[0],
        data: entitySchema.parse({
          kind: "question",
          key: "ramp",
          prompt: "Confirm ramp needs",
          reason: "Location choice",
          suggestions: [],
          blocks: ["research"],
          resolution: "open",
        }),
      });
      await connect(ctx, f.boardId, id, f.sceneIds[0], "question");
      return id;
    });
    const changeId = await edit(f, f.questionId, { answer: "12" });
    const runIds = await f.owner.mutation(api.changes.regenerate, { changeId });
    expect(runIds).toHaveLength(1);
    let change = await f.t.run((ctx) => ctx.db.get(changeId));
    expect(change?.pendingJobs).toHaveLength(1);
    expect(change?.regenerationError).toContain("Confirm ramp needs");
    expect(change?.regenerationContinuationAt).toBeUndefined();
    await f.t.run(async (ctx) => {
      const q = (await ctx.db.get(blockerId))!;
      await ctx.db.patch(blockerId, {
        data: { ...q.data, answer: "Yes", resolution: "answered" },
      });
    });
    const retried = await f.owner.mutation(api.changes.regenerate, {
      changeId,
    });
    change = await f.t.run((ctx) => ctx.db.get(changeId));
    expect(retried).toHaveLength(2);
    expect(retried).toContain(runIds[0]);
    expect(change?.pendingJobs).toEqual([]);
    expect(change?.regenerationError).toBeUndefined();
  });

  it("retries a failed job without replacing an independently completed result", async () => {
    const f = await fixture(3, [
      [0, 1],
      [0, 1],
    ]);
    const changeId = await edit(f, f.questionId, { answer: "12" });
    const initial = await f.owner.mutation(api.changes.regenerate, {
      changeId,
    });
    for (const runId of initial)
      await f.t.mutation(internal.runs.claim, { runId, attempt: 1 });
    await f.t.mutation(internal.runs.event, {
      runId: initial[0],
      attempt: 1,
      sequence: 1,
      activity: "Research complete",
      status: "complete",
      result: {},
    });
    await f.t.mutation(internal.runs.event, {
      runId: initial[1],
      attempt: 1,
      sequence: 1,
      activity: "Research unavailable",
      status: "failed",
      detail: "Retry this location research",
    });
    await f.t.mutation(internal.changes.advance, { changeId });
    expect(
      (await f.t.run((ctx) => ctx.db.get(changeId)))?.regenerationError,
    ).toContain("interrupted");
    const retried = await f.owner.mutation(api.changes.regenerate, {
      changeId,
    });
    expect(retried).toHaveLength(2);
    expect(retried).toContain(initial[0]);
    expect(retried).not.toContain(initial[1]);
    expect((await f.t.run((ctx) => ctx.db.get(initial[0])))?.status).toBe(
      "complete",
    );
    expect(
      (await f.t.run((ctx) => ctx.db.get(changeId)))?.regenerationError,
    ).toBeUndefined();
  });
});
