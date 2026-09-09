import { describe, expect, it } from "vitest";
import {
  entitySchema,
  type BoardRun,
  type BoardSnapshot,
  type Entity,
} from "../src/domain/model";
import {
  overviewPlanState,
  overviewSetupStage,
} from "../src/features/canvas/production-overview-state";

function entity(id: string, data: unknown): Entity {
  return {
    _id: id,
    boardId: "board",
    data: entitySchema.parse(data),
    scope: { kind: "workspace" },
    revision: 1,
    stale: false,
    createdAt: 1,
    updatedAt: 1,
    updatedBy: "owner",
    logicalKey: id,
  };
}

function fixture() {
  const scene = (id: string, number: number) =>
    entity(id, {
      kind: "scene",
      number,
      heading: "EXT. BEACH - DAY",
      excerpt: "A rehearsal.",
      pageStart: number,
      pageEnd: number,
      setting: "Beach",
      interiorExterior: "EXT",
      timeOfDay: "DAY",
      needs: [],
      durationMinutes: 45,
      durationBasis: "estimate",
      windows: [{ date: "2026-11-16", start: 480, end: 1080 }],
    });
  const plan = (id: string) =>
    entity(id, {
      kind: "plan",
      name: id === "budget" ? "Producer's custom plan" : "Alternate coast",
      budgetMode: id === "budget" ? "fixed" : "uncapped",
      budgetMinor: id === "budget" ? 250000 : null,
      priority: "cost",
      dates: ["2026-11-16"],
      setupMinutes: 15,
      moveMinutes: 30,
      timingBasis: "estimate",
      sceneScope: { mode: "selected", sceneIds: ["included"] },
    });
  const budget = plan("budget");
  const alternate = plan("alternate");
  const snapshot: BoardSnapshot = {
    board: {
      _id: "board",
      name: "Coastal production",
      ownerId: "owner",
      archived: false,
    },
    role: "owner",
    me: { _id: "owner", name: "Producer" },
    nodes: [],
    edges: [],
    choices: [],
    runs: [],
    entities: [budget, alternate, scene("included", 1), scene("excluded", 2)],
  };
  return { snapshot, budget, alternate };
}

function run(
  id: string,
  sceneId: string,
  extra: Partial<BoardRun> = {},
): BoardRun {
  return {
    _id: id,
    kind: "research",
    status: "running",
    activity: "Searching sources",
    targetId: sceneId,
    scope: { kind: "scene", sceneId },
    createdAt: 10,
    updatedAt: 10,
    ...extra,
  };
}

describe("production overview derives plan progress from saved scope", () => {
  it("does not treat default plan records as completed setup", () => {
    const { snapshot } = fixture();
    snapshot.entities = snapshot.entities.filter(
      (entity) => entity.data.kind !== "scene",
    );
    expect(overviewSetupStage(snapshot)).toBe("initial");
  });

  it("offers scene selection until actual production research or choices exist", () => {
    const { snapshot } = fixture();
    expect(overviewSetupStage(snapshot)).toBe("scenes");
    snapshot.runs = [run("started", "included", { status: "failed" })];
    expect(overviewSetupStage(snapshot)).toBe("work");
    snapshot.runs = [];
    snapshot.choices = [
      {
        planId: "budget",
        sceneId: "included",
        locationId: "location",
        locked: true,
        revision: 1,
      },
    ];
    expect(overviewSetupStage(snapshot)).toBe("work");
  });
  it("does not assign other-plan or excluded-scene research to a plan", () => {
    const { snapshot, budget } = fixture();
    snapshot.runs = [
      run("outside", "excluded"),
      run("other-plan", "included", {
        scope: { kind: "plan_scene", planId: "alternate", sceneId: "included" },
      }),
      run("own-excluded", "excluded", {
        scope: { kind: "plan_scene", planId: "budget", sceneId: "excluded" },
      }),
    ];
    const result = overviewPlanState(budget, snapshot);
    expect(result.runs).toEqual([]);
    expect(result.status.tone).toBe("idle");
    expect(result.sceneCount).toBe(1);
    expect(result.name).toBe("Producer's custom plan");
  });

  it("shows a genuine shared included-scene search on both plans", () => {
    const { snapshot, budget, alternate } = fixture();
    snapshot.runs = [run("shared-search", "included")];
    for (const plan of [budget, alternate]) {
      const result = overviewPlanState(plan, snapshot);
      expect(result.status.tone).toBe("working");
      expect(result.status.detail).toBe(
        "Shared research for an included scene",
      );
    }
    expect(overviewPlanState(alternate, snapshot).budget).toBe("No fixed cap");
  });

  it("keeps explicitly empty scope empty while research runs elsewhere", () => {
    const { snapshot, budget } = fixture();
    if (budget.data.kind === "plan")
      budget.data.sceneScope = { mode: "selected", sceneIds: [] };
    snapshot.runs = [run("shared-search", "included")];
    const result = overviewPlanState(budget, snapshot);
    expect(result.sceneCount).toBe(0);
    expect(result.runs).toEqual([]);
    expect(result.status.label).toBe("Choose scenes for this plan");
  });

  it("does not keep an obsolete failure after that task's successful retry", () => {
    const { snapshot, budget } = fixture();
    snapshot.runs = [
      run("failed", "included", { status: "failed", createdAt: 10 }),
      run("retry", "included", { status: "complete", createdAt: 20 }),
    ];
    const result = overviewPlanState(budget, snapshot);
    expect(result.runs.map((r) => r._id)).toEqual(["retry"]);
    expect(result.status.label).toBe("Choose filming locations");
  });

  it("shows an existing schedule as current only while its saved inputs are ready", () => {
    const { snapshot, budget } = fixture();
    snapshot.entities.push(
      entity("location", {
        kind: "location",
        name: "Coastal park",
        address: "Malibu",
        description: "Open coast",
        creativeFit: "Beach",
        authority: "Parks",
        restrictions: [],
        costs: [],
        requirements: [],
        sceneIds: ["included"],
        sources: [
          {
            url: "https://example.com/park",
            title: "Park",
            excerpt: "Coast",
            retrievedAt: 1,
            provider: "official",
          },
        ],
      }),
      entity("schedule", {
        kind: "schedule",
        planId: "budget",
        entries: [
          {
            sceneId: "included",
            sceneNumber: 1,
            locationId: "location",
            locationName: "Coastal park",
            date: "2026-11-16",
            start: 495,
            end: 540,
            durationBasis: "estimate",
            reason: "Within saved window",
          },
        ],
        conflicts: [],
        provisional: true,
        moves: 0,
        days: 1,
        explanation: "Saved schedule",
      }),
    );
    snapshot.choices = [
      {
        planId: "budget",
        sceneId: "included",
        locationId: "location",
        locked: true,
        revision: 1,
      },
    ];
    expect(overviewPlanState(budget, snapshot).currentSchedule).toBe(true);
    budget.stale = true;
    const changed = overviewPlanState(budget, snapshot);
    expect(changed.currentSchedule).toBe(false);
    expect(changed.scheduleLabel).toBe("Schedule needs review");
    expect(changed.status.tone).toBe("attention");
  });
});
