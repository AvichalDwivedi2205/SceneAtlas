import { describe, expect, it } from "vitest";
import {
  entitySchema,
  type BoardSnapshot,
  type Entity,
  type EntityData,
  type Scope,
} from "../src/domain/model";
import { packetReadiness } from "../src/domain/packet";

function entity(
  id: string,
  data: unknown,
  scope: Scope = { kind: "workspace" },
): Entity {
  return {
    _id: id,
    boardId: "board",
    data: entitySchema.parse(data),
    scope,
    revision: 1,
    stale: false,
    createdAt: 1,
    updatedAt: 1,
    updatedBy: "producer",
    logicalKey: id,
  };
}

function fixture(): BoardSnapshot {
  const source = {
    url: "https://example.com/film",
    title: "Filming guidance",
    excerpt: "Contact for fees",
    retrievedAt: 1,
    provider: "official",
  };
  return {
    board: {
      _id: "board",
      name: "Production",
      ownerId: "producer",
      archived: false,
    },
    role: "owner",
    me: { _id: "producer", name: "Producer" },
    nodes: [],
    edges: [],
    runs: [],
    choices: [
      {
        planId: "plan",
        sceneId: "scene",
        locationId: "location",
        locked: true,
        revision: 1,
      },
    ],
    entities: [
      entity(
        "plan",
        {
          kind: "plan",
          name: "Day 1",
          budgetMode: "fixed",
          budgetMinor: 100000,
          priority: "cost",
          dates: ["2026-10-01"],
          moveMinutes: 30,
          setupMinutes: 15,
          timingBasis: "confirmed",
          sceneScope: { mode: "selected", sceneIds: ["scene"] },
        },
        { kind: "plan", planId: "plan" },
      ),
      entity(
        "scene",
        {
          kind: "scene",
          number: 1,
          heading: "EXT. COAST - DAY",
          setting: "Coast",
          excerpt: "A rehearsal",
          pageStart: 1,
          pageEnd: 3,
          interiorExterior: "EXT",
          timeOfDay: "DAY",
          needs: [],
          durationMinutes: 90,
          durationBasis: "estimate",
          windows: [{ date: "2026-10-01", start: 480, end: 1080 }],
        },
        { kind: "scene", sceneId: "scene" },
      ),
      entity("location", {
        kind: "location",
        name: "Coast",
        address: "Coast road",
        description: "Open sea",
        creativeFit: "Sea view",
        restrictions: [],
        authority: "Site manager",
        sources: [source],
        costs: [],
        requirements: [],
        sceneIds: ["scene"],
      }),
      entity(
        "schedule",
        {
          kind: "schedule",
          planId: "plan",
          entries: [
            {
              sceneId: "scene",
              sceneNumber: 1,
              locationId: "location",
              locationName: "Coast",
              date: "2026-10-01",
              start: 495,
              end: 585,
              durationBasis: "estimate",
              reason: "Fits saved window",
            },
          ],
          conflicts: [],
          provisional: true,
          moves: 0,
          days: 1,
          explanation: "Saved order",
        },
        { kind: "plan", planId: "plan" },
      ),
    ],
  };
}

function setData(record: Entity, changes: object) {
  record.data = { ...record.data, ...changes } as EntityData;
}

