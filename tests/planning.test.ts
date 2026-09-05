import { describe, expect, it } from "vitest";
import {
  entitySchema,
  costSchema,
  type Cost,
  type PlanData,
  type SceneData,
} from "../src/domain/model";
import {
  affectedIds,
  proposeSchedule,
  summarizeCosts,
} from "../src/domain/planning";
const fee: Cost = {
  id: "permit",
  label: "Application",
  amountMinor: 7500,
  currency: "USD",
  unit: "application",
  quantity: 1,
  basis: "estimate",
  coverageKey: "same-application",
  coverageReason: "One application covers both scenes",
  assumptions: "User-supplied estimate",
};
describe("honest accounting", () => {
  it("counts shared coverage once and a distinct booking separately", () => {
    const s = summarizeCosts(
      [fee, fee, { ...fee, coverageKey: "second-day" }],
      "USD",
      20000,
    );
    expect(s.partial).toBe(15000);
    expect(s.budgetStatus).toBe("estimated_within");
  });
  it("never treats unknown or another currency as a compliant budget", () => {
    const s = summarizeCosts(
      [
        fee,
        {
          ...fee,
          coverageKey: "parking",
          label: "Parking",
          amountMinor: null,
          basis: "unknown",
        },
        { ...fee, coverageKey: "eur", currency: "EUR" },
      ],
      "USD",
      10000,
    );
    expect(s.partial).toBe(7500);
    expect(s.budgetStatus).toBe("unconfirmed");
    expect(s.unknown).toEqual(["Parking"]);
    expect(s.otherCurrencies).toHaveLength(1);
  });
  it("flags contradictory shared charges", () =>
    expect(
      summarizeCosts([fee, { ...fee, amountMinor: 20000 }], "USD", 50000)
        .budgetStatus,
    ).toBe("unconfirmed"));
  it("requires evidence for a published fee", () =>
    expect(costSchema.safeParse({ ...fee, basis: "published" }).success).toBe(
      false,
    ));
});
it("walks shared dependencies without looping or touching unrelated records", () => {
  expect(
    affectedIds("answer", [
      { sourceId: "answer", targetId: "location" },
      { sourceId: "location", targetId: "budget" },
      { sourceId: "location", targetId: "creative" },
      { sourceId: "creative", targetId: "packet" },
      { sourceId: "packet", targetId: "location" },
      { sourceId: "other", targetId: "otherPlan" },
    ]),
  ).toEqual(["location", "budget", "creative", "packet"]);
});
const plan = entitySchema.parse({
  kind: "plan",
  name: "Budget",
  budgetMode: "fixed",
  budgetMinor: 800000,
  priority: "moves",
  dates: ["2026-11-14"],
  moveMinutes: 30,
  setupMinutes: 15,
  timingBasis: "estimate",
}) as PlanData;
const scene = entitySchema.parse({
  kind: "scene",
  number: 1,
  heading: "EXT. BEACH - DAY",
  excerpt: "Sand",
  pageStart: 1,
  pageEnd: 1,
  setting: "Beach",
  interiorExterior: "EXT",
  timeOfDay: "DAY",
  needs: [],
  durationMinutes: 60,
  durationBasis: "confirmed",
  windows: [{ date: "2026-11-14", start: 480, end: 1020 }],
}) as SceneData;
describe("schedule constraints", () => {
  it("preserves supplied choices and reports an impossible window", () => {
    const s = proposeSchedule("p", plan, [
      { id: "s1", data: scene, locationId: "locked", locationName: "Beach" },
      {
        id: "s2",
        data: {
          ...scene,
          number: 2,
          windows: [{ date: "2026-11-14", start: 480, end: 490 }],
        },
        locationId: "other",
        locationName: "Cliff",
      },
    ]);
    expect(s.entries[0].locationId).toBe("locked");
    expect(s.conflicts.join()).toContain("Scene 2");
    expect(s.provisional).toBe(true);
  });
  it("asks for unknown durations and time windows instead of inventing them", () => {
    const s = proposeSchedule("p", plan, [
      {
        id: "s",
        data: { ...scene, durationMinutes: null, windows: [] },
        locationId: "l",
        locationName: "Location",
      },
    ]);
    expect(s.entries).toEqual([]);
    expect(s.conflicts).toHaveLength(2);
  });
  it("refuses hard rules the scheduler cannot enforce", () => {
    const constrained = {
      ...plan,
      rules: [
        {
          field: "weather",
          value: "no rain",
          strength: "hard" as const,
          origin: "user" as const,
          explanation: "Keep equipment dry",
        },
      ],
    };
    const s = proposeSchedule("p", constrained, [
      { id: "s", data: scene, locationId: "l", locationName: "Location" },
    ]);
    expect(s.entries).toEqual([]);
    expect(s.conflicts.join()).toContain("weather");
  });
  it("reports a schedule that exceeds the hard move limit", () => {
    const constrained = {
      ...plan,
      rules: [
        {
          field: "maxMoves",
          value: 0,
          strength: "hard" as const,
          origin: "user" as const,
          explanation: "One location only",
        },
      ],
    };
    const second = {
      ...scene,
      number: 2,
      durationMinutes: 60,
      windows: [{ date: "2026-11-14", start: 480, end: 1020 }],
    };
    const s = proposeSchedule("p", constrained, [
      { id: "s1", data: scene, locationId: "a", locationName: "A" },
      { id: "s2", data: second, locationId: "b", locationName: "B" },
    ]);
    expect(s.moves).toBe(1);
    expect(s.conflicts.join()).toContain("hard limit is 0");
  });
});
