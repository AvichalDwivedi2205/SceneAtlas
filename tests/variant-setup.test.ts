import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { entitySchema } from "../src/domain/model";
import { putEntity, updateEntity } from "../convex/lib/entities";

const modules = import.meta.glob("../convex/**/*.ts");
const identity = (name: string) => ({
  subject: name,
  tokenIdentifier: `https://clerk.test|${name}`,
  name,
});
const settings = {
  budgetMinor: 240000,
  idealShoot: "A small daylight shoot with natural coastal scenery.",
  dates: ["2026-11-14"],
  timezone: "America/Los_Angeles",
  dayStart: 480,
  dayEnd: 1080,
  moveMinutes: 30,
  setupMinutes: 15,
  timingBasis: "estimate" as const,
};

async function fixture(
  count = 3,
  question = false,
  modes: ("fixed" | "uncapped")[] = ["fixed", "uncapped"],
) {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity("variant-owner"));
  const userId = await owner.mutation(api.boards.initialize);
  const boardId = await owner.mutation(api.boards.create, {
    name: "Two production variants",
  });
  // Exercise the actual ingest publication callback without calling an external agent.
  const ingestId = await t.run((ctx) =>
    ctx.db.insert("runs", {
      boardId,
      kind: "ingest",
      scope: { kind: "workspace" },
      status: "queued",
      activity: "Queued",
      createdBy: userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      inputVersions: [],
      workKey: "fixture-ingest",
      attempt: 1,
      eventSequence: 0,
    }),
  );
  await t.mutation(internal.runs.claim, { runId: ingestId, attempt: 1 });
  await t.mutation(internal.runs.event, {
    runId: ingestId,
    attempt: 1,
    sequence: 1,
    activity: "Complete",
    status: "complete",
    result: {
      script: entitySchema.parse({
        kind: "script",
        filename: "shoot.pdf",
        pageCount: 3,
        summary: "Three scene shoot",
      }),
      questions: question
        ? [
            {
              data: entitySchema.parse({
                kind: "question",
                key: "crew-size",
                prompt: "How many cast and crew?",
                reason: "Production scale",
                suggestions: ["Ten people", "Not sure"],
                blocks: ["research"],
              }),
            },
          ]
        : [],
    },
  });
  const snapshot = () => owner.query(api.boards.snapshot, { boardId });
  const initial = await snapshot();
  const scriptId = initial.entities.find((e) => e.kind === "script")!._id;
  expect(initial.entities.filter((e) => e.kind === "plan")).toHaveLength(0);
  const planIds = modes.length
    ? await owner.mutation(api.variantSetup.createPlans, {
        boardId,
        plans: modes.map((budgetMode, index) => ({
          key: `fixture-${index}`,
          name:
            budgetMode === "fixed"
              ? index
                ? `Budget plan ${index + 1}`
                : "Budget plan"
              : "No fixed budget",
          budgetMode,
          budgetMinor: budgetMode === "fixed" ? (index + 1) * 250000 : null,
        })),
      })
    : [];
  const config = async () => ({
    boardId,
    ...settings,
    plans: (await snapshot()).entities
      .filter((e) => planIds.includes(e._id))
      .map((e) => ({ planId: e._id, expectedRevision: e.revision })),
  });
  const breakdown = async (sceneCount: number) => {
    const runId = await owner.mutation(api.runs.start, {
      boardId,
      kind: "scenes",
      targetId: scriptId,
      scope: { kind: "workspace" },
    });
    await t.mutation(internal.runs.claim, { runId, attempt: 1 });
    await t.mutation(internal.runs.event, {
      runId,
      attempt: 1,
      sequence: 1,
      activity: "Complete",
      status: "complete",
      result: {
        scenes: Array.from({ length: sceneCount }, (_, index) =>
          entitySchema.parse({
            kind: "scene",
            number: index + 1,
            heading: `EXT. COAST ${index + 1} - DAY`,
            excerpt: "A performer walks along the coast.",
            pageStart: index + 1,
            pageEnd: index + 1,
            setting: "Coast",
            interiorExterior: "EXT",
            timeOfDay: "DAY",
            needs: ["Public coastal access"],
          }),
        ),
      },
    });
    return (await snapshot()).entities
      .filter((e) => e.kind === "scene")
      .map((e) => e._id);
  };
  const sceneIds = count ? await breakdown(count) : [];
  return {
    t,
    owner,
    userId,
    boardId,
    scriptId,
    planIds,
    sceneIds,
    config,
    breakdown,
    snapshot,
  };
}