describe("saved packet readiness", () => {
  it("allows a preparation draft with unquoted costs and unverified external availability", () => {
    const ready = packetReadiness(fixture(), "plan")!;
    expect(ready.canBuild).toBe(true);
    expect(ready.costs.unknown).toHaveLength(1);
    expect(ready.costs.budgetStatus).toBe("unconfirmed");
    expect(ready.externalFollowups.join(" ")).toContain("Confirm availability");
    expect(ready.checks.find((check) => check.key === "costs")?.state).toBe(
      "unverified",
    );
    expect(ready.checks.find((check) => check.key === "packet")?.state).toBe(
      "needs_input",
    );
  });

  it("omits excluded scenes and their required questions", () => {
    const snapshot = fixture();
    snapshot.entities.push(
      entity(
        "excluded",
        {
          ...snapshot.entities[1].data,
          number: 202,
          durationMinutes: null,
          durationBasis: "unknown",
          windows: [],
        },
        { kind: "scene", sceneId: "excluded" },
      ),
    );
    snapshot.entities.push(
      entity(
        "excluded-question",
        {
          kind: "question",
          key: "casting",
          prompt: "Excluded casting",
          reason: "Needed",
          suggestions: [],
          blocks: ["packet"],
        },
        { kind: "scene", sceneId: "excluded" },
      ),
    );
    const ready = packetReadiness(snapshot, "plan")!;
    expect(ready.canBuild).toBe(true);
    expect(ready.scenes.map((scene) => scene._id)).toEqual(["scene"]);
    expect(ready.questions).toEqual([]);
  });

  it("does not expand an explicit empty scope, including a legacy packet", () => {
    const snapshot = fixture();
    setData(snapshot.entities[0], {
      sceneScope: { mode: "selected", sceneIds: [] },
    });
    const ready = packetReadiness(snapshot, "plan")!;
    expect(ready.canBuild).toBe(false);
    expect(ready.scenes).toEqual([]);
    expect(ready.assignments).toEqual([]);
    expect(ready.productionInputs.join(" ")).toContain("Choose scenes");
  });

  it("keeps missing production decisions separate from external follow-ups", () => {
    const snapshot = fixture();
    snapshot.entities.push(
      entity("crew", {
        kind: "question",
        key: "crew",
        prompt: "Confirm crew",
        reason: "Needed",
        suggestions: [],
        blocks: ["packet"],
      }),
    );
    const ready = packetReadiness(snapshot, "plan")!;
    expect(ready.canBuild).toBe(false);
    expect(ready.productionInputs.join(" ")).toContain("Confirm crew");
    expect(ready.externalFollowups.join(" ")).not.toContain("Confirm crew");
  });

  it.each(["stale", "wrong location", "duplicate", "missing"])(
    "blocks a %s schedule",
    (issue) => {
      const snapshot = fixture();
      const schedule = snapshot.entities[3];
      if (issue === "stale") schedule.stale = true;
      if (schedule.data.kind === "schedule") {
        if (issue === "wrong location")
          schedule.data.entries[0].locationId = "unselected";
        if (issue === "duplicate")
          schedule.data.entries.push({ ...schedule.data.entries[0] });
        if (issue === "missing") schedule.data.entries = [];
      }
      expect(packetReadiness(snapshot, "plan")!.canBuild).toBe(false);
    },
  );

  it("marks an old plan or schedule version historical even if the stale flag is absent", () => {
    const snapshot = fixture();
    snapshot.entities.push(
      entity(
        "packet",
        {
          kind: "packet",
          planId: "plan",
          assetId: "pdf",
          filename: "packet.pdf",
          builtAt: 1,
          unresolved: [],
          documentStatus: "draft",
          externalStatus: "not_submitted",
          sourceVersion: "version",
          sourcePlanRevision: 1,
          sourceScheduleRevision: 1,
          includedSceneIds: ["scene"],
        },
        { kind: "plan", planId: "plan" },
      ),
    );
    expect(packetReadiness(snapshot, "plan")!.historical).toBe(false);
    snapshot.entities[3].revision = 2;
    expect(packetReadiness(snapshot, "plan")!.historical).toBe(true);
  });
});

it("keeps location-owned plan-scene questions inside the explicit plan and scene", async () => {
  const { scopedPlan, scopeEntities } = await import("../src/domain/scope");
  const board = fixture();
  const question = (id: string, scope: Scope): Entity => ({
    ...entity(
      id,
      {
        kind: "question",
        key: id,
        prompt: id,
        reason: "Producer input",
        blocks: ["schedule"],
        suggestions: [],
        resolution: "open",
      },
      scope,
    ),
    ownerId: "location",
  });
  board.entities.push(
    question("own", { kind: "plan_scene", planId: "plan", sceneId: "scene" }),
    question("other", {
      kind: "plan_scene",
      planId: "other-plan",
      sceneId: "scene",
    }),
    question("excluded", {
      kind: "plan_scene",
      planId: "plan",
      sceneId: "excluded-scene",
    }),
    question("shared", { kind: "scene", sceneId: "original-discovery" }),
  );
  const plan = board.entities.find((e) => e._id === "plan")!;
  const ids = scopedPlan(plan, board.entities, board.choices).entities.map(
    (e) => e._id,
  );
  expect(ids).toContain("own");
  expect(ids).toContain("shared");
  expect(ids).not.toContain("other");
  expect(ids).not.toContain("excluded");
  const globalScene = scopeEntities(
    board.entities,
    { kind: "scene", sceneId: "scene" },
    "scene",
    board.choices,
    "research",
  ).map((e) => e._id);
  expect(globalScene).toContain("shared");
  expect(globalScene).not.toContain("own");
  expect(globalScene).not.toContain("other");
});
