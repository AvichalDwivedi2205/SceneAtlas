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
const identity = (name: string) => ({
  tokenIdentifier: `https://clerk.test|${name}`,
  subject: name,
  name,
  email: `${name}@example.com`,
  emailVerified: true,
});

async function fixture(
  mode: "selected" | "legacy" | "all" | "empty" = "selected",
  excludedBlocker = false,
) {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity("scope-owner"));
  const userId = await owner.mutation(api.boards.initialize);
  const boardId = await owner.mutation(api.boards.create, {
    name: "Five-scene production",
  });
  const saved = await t.run(async (ctx) => {
    const sceneIds: Id<"entities">[] = [];
    const locationIds: Id<"entities">[] = [];
    const planIds: Id<"entities">[] = [];
    const scheduleIds: Id<"entities">[] = [];
    for (let index = 0; index < 5; index++) {
      const sceneId = await putEntity(ctx, {
        boardId,
        actor: userId,
        logicalKey: `scope-scene:${index}`,
        scope: { kind: "workspace" },
        data: entitySchema.parse({
          kind: "scene",
          number: index + 1,
          heading: `EXT. BEACH ${index + 1} - DAY`,
          excerpt: "The performer rehearses.",
          pageStart: index + 1,
          pageEnd: index + 1,
          setting: `Beach ${index + 1}`,
          interiorExterior: "EXT",
          timeOfDay: "DAY",
          needs: [],
          durationMinutes: 30,
          durationBasis: "confirmed",
          windows: [{ date: "2026-11-14", start: 480, end: 1080 }],
        }),
      });
      sceneIds.push(sceneId);
      await ctx.db.patch(sceneId, { scope: { kind: "scene", sceneId } });
      const locationId = await putEntity(ctx, {
        boardId,
        actor: userId,
        logicalKey: `scope-location:${index}`,
        scope: { kind: "scene", sceneId },
        ownerId: sceneId,
        data: entitySchema.parse({
          kind: "location",
          name: `Shared candidate ${index + 1}`,
          address: "California",
          description: "Retrieved location",
          creativeFit: "Open sand",
          restrictions: [],
          authority: "State Parks",
          sources: [
            {
              url: `https://film.ca.gov/state-permits/scene-${index + 1}`,
              title: "Official guidance",
              excerpt: "Observed evidence",
              provider: "parallel",
              retrievedAt: 1,
            },
          ],
          sceneIds: [sceneId],
          costs: [],
          requirements: [],
        }),
      });
      locationIds.push(locationId);
      await connect(ctx, boardId, sceneId, locationId, "candidate");
    }
    const original = await ctx.db.get(locationIds[0]);
    const alternateLocationId = await putEntity(ctx, {
      boardId,
      actor: userId,
      logicalKey: "scope-location:alternate",
      scope: { kind: "scene", sceneId: sceneIds[0] },
      ownerId: sceneIds[0],
      data: entitySchema.parse({
        ...original!.data,
        name: "Alternative candidate",
      }),
    });
    const included =
      mode === "empty"
        ? []
        : mode === "selected"
          ? sceneIds.slice(0, 3)
          : sceneIds;
    for (const [index, name] of ["Budget", "Creative"].entries()) {
      const plan = entitySchema.parse({
        kind: "plan",
        name,
        ...(mode === "legacy"
          ? {}
          : {
              sceneScope: {
                mode: mode === "all" ? "all" : "selected",
                sceneIds: mode === "all" ? [] : included,
              },
            }),
        budgetMode: index === 0 ? "fixed" : "uncapped",
        budgetMinor: index === 0 ? 800000 : null,
        currency: "USD",
        priority: index === 0 ? "cost" : "creative",
        dates: ["2026-11-14"],
        moveMinutes: 15,
        setupMinutes: 10,
        timingBasis: "confirmed",
      }) as PlanData;
      const planId = await putEntity(ctx, {
        boardId,
        actor: userId,
        logicalKey: `scope-plan:${index}`,
        scope: { kind: "workspace" },
        data: plan,
      });
      planIds.push(planId);
      await ctx.db.patch(planId, { scope: { kind: "plan", planId } });
      // Previously saved choices outside the current selection are intentional.
      for (const [sceneIndex, sceneId] of sceneIds.entries())
        await ctx.db.insert("choices", {
          boardId,
          planId,
          sceneId,
          locationId: locationIds[sceneIndex],
          locked: sceneIndex === 2,
          revision: 1,
        });
      const scenes = await Promise.all(included.map((id) => ctx.db.get(id)));
      const schedule = proposeSchedule(
        planId,
        plan,
        scenes.map((scene) => ({
          id: scene!._id,
          data: scene!.data as SceneData,
          locationId: locationIds[sceneIds.indexOf(scene!._id)],
          locationName: `Shared candidate ${scene!.data.number}`,
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
    let excludedQuestionId: Id<"entities"> | undefined;
    if (excludedBlocker) {
      excludedQuestionId = await putEntity(ctx, {
        boardId,
        actor: userId,
        logicalKey: "scope-excluded-question",
        scope: { kind: "scene", sceneId: sceneIds[4] },
        ownerId: sceneIds[4],
        data: entitySchema.parse({
          kind: "question",
          key: "excluded_access",
          prompt: "Confirm access for excluded scene five",
          reason: "Location is unconfirmed",
          suggestions: [],
          blocks: ["schedule"],
          answer: null,
          resolution: "open",
          rule: null,
        }),
      });
      for (const planId of planIds)
        await syncPlanDependencies(ctx, (await ctx.db.get(planId))!);
    }
    return {
      sceneIds,
      locationIds,
      alternateLocationId,
      planIds,
      scheduleIds,
      excludedQuestionId,
    };
  });
  return { t, owner, boardId, userId, ...saved };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function edit(f: Fixture, entityId: Id<"entities">, data: EntityData) {
  const before = await f.t.run((ctx) => ctx.db.get(entityId));
  const changeId = await f.owner.mutation(api.changes.preview, {
    boardId: f.boardId,
    entityId,
    expectedRevision: before!.revision,
    data,
  });
  await f.owner.mutation(api.changes.commitInputs, { changeId });
  return changeId;
}

async function setScenes(f: Fixture, sceneIds: Id<"entities">[]) {
  const plan = await f.t.run((ctx) => ctx.db.get(f.planIds[0]));
  return edit(
    f,
    plan!._id,
    entitySchema.parse({
      ...plan!.data,
      sceneScope: { mode: "selected", sceneIds },
    }),
  );
}

async function scheduleContext(f: Fixture, planId = f.planIds[0]) {
  const runId = await f.owner.mutation(api.runs.start, {
    boardId: f.boardId,
    kind: "schedule",
    targetId: planId,
    scope: { kind: "plan", planId },
  });
  expect(await f.t.mutation(internal.runs.claim, { runId, attempt: 1 })).toBe(
    true,
  );
  return {
    runId,
    context: await f.t.query(internal.runs.context, { runId, attempt: 1 }),
  };
}

async function stagedChange(f: Fixture, targetId = f.planIds[0]) {
  return f.t.run(async (ctx) => {
    const target = await ctx.db.get(targetId);
    return ctx.db.insert("changes", {
      boardId: f.boardId,
      targetId,
      baseRevision: target!.revision,
      before: target!.data,
      proposed: target!.data,
      affectedIds: [],
      readVersions: [{ id: targetId, revision: target!.revision }],
      status: "regenerating",
      createdBy: f.userId,
      createdAt: Date.now(),
      summary: "Staged regression fixture",
      runIds: [],
    });
  });
}

describe("plan scene membership at Convex boundaries", () => {
  it.each(["legacy", "all"] as const)(
    "keeps %s plans scoped to all screenplay scenes",
    async (mode) => {
      const f = await fixture(mode);
      const { context } = await scheduleContext(f);
      expect(
        context.entities
          .filter((e) => e.kind === "scene")
          .map((e) => e._id)
          .sort(),
      ).toEqual([...f.sceneIds].sort());
      expect(context.choices).toHaveLength(5);
      expect(context.schedule!.entries).toHaveLength(5);
    },
  );

  it("keeps explicit empty membership empty and blocks generating both plans", async () => {
    const f = await fixture("empty");
    const outcomes = await f.owner.mutation(api.planning.startReadyPlans, {
      boardId: f.boardId,
      planIds: f.planIds,
    });
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.runId).toBeUndefined();
      expect(outcome.blockers).toContain("Choose scenes for this shoot plan.");
    }
    expect(
      (await f.owner.query(api.boards.snapshot, { boardId: f.boardId })).runs,
    ).toHaveLength(0);
    await expect(
      f.owner.mutation(api.runs.start, {
        boardId: f.boardId,
        kind: "schedule",
        targetId: f.planIds[0],
        scope: { kind: "plan", planId: f.planIds[0] },
      }),
    ).rejects.toThrow("Choose scenes for this shoot plan");
  });

  it("passes only the selected three scenes, their choices and questions into the agent", async () => {
    const f = await fixture("selected", true);
    const { context } = await scheduleContext(f);
    expect(
      context.entities
        .filter((e) => e.kind === "scene")
        .map((e) => e._id)
        .sort(),
    ).toEqual(f.sceneIds.slice(0, 3).sort());
    expect(context.choices.map((c) => c.sceneId).sort()).toEqual(
      f.sceneIds.slice(0, 3).sort(),
    );
    expect(context.choices.every((c) => c.planId === f.planIds[0])).toBe(true);
    expect(
      context.entities.some(
        (e) =>
          e._id === f.excludedQuestionId || e._id === f.alternateLocationId,
      ),
    ).toBe(false);
    expect(context.schedule!.entries.map((e) => e.sceneId).sort()).toEqual(
      f.sceneIds.slice(0, 3).sort(),
    );
    await f.t.run(async (ctx) => {
      await putEntity(ctx, {
        boardId: f.boardId,
        actor: f.userId,
        logicalKey: "scope-included-question",
        scope: { kind: "scene", sceneId: f.sceneIds[0] },
        ownerId: f.sceneIds[0],
        data: entitySchema.parse({
          kind: "question",
          key: "included_access",
          prompt: "Confirm included-scene access",
          reason: "Required",
          suggestions: [],
          blocks: ["schedule"],
          answer: null,
          resolution: "open",
          rule: null,
        }),
      });
    });
    await expect(
      f.owner.mutation(api.runs.start, {
        boardId: f.boardId,
        kind: "schedule",
        targetId: f.planIds[1],
        scope: { kind: "plan", planId: f.planIds[1] },
      }),
    ).rejects.toThrow("Confirm included-scene access");
  });

  it("rejects foreign scenes at preview and selection and denies viewer writes", async () => {
    const f = await fixture();
    const otherBoard = await f.owner.mutation(api.boards.create, {
      name: "Other production",
    });
    const foreignScene = await f.t.run(async (ctx) =>
      putEntity(ctx, {
        boardId: otherBoard,
        actor: f.userId,
        logicalKey: "foreign-scene",
        scope: { kind: "workspace" },
        data: (await ctx.db.get(f.sceneIds[0]))!.data,
      }),
    );
    const plan = await f.t.run((ctx) => ctx.db.get(f.planIds[0]));
    await expect(
      f.owner.mutation(api.changes.preview, {
        boardId: f.boardId,
        entityId: plan!._id,
        expectedRevision: plan!.revision,
        data: {
          ...plan!.data,
          sceneScope: { mode: "selected", sceneIds: [foreignScene] },
        },
      }),
    ).rejects.toThrow("Every included scene must belong");
    await expect(
      f.owner.mutation(api.planning.select, {
        boardId: f.boardId,
        planId: plan!._id,
        sceneId: foreignScene,
        locationId: f.locationIds[0],
        locked: false,
        expectedRevision: 0,
      }),
    ).rejects.toThrow("Record not found on this board");
    await expect(
      f.owner.mutation(api.planning.select, {
        boardId: f.boardId,
        planId: plan!._id,
        sceneId: f.sceneIds[4],
        locationId: f.locationIds[4],
        locked: true,
        expectedRevision: 1,
      }),
    ).rejects.toThrow("Include this scene in the plan");
    const viewer = f.t.withIdentity(identity("scope-viewer"));
    const viewerId = await viewer.mutation(api.boards.initialize);
    await f.t.run((ctx) =>
      ctx.db.insert("members", {
        boardId: f.boardId,
        userId: viewerId,
        role: "viewer",
        createdAt: Date.now(),
      }),
    );
    await expect(
      viewer.mutation(api.changes.preview, {
        boardId: f.boardId,
        entityId: plan!._id,
        expectedRevision: plan!.revision,
        data: { ...plan!.data, dayStart: 540 },
      }),
    ).rejects.toThrow("You do not have access");
    await expect(
      viewer.mutation(api.planning.select, {
        boardId: f.boardId,
        planId: plan!._id,
        sceneId: f.sceneIds[0],
        locationId: f.locationIds[0],
        locked: true,
        expectedRevision: 1,
      }),
    ).rejects.toThrow("You do not have access");
  });

  it.each(["undo", "reinclude"] as const)(
    "retains excluded locked choices and restores dependencies on %s",
    async (restore) => {
      const f = await fixture();
      const chosenBefore = await f.t.run((ctx) =>
        ctx.db
          .query("choices")
          .withIndex("by_plan_scene", (q) =>
            q.eq("planId", f.planIds[0]).eq("sceneId", f.sceneIds[2]),
          )
          .unique(),
      );
      const changeId = await setScenes(f, f.sceneIds.slice(0, 2));
      const incoming = () =>
        f.t.run(async (ctx) =>
          (
            await ctx.db
              .query("dependencies")
              .withIndex("by_board", (q) => q.eq("boardId", f.boardId))
              .collect()
          )
            .filter((edge) => edge.targetId === f.planIds[0])
            .map((edge) => edge.sourceId),
        );
      expect(await incoming()).not.toContain(f.sceneIds[2]);
      expect(await incoming()).not.toContain(f.locationIds[2]);
      const excluded = await f.owner.query(api.boards.snapshot, {
        boardId: f.boardId,
      });
      expect(excluded.choices.find((c) => c._id === chosenBefore!._id)).toEqual(
        chosenBefore,
      );
      expect(
        excluded.entities.find((e) => e._id === f.scheduleIds[0])!.stale,
      ).toBe(true);
      expect(
        excluded.entities.find((e) => e._id === f.scheduleIds[1])!.stale,
      ).toBe(false);
      if (restore === "undo")
        await f.owner.mutation(api.changes.undo, { changeId });
      else await setScenes(f, f.sceneIds.slice(0, 3));
      expect(await incoming()).toContain(f.sceneIds[2]);
      expect(await incoming()).toContain(f.locationIds[2]);
      const restored = await f.owner.query(api.boards.snapshot, {
        boardId: f.boardId,
      });
      expect(restored.choices.find((c) => c._id === chosenBefore!._id)).toEqual(
        chosenBefore,
      );
      expect(
        restored.entities.find((e) => e._id === f.planIds[0])!.data.sceneScope
          .sceneIds,
      ).toEqual(f.sceneIds.slice(0, 3));
      if (restore === "undo")
        expect(
          restored.entities.find((e) => e._id === f.scheduleIds[0])!.stale,
        ).toBe(false);
    },
  );

  it("keeps both selected schedules current when an excluded scene changes", async () => {
    const f = await fixture();
    const excluded = await f.t.run((ctx) => ctx.db.get(f.sceneIds[4]));
    await edit(
      f,
      excluded!._id,
      entitySchema.parse({
        ...excluded!.data,
        needs: ["A changed excluded-scene requirement"],
      }),
    );
    const snapshot = await f.owner.query(api.boards.snapshot, {
      boardId: f.boardId,
    });
    for (const scheduleId of f.scheduleIds)
      expect(snapshot.entities.find((e) => e._id === scheduleId)).toMatchObject(
        { stale: false, revision: 1 },
      );
    expect(
      snapshot.entities.find((e) => e._id === f.locationIds[4])!.stale,
    ).toBe(false);
    expect(snapshot.entities.find((e) => e._id === f.sceneIds[4])!.stale).toBe(
      true,
    );
  });

  it("invalidates both alternatives when their shared selected location is refreshed", async () => {
    const f = await fixture();
    const location = await f.t.run((ctx) => ctx.db.get(f.locationIds[0]));
    const runId = await f.owner.mutation(api.runs.start, {
      boardId: f.boardId,
      kind: "requirements",
      targetId: location!._id,
      scope: { kind: "scene", sceneId: f.sceneIds[0] },
    });
    expect(await f.t.mutation(internal.runs.claim, { runId, attempt: 1 })).toBe(
      true,
    );
    expect(
      await f.t.mutation(internal.runs.event, {
        runId,
        attempt: 1,
        sequence: 1,
        activity: "New location guidance",
        status: "complete",
        result: {
          locations: [
            {
              ...location!.data,
              restrictions: ["Newly retrieved access restriction"],
            },
          ],
        },
      }),
    ).toEqual({ accepted: true });
    const snapshot = await f.owner.query(api.boards.snapshot, {
      boardId: f.boardId,
    });
    for (const scheduleId of f.scheduleIds)
      expect(snapshot.entities.find((e) => e._id === scheduleId)!.stale).toBe(
        true,
      );
    expect(snapshot.choices).toHaveLength(10);
  });

  it("generates only one selected schedule, and supports three independent budget schedules", async () => {
    const f = await fixture("selected", true);
    const first = await f.owner.mutation(api.planning.startReadyPlans, {
      boardId: f.boardId,
      planIds: [f.planIds[0]],
    });
    expect(first).toHaveLength(1);
    expect(first[0].runId).toBeTruthy();
    const third = await f.t.run(async (ctx) => {
      const original = (await ctx.db.get(f.planIds[0]))!;
      const id = await putEntity(ctx, {
        boardId: f.boardId,
        actor: "test",
        logicalKey: "third-budget",
        scope: { kind: "workspace" },
        data: entitySchema.parse({
          ...original.data,
          name: "Budget three",
          budgetMinor: 1600000,
        }),
      });
      await ctx.db.patch(id, { scope: { kind: "plan", planId: id } });
      const second = (await ctx.db.get(f.planIds[1]))!;
      await ctx.db.patch(second._id, {
        data: {
          ...second.data,
          budgetMode: "fixed",
          budgetMinor: 1200000,
          priority: "cost",
        },
      });
      for (const choice of await ctx.db
        .query("choices")
        .withIndex("by_plan_scene", (q) => q.eq("planId", original._id))
        .collect()) {
        await ctx.db.insert("choices", {
          boardId: choice.boardId,
          planId: id,
          sceneId: choice.sceneId,
          locationId: choice.locationId,
          locked: choice.locked,
          revision: choice.revision,
        });
      }
      await syncPlanDependencies(ctx, (await ctx.db.get(id))!);
      return id;
    });
    const all = await f.owner.mutation(api.planning.startReadyPlans, {
      boardId: f.boardId,
      planIds: [...f.planIds, third],
    });
    expect(all).toHaveLength(3);
    expect(
      all.every((result) => result.runId && result.blockers.length === 0),
    ).toBe(true);
    expect(all[0].runId).toBe(first[0].runId);
    const snapshot = await f.owner.query(api.boards.snapshot, {
      boardId: f.boardId,
    });
    expect(snapshot.runs.filter((run) => run.kind === "schedule")).toHaveLength(
      3,
    );
  });

  it("queues two independent ready-plan jobs and deduplicates a repeated click", async () => {
    const f = await fixture("selected", true);
    const outcomes = await f.owner.mutation(api.planning.startReadyPlans, {
      boardId: f.boardId,
      planIds: f.planIds,
    });
    expect(
      outcomes.every((outcome) => outcome.runId && !outcome.blockers.length),
    ).toBe(true);
    expect(new Set(outcomes.map((outcome) => outcome.runId)).size).toBe(2);
    const duplicate = await f.owner.mutation(api.planning.startReadyPlans, {
      boardId: f.boardId,
      planIds: f.planIds,
    });
    expect(duplicate).toEqual(outcomes);
    const stored = await f.t.run(async (ctx) => ({
      runs: await ctx.db
        .query("runs")
        .withIndex("by_board", (q) => q.eq("boardId", f.boardId))
        .collect(),
      outbox: await ctx.db.query("outbox").collect(),
    }));
    expect(stored.runs).toHaveLength(2);
    expect(stored.runs.every((run) => run.status === "queued")).toBe(true);
    expect(new Set(stored.runs.map((run) => run.workKey)).size).toBe(2);
    expect(stored.outbox.map((item) => item.runId).sort()).toEqual(
      outcomes.map((outcome) => outcome.runId).sort(),
    );
    for (const outcome of outcomes) {
      expect(
        await f.t.mutation(internal.runs.claim, {
          runId: outcome.runId!,
          attempt: 1,
        }),
      ).toBe(true);
      const context = await f.t.query(internal.runs.context, {
        runId: outcome.runId!,
        attempt: 1,
      });
      expect(context.choices).toHaveLength(3);
      expect(
        context.choices.every((choice) => choice.planId === outcome.planId),
      ).toBe(true);
    }
  });

  it("keeps one plan's blockers independent while queuing the other", async () => {
    const f = await fixture();
    const plan = await f.t.run((ctx) => ctx.db.get(f.planIds[0]));
    await edit(
      f,
      plan!._id,
      entitySchema.parse({ ...plan!.data, budgetMinor: null }),
    );
    const outcomes = await f.owner.mutation(api.planning.startReadyPlans, {
      boardId: f.boardId,
      planIds: f.planIds,
    });
    expect(outcomes[0].runId).toBeUndefined();
    expect(outcomes[0].blockers).toContain(
      "Enter the Budget plan's fixed cap.",
    );
    expect(outcomes[1].runId).toBeTruthy();
    expect(outcomes[1].blockers).toEqual([]);
  });

  it("rejects an in-flight schedule after a location selection changes", async () => {
    const f = await fixture();
    const { runId, context } = await scheduleContext(f);
    await f.owner.mutation(api.planning.select, {
      boardId: f.boardId,
      planId: f.planIds[0],
      sceneId: f.sceneIds[0],
      locationId: f.alternateLocationId,
      locked: false,
      expectedRevision: 1,
    });
    const accepted = await f.t.mutation(internal.runs.event, {
      runId,
      attempt: 1,
      sequence: 1,
      activity: "Old schedule result",
      status: "complete",
      result: { schedule: context.schedule },
    });
    expect(accepted).toEqual({ accepted: false });
    expect((await f.t.run((ctx) => ctx.db.get(runId)))!.status).toBe(
      "superseded",
    );
    const snapshot = await f.owner.query(api.boards.snapshot, {
      boardId: f.boardId,
    });
    expect(
      snapshot.choices.find(
        (c) => c.planId === f.planIds[0] && c.sceneId === f.sceneIds[0],
      )!.locationId,
    ).toBe(f.alternateLocationId);
    expect(
      snapshot.entities.find((e) => e._id === f.scheduleIds[0])!.stale,
    ).toBe(true);
    expect(
      snapshot.entities.find((e) => e._id === f.scheduleIds[1])!.stale,
    ).toBe(false);
  });

  it.each(["before_callback", "before_apply"] as const)(
    "rejects a staged packet when its schedule changes %s",
    async (phase) => {
      const f = await fixture();
      const changeId = await stagedChange(f);
      const runId = await f.owner.mutation(api.runs.start, {
        boardId: f.boardId,
        kind: "packet",
        targetId: f.planIds[0],
        scope: { kind: "plan", planId: f.planIds[0] },
        changeId,
      });
      expect(
        await f.t.mutation(internal.runs.claim, { runId, attempt: 1 }),
      ).toBe(true);
      const packet = await f.t.run(async (ctx) => {
        const storageId = await ctx.storage.store(
          new Blob(["fixture PDF"], { type: "application/pdf" }),
        );
        const assetId = await ctx.db.insert("assets", {
          boardId: f.boardId,
          storageId,
          filename: "preparation.pdf",
          mime: "application/pdf",
          size: 11,
          createdBy: `agent:${runId}`,
          createdAt: Date.now(),
        });
        return entitySchema.parse({
          kind: "packet",
          planId: f.planIds[0],
          assetId,
          filename: "preparation.pdf",
          builtAt: Date.now(),
          unresolved: [],
          documentStatus: "draft",
          externalStatus: "not_submitted",
          sourceVersion: "captured-version",
          sourcePlanRevision: 1,
          sourceScheduleRevision: 1,
          includedSceneIds: f.sceneIds.slice(0, 3),
        });
      });
      const reviseSchedule = () =>
        f.t.run(async (ctx) => {
          const schedule = await ctx.db.get(f.scheduleIds[0]);
          await putEntity(ctx, {
            boardId: f.boardId,
            actor: f.userId,
            logicalKey: schedule!.logicalKey,
            scope: schedule!.scope,
            ownerId: f.planIds[0],
            data: entitySchema.parse({
              ...schedule!.data,
              explanation:
                "A newer schedule was applied while the packet was prepared.",
            }),
          });
        });
      if (phase === "before_callback") await reviseSchedule();
      const outcome = await f.t.mutation(internal.runs.event, {
        runId,
        attempt: 1,
        sequence: 1,
        activity: "Packet generated",
        status: "complete",
        result: { packet },
      });
      if (phase === "before_callback") {
        expect(outcome).toEqual({ accepted: false });
        expect((await f.t.run((ctx) => ctx.db.get(runId)))!.status).toBe(
          "superseded",
        );
      } else {
        expect(outcome).toEqual({ accepted: true });
        await f.t.mutation(internal.changes.advance, { changeId });
        await reviseSchedule();
        await expect(
          f.owner.mutation(api.changes.apply, { changeId }),
        ).rejects.toThrow("Inputs changed while this revision was generated");
      }
      expect(
        (
          await f.owner.query(api.boards.snapshot, { boardId: f.boardId })
        ).entities.some((entity) => entity.kind === "packet"),
      ).toBe(false);
    },
  );

  it("validates all staged research runs before publishing their shared location", async () => {
    const f = await fixture();
    const shared = await f.t.run(async (ctx) => {
      const old = await ctx.db.get(f.locationIds[0]);
      await putEntity(ctx, {
        boardId: f.boardId,
        actor: f.userId,
        logicalKey: old!.logicalKey,
        scope: old!.scope,
        ownerId: f.sceneIds[0],
        data: entitySchema.parse({
          ...old!.data,
          sceneIds: f.sceneIds.slice(0, 2),
        }),
      });
      await connect(ctx, f.boardId, f.sceneIds[1], old!._id, "candidate");
      return (await ctx.db.get(old!._id))!;
    });
    const changeId = await stagedChange(f, f.sceneIds[0]);
    const runIds: Id<"runs">[] = [];
    for (const sceneId of f.sceneIds.slice(0, 2)) {
      const runId = await f.owner.mutation(api.runs.start, {
        boardId: f.boardId,
        kind: "requirements",
        targetId: shared._id,
        scope: { kind: "scene", sceneId },
        changeId,
      });
      runIds.push(runId);
      expect(
        await f.t.mutation(internal.runs.claim, { runId, attempt: 1 }),
      ).toBe(true);
      expect(
        await f.t.mutation(internal.runs.event, {
          runId,
          attempt: 1,
          sequence: 1,
          activity: "Staged location guidance",
          status: "complete",
          result: {
            locations: [
              { ...shared.data, authority: `Updated guidance from ${sceneId}` },
            ],
          },
        }),
      ).toEqual({ accepted: true });
    }
    expect((await f.t.run((ctx) => ctx.db.get(shared._id)))!.revision).toBe(
      shared.revision,
    );
    await f.t.mutation(internal.changes.advance, { changeId });
    await f.owner.mutation(api.changes.apply, { changeId });
    const after = await f.t.run(async (ctx) => ({
      change: await ctx.db.get(changeId),
      location: await ctx.db.get(shared._id),
    }));
    expect(after.change!.status).toBe("applied");
    expect(after.change!.runIds).toEqual(runIds);
    expect(after.location!.revision).toBe(shared.revision + 2);
    expect(after.location!.data.sceneIds).toEqual(f.sceneIds.slice(0, 2));
  });
});