async function evidence(
  f: Awaited<ReturnType<typeof fixture>>,
  sceneId: Id<"entities">,
  runId: Id<"runs">,
) {
  await f.t.mutation(internal.runs.claim, { runId, attempt: 1 });
  await f.t.mutation(internal.runs.event, {
    runId,
    attempt: 1,
    sequence: 1,
    status: "complete",
    activity: "Complete",
    result: {
      locations: [
        entitySchema.parse({
          kind: "location",
          name: `Coastal candidate ${sceneId}`,
          address: "California",
          description: "Sourced public location",
          creativeFit: "Natural coast",
          authority: "Location authority",
          restrictions: [],
          costs: [],
          requirements: [],
          sceneIds: [sceneId],
          sources: [
            {
              url: "https://example.test/location",
              title: "Location evidence",
              excerpt: "Coastal access information",
              retrievedAt: Date.now(),
              provider: "parallel",
            },
          ],
        }),
      ],
    },
  });
}

describe("initial variant setup", () => {
  it("creates alternatives with their selected scenes and rejects foreign or empty scope atomically", async () => {
    const f = await fixture(3, false, []);
    const plan = {
      key: "scope-plan",
      name: "Three-scene locations",
      budgetMode: "fixed" as const,
      budgetMinor: 250000,
      sceneScope: {
        mode: "selected" as const,
        sceneIds: f.sceneIds.slice(0, 2),
      },
    };
    const [id] = await f.owner.mutation(api.variantSetup.createPlans, {
      boardId: f.boardId,
      plans: [plan],
    });
    const saved = (await f.snapshot()).entities.find((e) => e._id === id)!;
    expect(saved.data.sceneScope).toEqual(plan.sceneScope);
    expect(saved.data.budgetMinor).toBe(250000);
    await expect(
      f.owner.mutation(api.variantSetup.createPlans, {
        boardId: f.boardId,
        plans: [
          {
            ...plan,
            key: "empty",
            sceneScope: { mode: "selected", sceneIds: [] },
          },
        ],
      }),
    ).rejects.toThrow("at least one scene");
    const otherBoard = await f.owner.mutation(api.boards.create, {
      name: "Other screenplay",
    });
    const foreignSceneId = await f.t.run((ctx) =>
      putEntity(ctx, {
        boardId: otherBoard,
        actor: f.userId,
        logicalKey: "foreign-scene",
        scope: { kind: "workspace" },
        data: entitySchema.parse({
          kind: "scene",
          number: 1,
          heading: "EXT. OTHER - DAY",
          excerpt: "Other scene",
          pageStart: 1,
          pageEnd: 1,
          setting: "Other",
          interiorExterior: "EXT",
          timeOfDay: "DAY",
          needs: [],
        }),
      }),
    );
    await expect(
      f.owner.mutation(api.variantSetup.createPlans, {
        boardId: f.boardId,
        plans: [
          { ...plan, key: "valid-new" },
          {
            ...plan,
            key: "foreign",
            sceneScope: { mode: "selected", sceneIds: [foreignSceneId] },
          },
        ],
      }),
    ).rejects.toThrow("workspace");
    expect(
      (await f.snapshot()).entities.filter((e) => e.kind === "plan"),
    ).toHaveLength(1);
    await expect(
      f.owner.mutation(api.variantSetup.createPlans, {
        boardId: f.boardId,
        plans: [{ ...plan, sceneScope: { mode: "all", sceneIds: [] } }],
      }),
    ).rejects.toThrow("different settings");
  });
  it.each([
    ["fixed"],
    ["uncapped"],
    ["fixed", "fixed", "fixed"],
    ["fixed", "fixed", "uncapped"],
  ] as ("fixed" | "uncapped")[][])(
    "configures exactly the selected modes %j and shares research without adding branches",
    async (...modes) => {
      const f = await fixture(1, false, modes);
      const before = await f.snapshot();
      const caps = before.entities
        .filter((e) => e.kind === "plan")
        .map((e) => e.data.budgetMinor);
      const input = { ...(await f.config()), budgetMinor: undefined };
      await f.owner.mutation(api.variantSetup.configure, {
        ...input,
        sceneIds: f.sceneIds,
        durationMinutes: 45,
        applyTimeWindows: true,
      });
      const jobs = await f.owner.mutation(api.variantSetup.startResearch, {
        boardId: f.boardId,
        planIds: f.planIds,
      });
      expect(jobs).toHaveLength(1);
      const after = await f.snapshot();
      expect(
        after.entities
          .filter((e) => e.kind === "plan")
          .map((e) => e.data.budgetMode),
      ).toEqual(modes);
      expect(
        after.entities
          .filter((e) => e.kind === "plan")
          .map((e) => e.data.budgetMinor),
      ).toEqual(caps);
      expect(after.runs.filter((r) => r.kind === "research")).toHaveLength(1);
    },
  );

  it("creates no plans during import or breakdown; explicit creation is retry-safe and all-or-nothing", async () => {
    const f = await fixture(2, false, []);
    const selected = {
      key: "chosen-budget",
      name: "Lean shoot",
      budgetMode: "fixed" as const,
      budgetMinor: 250000,
    };
    const before = await f.snapshot();
    expect(before.entities.some((e) => e.kind === "plan")).toBe(false);
    await expect(
      f.owner.mutation(api.variantSetup.createPlans, {
        boardId: f.boardId,
        plans: [selected, { ...selected, key: "bad", budgetMinor: 0 }],
      }),
    ).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);
    for (const plans of [
      [],
      [selected, selected],
      [{ ...selected, budgetMode: "uncapped" as const }],
    ])
      await expect(
        f.owner.mutation(api.variantSetup.createPlans, {
          boardId: f.boardId,
          plans,
        }),
      ).rejects.toThrow();
    const ids = await f.owner.mutation(api.variantSetup.createPlans, {
      boardId: f.boardId,
      plans: [selected],
    });
    const saved = await f.snapshot();
    expect(
      await f.owner.mutation(api.variantSetup.createPlans, {
        boardId: f.boardId,
        plans: [selected],
      }),
    ).toEqual(ids);
    const after = await f.snapshot();
    expect(after.entities).toEqual(saved.entities);
    expect(after.entities.filter((e) => e.kind === "plan")).toHaveLength(1);
    expect(after.runs).toEqual(before.runs);
    expect(
      after.edges.filter(
        (e) => e.sourceId === f.scriptId && ids.includes(e.targetId),
      ),
    ).toHaveLength(1);
  });

  it("adds a budget branch after work starts without copying choices or changing existing plans", async () => {
    const f = await fixture(1, false, ["fixed"]);
    await f.owner.mutation(api.variantSetup.configure, {
      ...(await f.config()),
      sceneIds: f.sceneIds,
      durationMinutes: 45,
      applyTimeWindows: true,
    });
    const [job] = await f.owner.mutation(api.variantSetup.startResearch, {
      boardId: f.boardId,
      planIds: f.planIds,
    });
    await evidence(f, f.sceneIds[0], job.runId);
    const candidate = (await f.snapshot()).entities.find(
      (e) => e.kind === "location",
    )!;
    await f.owner.mutation(api.planning.select, {
      boardId: f.boardId,
      planId: f.planIds[0],
      sceneId: f.sceneIds[0],
      locationId: candidate._id,
      locked: true,
      expectedRevision: 0,
    });
    const before = await f.snapshot();
    const [added] = await f.owner.mutation(api.variantSetup.createPlans, {
      boardId: f.boardId,
      plans: [
        {
          key: "expanded",
          name: "Expanded shoot",
          budgetMode: "fixed",
          budgetMinor: 1000000,
        },
      ],
    });
    const after = await f.snapshot();
    expect(after.choices).toEqual(before.choices);
    expect(after.entities.filter((e) => f.planIds.includes(e._id))).toEqual(
      before.entities.filter((e) => f.planIds.includes(e._id)),
    );
    expect(after.entities.find((e) => e._id === added)!.data).toMatchObject({
      name: "Expanded shoot",
      budgetMinor: 1000000,
      dates: settings.dates,
      sceneScope: { mode: "selected", sceneIds: f.sceneIds },
    });
    expect(after.choices.some((c) => c.planId === added)).toBe(false);
  });

  it("rejects plan creation without membership or a screenplay", async () => {
    const f = await fixture(0, false, []);
    const plans = [
      {
        key: "one",
        name: "One",
        budgetMode: "uncapped" as const,
        budgetMinor: null,
      },
    ];
    const outsider = f.t.withIdentity(identity("outsider"));
    await outsider.mutation(api.boards.initialize);
    await expect(
      outsider.mutation(api.variantSetup.createPlans, {
        boardId: f.boardId,
        plans,
      }),
    ).rejects.toThrow();
    const empty = await f.owner.mutation(api.boards.create, { name: "Empty" });
    await expect(
      f.owner.mutation(api.variantSetup.createPlans, { boardId: empty, plans }),
    ).rejects.toThrow("Upload a screenplay");
  });

  it("creates only explicitly selected children and preserves their configured data, revisions and positions through breakdown", async () => {
    const f = await fixture(0, true);
    const initial = await f.snapshot();
    const plans = initial.entities.filter((e) => e.kind === "plan");
    expect(plans.map((p) => p.logicalKey).sort()).toEqual([
      "plan:user:fixture-0",
      "plan:user:fixture-1",
    ]);
    expect(plans.map((p) => p.data.name)).toEqual([
      "Budget plan",
      "No fixed budget",
    ]);
    expect(
      initial.edges.filter(
        (e) => e.sourceId === f.scriptId && f.planIds.includes(e.targetId),
      ),
    ).toHaveLength(2);
    const question = initial.entities.find((e) => e.kind === "question")!;
    await f.owner.mutation(api.variantSetup.configure, {
      ...(await f.config()),
      answers: [
        {
          entityId: question._id,
          expectedRevision: question.revision,
          answer: "Ten people",
        },
      ],
    });
    const before = await f.snapshot();
    await f.breakdown(3);
    const after = await f.snapshot();
    expect(after.entities.filter((e) => e.kind === "plan")).toEqual(
      before.entities.filter((e) => e.kind === "plan"),
    );
    expect(after.nodes.filter((n) => f.planIds.includes(n.entityId))).toEqual(
      before.nodes.filter((n) => f.planIds.includes(n.entityId)),
    );
    expect(
      after.edges.filter(
        (e) =>
          f.planIds.includes(e.targetId) &&
          after.entities.some(
            (s) => s._id === e.sourceId && s.kind === "scene",
          ),
      ),
    ).toHaveLength(6);
    const answer = after.entities.find((e) => e.kind === "answer")!;
    expect(answer.data).toMatchObject({
      original: "Ten people",
      resolution: "answered",
      rule: null,
    });
    expect(after.entities.find((e) => e._id === question._id)!.revision).toBe(
      2,
    );
    expect(before.entities.find((e) => e._id === f.scriptId)!.revision).toBe(
      initial.entities.find((e) => e._id === f.scriptId)!.revision + 1,
    );
    expect(after.entities.find((e) => e._id === f.scriptId)!.revision).toBe(
      before.entities.find((e) => e._id === f.scriptId)!.revision,
    );
    const versions = await f.t.run((ctx) => ctx.db.query("versions").collect());
    expect(
      versions
        .filter((v) => v.entityId === question._id)
        .map((v) => v.revision),
    ).toEqual([1, 2]);
  });

  it("shares explicit scene scope and estimated duration, and changes windows only on confirmation", async () => {
    const f = await fixture();
    const chosen = f.sceneIds.slice(0, 2);
    await f.owner.mutation(api.variantSetup.configure, {
      ...(await f.config()),
      sceneIds: chosen,
      durationMinutes: 45,
    });
    let snapshot = await f.snapshot();
    for (const plan of snapshot.entities.filter((e) => e.kind === "plan")) {
      expect(plan.data.sceneScope).toEqual({
        mode: "selected",
        sceneIds: chosen,
      });
      expect(plan.data.budgetMinor).toBe(
        plan.data.budgetMode === "fixed" ? settings.budgetMinor : null,
      );
      expect(plan.data.idealShoot).toBe(settings.idealShoot);
    }
    for (const scene of snapshot.entities.filter((e) => chosen.includes(e._id)))
      expect(scene.data).toMatchObject({
        durationMinutes: 45,
        durationBasis: "estimate",
        windows: [],
      });
    expect(
      snapshot.entities.find((e) => e._id === f.sceneIds[2])!.revision,
    ).toBe(1);
    await f.owner.mutation(api.variantSetup.configure, {
      ...(await f.config()),
      applyTimeWindows: true,
    });
    snapshot = await f.snapshot();
    for (const scene of snapshot.entities.filter((e) => chosen.includes(e._id)))
      expect(scene.data.windows).toEqual([
        { date: settings.dates[0], start: 480, end: 1080 },
      ]);
    expect(
      snapshot.entities.find((e) => e._id === f.sceneIds[2])!.data.windows,
    ).toEqual([]);
    expect(
      snapshot.entities
        .filter((e) => e.kind === "plan")
        .every((p) => p.data.sceneScope.sceneIds.length === 2),
    ).toBe(true);
  });

  it.each([
    ["budget", { budgetMinor: 0 }],
    ["timezone", { timezone: "Invalid/Timezone" }],
    ["date", { dates: ["2026-02-31"] }],
    ["window", { dayEnd: 470 }],
    ["duration", { durationMinutes: -1 }],
    [
      "unknown duration",
      {
        durationMinutes: 45,
        timingBasis: "unknown" as const,
        moveMinutes: null,
        setupMinutes: null,
      },
    ],
  ])("rolls back both variants for invalid %s", async (_name, invalid) => {
    const f = await fixture();
    const before = await f.snapshot();
    await expect(
      f.owner.mutation(api.variantSetup.configure, {
        ...(await f.config()),
        ...invalid,
      }),
    ).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);
  });

  it("rejects stale plan or answer revisions before any plan, scene or answer writes", async () => {
    const f = await fixture(3, true);
    const before = await f.snapshot();
    const valid = await f.config();
    await expect(
      f.owner.mutation(api.variantSetup.configure, {
        ...valid,
        plans: [valid.plans[0], { ...valid.plans[1], expectedRevision: 0 }],
        durationMinutes: 60,
      }),
    ).rejects.toThrow("Someone changed");
    const question = before.entities.find((e) => e.kind === "question")!;
    await expect(
      f.owner.mutation(api.variantSetup.configure, {
        ...valid,
        durationMinutes: 60,
        answers: [
          { entityId: question._id, expectedRevision: 0, answer: "Ten" },
        ],
      }),
    ).rejects.toThrow("Someone changed");
    expect(await f.snapshot()).toEqual(before);
  });

  it("rejects cross-board plans, scenes and answers and viewer writes", async () => {
    const f = await fixture();
    const otherBoard = await f.owner.mutation(api.boards.create, {
      name: "Other production",
    });
    const foreign = await f.t.run(async (ctx) => {
      const ids: Id<"entities">[] = [];
      for (const entity of (await ctx.db.query("entities").collect()).filter(
        (e) => ["plan", "scene"].includes(e.kind),
      ))
        ids.push(
          await putEntity(ctx, {
            boardId: otherBoard,
            logicalKey: `foreign:${entity._id}`,
            scope: { kind: "workspace" },
            data: entity.data,
            actor: f.userId,
          }),
        );
      ids.push(
        await putEntity(ctx, {
          boardId: otherBoard,
          logicalKey: "foreign:question",
          scope: { kind: "workspace" },
          actor: f.userId,
          data: entitySchema.parse({
            kind: "question",
            key: "crew",
            prompt: "Crew?",
            reason: "Scale",
            suggestions: [],
            blocks: [],
          }),
        }),
      );
      return Promise.all(ids.map((id) => ctx.db.get(id)));
    });
    const input = await f.config();
    const foreignPlan = foreign.find((e) => e!.kind === "plan")!;
    const foreignScene = foreign.find((e) => e!.kind === "scene")!;
    const foreignQuestion = foreign.find((e) => e!.kind === "question")!;
    const before = await f.snapshot();
    for (const invalid of [
      {
        plans: [
          input.plans[0],
          { planId: foreignPlan._id, expectedRevision: 1 },
        ],
      },
      { sceneIds: [foreignScene._id] },
      {
        answers: [
          { entityId: foreignQuestion._id, expectedRevision: 1, answer: "Ten" },
        ],
      },
    ])
      await expect(
        f.owner.mutation(api.variantSetup.configure, { ...input, ...invalid }),
      ).rejects.toThrow();
    const viewer = f.t.withIdentity(identity("variant-viewer"));
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
      viewer.mutation(api.variantSetup.configure, input),
    ).rejects.toThrow("access");
    await expect(
      viewer.mutation(api.variantSetup.startResearch, {
        boardId: f.boardId,
        planIds: f.planIds,
      }),
    ).rejects.toThrow("access");
    expect(await f.snapshot()).toEqual(before);
  });

  it("keeps Not sure as a blocker and audits corrections before research begins", async () => {
    const f = await fixture(1, true);
    let question = (await f.snapshot()).entities.find(
      (e) => e.kind === "question",
    )!;
    await f.owner.mutation(api.variantSetup.configure, {
      ...(await f.config()),
      answers: [
        { entityId: question._id, expectedRevision: 1, answer: "Not sure" },
      ],
    });
    expect(
      (await f.snapshot()).entities.find((e) => e.kind === "answer")!.data
        .resolution,
    ).toBe("unknown");
    await expect(
      f.owner.mutation(api.variantSetup.startResearch, {
        boardId: f.boardId,
        planIds: f.planIds,
      }),
    ).rejects.toThrow("Answer first");
    question = (await f.snapshot()).entities.find(
      (e) => e.kind === "question",
    )!;
    await f.owner.mutation(api.variantSetup.configure, {
      ...(await f.config()),
      answers: [
        {
          entityId: question._id,
          expectedRevision: question.revision,
          answer: "Ten people",
        },
      ],
    });
    expect(
      (await f.snapshot()).entities.filter(
        (e) => e.kind === "answer" && e.data.questionId === question._id,
      ),
    ).toHaveLength(1);
    expect(
      (await f.snapshot()).entities.find((e) => e.kind === "answer")!.revision,
    ).toBe(2);
    await f.owner.mutation(api.variantSetup.startResearch, {
      boardId: f.boardId,
      planIds: f.planIds,
    });
    await expect(
      f.owner.mutation(api.variantSetup.configure, await f.config()),
    ).rejects.toThrow("revision flow");
  });
});

