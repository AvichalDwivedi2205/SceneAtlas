import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  entitySchema,
  type BoardSnapshot,
  type Entity,
  type EntityData,
  type PlanData,
  type ScheduleData,
} from "../src/domain/model";
import {
  decisionPreservation,
  isStartTimeChange,
  lockedSceneExclusions,
  revisionInputChanges,
  scheduleRowChanges,
} from "../src/domain/revision-review";
import { RevisionReview } from "../src/features/canvas/revision-review";

vi.mock("../src/features/canvas/revision-review.module.css", () => ({
  default: {},
}));

const plan = entitySchema.parse({
  kind: "plan",
  name: "Budget",
  budgetMode: "fixed",
  budgetMinor: 500000,
  priority: "cost",
  dayStart: 480,
  setupMinutes: 15,
  moveMinutes: 30,
  timingBasis: "confirmed",
}) as PlanData;
const scene = entitySchema.parse({
  kind: "scene",
  number: 1,
  heading: "EXT. BEACH — DAY",
  setting: "Beach",
  excerpt: "The crew arrives.",
  pageStart: 1,
  pageEnd: 2,
  interiorExterior: "EXT",
  timeOfDay: "DAY",
  needs: [],
});
function entity(id: string, data: EntityData): Entity {
  return {
    _id: id,
    boardId: "board",
    data,
    scope: { kind: "workspace" },
    revision: 1,
    stale: false,
    createdAt: 1,
    updatedAt: 1,
    updatedBy: "owner",
    logicalKey: id,
  };
}
const snapshot: BoardSnapshot = {
  board: { _id: "board", name: "Project", ownerId: "owner", archived: false },
  role: "owner",
  me: { _id: "owner", name: "Producer" },
  entities: [
    entity("plan", plan),
    entity("scene", scene),
    entity(
      "answer",
      entitySchema.parse({
        kind: "question",
        key: "crew_size",
        prompt: "Crew size?",
        reason: "Requirements",
        suggestions: [],
        blocks: ["requirements"],
        answer: "10",
        resolution: "answered",
      }),
    ),
  ],
  choices: [
    {
      planId: "plan",
      sceneId: "scene",
      locationId: "location",
      locked: true,
      revision: 1,
    },
  ],
  nodes: [],
  edges: [],
  runs: [],
};
const baseline = {
  choices: snapshot.choices,
  answers: [{ id: "answer", revision: 1, answer: "10" }],
};
const original: ScheduleData = {
  kind: "schedule",
  planId: "plan",
  entries: [
    {
      sceneId: "scene",
      sceneNumber: 1,
      locationId: "location",
      locationName: "Beach",
      date: "2026-11-14",
      start: 495,
      end: 555,
      durationBasis: "confirmed",
      reason: "Fits confirmed window",
    },
  ],
  conflicts: [],
  moves: 0,
  days: 1,
  provisional: true,
  explanation: "Proposed shooting order",
};
const revised: ScheduleData = {
  ...original,
  entries: [{ ...original.entries[0], start: 555, end: 615 }],
};

describe("typed production revision comparison", () => {
  it("identifies a start-time-only change without inventing a timing delta", () => {
    const changes = revisionInputChanges(
      plan,
      { ...plan, dayStart: 540 },
      snapshot.entities,
    );
    expect(changes).toEqual([
      {
        field: "dayStart",
        label: "Production start",
        before: "08:00",
        after: "09:00",
      },
    ]);
    expect(isStartTimeChange(changes)).toBe(true);
    expect(
      isStartTimeChange(
        revisionInputChanges(
          plan,
          { ...plan, dayStart: 540, setupMinutes: 25 },
          snapshot.entities,
        ),
      ),
    ).toBe(false);
  });

  it("shows explicit empty selection and warns only about this plan's excluded locks", () => {
    const next: PlanData = {
      ...plan,
      sceneScope: { mode: "selected", sceneIds: [] },
    };
    const changes = revisionInputChanges(plan, next, snapshot.entities);
    expect(changes[0].before).toContain("All scenes · 1 included");
    expect(changes[0].after).toContain("Selected scenes · 0 included");
    expect(
      lockedSceneExclusions("plan", plan, next, {
        ...snapshot,
        choices: [
          ...snapshot.choices,
          { ...snapshot.choices[0], planId: "other" },
        ],
      }),
    ).toHaveLength(1);
  });

  it("requires values and revisions to match before claiming choices and answers are unchanged", () => {
    const preserved = decisionPreservation(baseline, snapshot)!;
    expect(preserved.choices[0].unchanged).toBe(true);
    expect(preserved.answers[0].unchanged).toBe(true);
    const edited: BoardSnapshot = {
      ...snapshot,
      choices: [{ ...snapshot.choices[0], locked: false, revision: 2 }],
      entities: snapshot.entities.map((record) =>
        record._id === "answer" ? { ...record, revision: 2 } : record,
      ),
    };
    expect(decisionPreservation(baseline, edited)?.choices[0].unchanged).toBe(
      false,
    );
    expect(decisionPreservation(baseline, edited)?.answers[0].unchanged).toBe(
      false,
    );
    expect(decisionPreservation(undefined, snapshot)).toBeUndefined();
  });

  it("pairs added, removed and retimed schedule entries by scene identity", () => {
    const added = { ...revised.entries[0], sceneId: "new", sceneNumber: 2 };
    const rows = scheduleRowChanges(original, { ...revised, entries: [added] });
    expect(rows[0].before?.sceneId).toBe("scene");
    expect(rows[0].after).toBeUndefined();
    expect(rows[1].before).toBeUndefined();
    expect(rows[1].after?.sceneId).toBe("new");
    expect(scheduleRowChanges(original, revised)[0].after?.start).toBe(555);
  });

  it("uses the captured old schedule after Apply, even when live state already contains the revised times", () => {
    const markup = renderToStaticMarkup(
      createElement(RevisionReview, {
        snapshot: {
          ...snapshot,
          entities: [...snapshot.entities, entity("schedule", revised)],
        },
        change: {
          _id: "change",
          summary: "Start later",
          status: "applied",
          targetId: "plan",
          before: plan,
          proposed: { ...plan, dayStart: 540 },
          affectedIds: ["schedule"],
          runIds: [],
          stagedSchedules: [revised],
          beforeSchedules: [original],
          preservedDecisions: baseline,
        },
      }),
    );
    expect(markup).toContain("08:15–09:15");
    expect(markup).toContain("09:15–10:15");
    expect(markup).toContain("Location and lock unchanged");
    expect(markup).toContain("Answer unchanged");
  });

  it("marks legacy preservation and old schedule data as unavailable", () => {
    const markup = renderToStaticMarkup(
      createElement(RevisionReview, {
        snapshot,
        change: {
          _id: "legacy",
          summary: "Update",
          status: "ready",
          targetId: "plan",
          before: plan,
          proposed: { ...plan, dayStart: 540 },
          affectedIds: [],
          runIds: [],
          stagedSchedules: [revised],
        },
      }),
    );
    expect(markup).toContain("No previous schedule was captured");
    expect(markup).toContain("preservation cannot be verified");
    expect(markup).not.toContain("Answer unchanged");
  });
});