describe("shared variant research", () => {
  it("passes the exact durable creative brief to actual research context and keeps its answer history", async () => {
    const f = await fixture(1);
    await f.owner.mutation(api.variantSetup.configure, await f.config());
    const creativeBefore = (await f.snapshot()).entities.find(
      (e) => e.logicalKey === "variant:creative-brief",
    )!;
    const brief =
      "  Use natural coastline, soft daylight, and an intimate crew.\nPreserve wheelchair access.  ";
    await f.owner.mutation(api.variantSetup.configure, {
      ...(await f.config()),
      idealShoot: brief,
    });
    const snapshot = await f.snapshot();
    const creative = snapshot.entities.find(
      (e) => e.logicalKey === "variant:creative-brief",
    )!;
    expect(creative._id).toBe(creativeBefore._id);
    expect(creative.revision).toBe(creativeBefore.revision + 1);
    expect(creative).toMatchObject({
      ownerId: f.scriptId,
      scope: { kind: "workspace" },
      data: { answer: brief, resolution: "answered", rule: null },
    });
    expect(
      snapshot.entities
        .filter((e) => e.kind === "plan")
        .every((p) => p.data.idealShoot === brief),
    ).toBe(true);
    const answer = snapshot.entities.filter(
      (e) => e.kind === "answer" && e.data.questionId === creative._id,
    );
    expect(answer).toHaveLength(1);
    expect(answer[0]).toMatchObject({
      revision: 2,
      data: { original: brief, resolution: "answered", rule: null },
    });
    const [job] = await f.owner.mutation(api.variantSetup.startResearch, {
      boardId: f.boardId,
      planIds: f.planIds,
    });
    await f.t.mutation(internal.runs.claim, { runId: job.runId, attempt: 1 });
    const context = await f.t.query(internal.runs.context, {
      runId: job.runId,
      attempt: 1,
    });
    expect(
      context.entities.find((e) => e._id === creative._id)?.data.answer,
    ).toBe(brief);
    const run = await f.t.run((ctx) => ctx.db.get(job.runId));
    expect(run!.inputVersions).toContainEqual({
      id: creative._id,
      revision: creative.revision,
    });
  });

  it("queues one job per included scene, excludes unrelated blockers and joins the same queued jobs on retry", async () => {
    const f = await fixture();
    await f.owner.mutation(api.variantSetup.configure, {
      ...(await f.config()),
      sceneIds: f.sceneIds.slice(0, 2),
    });
    await f.t.run((ctx) =>
      putEntity(ctx, {
        boardId: f.boardId,
        actor: f.userId,
        logicalKey: "excluded:blocker",
        ownerId: f.sceneIds[2],
        scope: { kind: "scene", sceneId: f.sceneIds[2] },
        data: entitySchema.parse({
          kind: "question",
          key: "excluded",
          prompt: "Excluded activity?",
          reason: "Scope",
          suggestions: [],
          blocks: ["research"],
        }),
      }),
    );
    const args = { boardId: f.boardId, planIds: f.planIds };
    const first = await f.owner.mutation(api.variantSetup.startResearch, args);
    expect(first).toHaveLength(2);
    expect(first.every((o) => o.status === "queued")).toBe(true);
    const second = await f.owner.mutation(api.variantSetup.startResearch, args);
    expect(second.map((o) => o.runId)).toEqual(first.map((o) => o.runId));
    expect(second.every((o) => o.status === "active")).toBe(true);
    const research = (await f.snapshot()).runs.filter(
      (r) => r.kind === "research",
    );
    expect(research).toHaveLength(2);
    expect(
      research.every((r) => r.scope.kind === "scene" && !r.scope.planId),
    ).toBe(true);
    expect(new Set(research.map((r) => r.targetId))).toEqual(
      new Set(f.sceneIds.slice(0, 2)),
    );
  });

  it("reuses compatible complete evidence and queues fresh research when producer inputs change", async () => {
    const f = await fixture(1);
    const args = { boardId: f.boardId, planIds: f.planIds };
    const first = await f.owner.mutation(api.variantSetup.startResearch, args);
    await evidence(f, f.sceneIds[0], first[0].runId);
    expect(
      await f.owner.mutation(api.variantSetup.startResearch, args),
    ).toEqual([
      { sceneId: f.sceneIds[0], runId: first[0].runId, status: "reused" },
    ]);
    await f.t.run(async (ctx) => {
      const scene = (await ctx.db.get(f.sceneIds[0]))!;
      await updateEntity(
        ctx,
        scene,
        entitySchema.parse({
          ...scene.data,
          needs: ["Wheelchair-accessible coastline"],
        }),
        f.userId,
        undefined,
        true,
      );
    });
    const next = await f.owner.mutation(api.variantSetup.startResearch, args);
    expect(next[0].status).toBe("queued");
    expect(next[0].runId).not.toBe(first[0].runId);
  });

  it("rejects empty or different scene selections and duplicate plans", async () => {
    const f = await fixture(2);
    const args = { boardId: f.boardId, planIds: f.planIds };
    await expect(
      f.owner.mutation(api.variantSetup.startResearch, {
        ...args,
        planIds: [f.planIds[0], f.planIds[0]],
      }),
    ).rejects.toThrow("duplicates");
    await f.owner.mutation(api.variantSetup.configure, {
      ...(await f.config()),
      sceneIds: [],
    });
    await expect(
      f.owner.mutation(api.variantSetup.startResearch, args),
    ).rejects.toThrow("nonempty");
    await f.t.run(async (ctx) => {
      const plan = (await ctx.db.get(f.planIds[0]))!;
      await updateEntity(
        ctx,
        plan,
        entitySchema.parse({
          ...plan.data,
          sceneScope: { mode: "selected", sceneIds: [f.sceneIds[0]] },
        }),
        f.userId,
      );
    });
    await expect(
      f.owner.mutation(api.variantSetup.startResearch, args),
    ).rejects.toThrow("same nonempty");
    expect(
      (await f.snapshot()).runs.filter((r) => r.kind === "research"),
    ).toHaveLength(0);
  });

  it("prevalidates all selected blockers without creating a partial queue", async () => {
    const f = await fixture(3);
    await f.t.run((ctx) =>
      putEntity(ctx, {
        boardId: f.boardId,
        actor: f.userId,
        logicalKey: "included:blocker",
        ownerId: f.sceneIds[2],
        scope: { kind: "scene", sceneId: f.sceneIds[2] },
        data: entitySchema.parse({
          kind: "question",
          key: "activity",
          prompt: "Water entry?",
          reason: "Safety",
          suggestions: [],
          blocks: ["research"],
        }),
      }),
    );
    await expect(
      f.owner.mutation(api.variantSetup.startResearch, {
        boardId: f.boardId,
        planIds: f.planIds,
      }),
    ).rejects.toThrow("Water entry?");
    expect(
      (await f.snapshot()).runs.filter((r) => r.kind === "research"),
    ).toHaveLength(0);
  });

  it("respects an unresolved question on either selected variant", async () => {
    const f = await fixture(1);
    await f.t.run((ctx) =>
      putEntity(ctx, {
        boardId: f.boardId,
        actor: f.userId,
        logicalKey: "variant:activity-blocker",
        ownerId: f.planIds[1],
        scope: { kind: "plan", planId: f.planIds[1] },
        data: entitySchema.parse({
          kind: "question",
          key: "activity",
          prompt: "Will this variant enter the water?",
          reason: "Production activity",
          suggestions: [],
          blocks: ["research"],
        }),
      }),
    );
    await expect(
      f.owner.mutation(api.variantSetup.startResearch, {
        boardId: f.boardId,
        planIds: f.planIds,
      }),
    ).rejects.toThrow("enter the water");
    expect(
      (await f.snapshot()).runs.filter((r) => r.kind === "research"),
    ).toHaveLength(0);
  });

  it("enforces the active limit atomically and permits a bounded subset", async () => {
    const f = await fixture(9);
    const args = { boardId: f.boardId, planIds: f.planIds };
    await expect(
      f.owner.mutation(api.variantSetup.startResearch, args),
    ).rejects.toThrow("9 new tasks, but 8");
    expect(
      (await f.snapshot()).runs.filter((r) => r.kind === "research"),
    ).toHaveLength(0);
    await f.owner.mutation(api.variantSetup.configure, {
      ...(await f.config()),
      sceneIds: f.sceneIds.slice(0, 8),
    });
    expect(
      await f.owner.mutation(api.variantSetup.startResearch, args),
    ).toHaveLength(8);
    expect(
      (await f.snapshot()).runs.filter(
        (r) => r.kind === "research" && r.status === "queued",
      ),
    ).toHaveLength(8);
  });

  it("does not race another branch's already active research for the same scene", async () => {
    const f = await fixture(1);
    await f.owner.mutation(api.runs.start, {
      boardId: f.boardId,
      kind: "research",
      targetId: f.sceneIds[0],
      scope: {
        kind: "plan_scene",
        sceneId: f.sceneIds[0],
        planId: f.planIds[0],
      },
    });
    await expect(
      f.owner.mutation(api.variantSetup.startResearch, {
        boardId: f.boardId,
        planIds: f.planIds,
      }),
    ).rejects.toThrow("already has research in progress");
    expect(
      (await f.snapshot()).runs.filter((r) => r.kind === "research"),
    ).toHaveLength(1);
  });

  it("counts other active work and the hourly limit before enqueueing any shared jobs", async () => {
    const f = await fixture(2);
    const otherRuns = await f.t.run(async (ctx) => {
      const ids: Id<"runs">[] = [];
      for (let i = 0; i < 7; i++)
        ids.push(
          await ctx.db.insert("runs", {
            boardId: f.boardId,
            kind: "chat",
            scope: { kind: "workspace" },
            status: "queued",
            activity: "Queued",
            createdBy: f.userId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            inputVersions: [],
            workKey: `capacity:${i}`,
            attempt: 1,
            eventSequence: 0,
          }),
        );
      return ids;
    });
    const args = { boardId: f.boardId, planIds: f.planIds };
    await expect(
      f.owner.mutation(api.variantSetup.startResearch, args),
    ).rejects.toThrow("2 new tasks, but 1");
    await f.t.run(async (ctx) => {
      for (const id of otherRuns)
        await ctx.db.patch(id, { status: "complete" });
      for (let i = 0; i < 50; i++)
        await ctx.db.insert("runs", {
          boardId: f.boardId,
          kind: "chat",
          scope: { kind: "workspace" },
          status: "complete",
          activity: "Complete",
          createdBy: f.userId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          inputVersions: [],
          workKey: `hourly:${i}`,
          attempt: 1,
          eventSequence: 0,
        });
    });
    await expect(
      f.owner.mutation(api.variantSetup.startResearch, args),
    ).rejects.toThrow("hourly agent limit");
    expect(
      (await f.snapshot()).runs.filter((r) => r.kind === "research"),
    ).toHaveLength(0);
  });
});
