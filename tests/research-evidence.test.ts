import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  BoardRun,
  BoardSnapshot,
  Entity,
  LocationData,
  Source,
} from "../src/domain/model";
import {
  candidateLocations,
  evidenceRuns,
  locationEvidence,
  researchExecution,
  safeSourceUrl,
} from "../src/domain/research-evidence";
import {
  BoardContext,
  type BoardActions,
} from "../src/features/canvas/board-context";
import {
  CandidateComparison,
  SourceEvidence,
} from "../src/features/canvas/research-details";

vi.mock("../src/features/canvas/research-details.module.css", () => ({
  default: {},
}));

const source: Source = {
  url: "https://parks.ca.gov/example",
  title: "Location guidance",
  excerpt: `${"Observed access guidance. ".repeat(15)}The final excerpt sentence is preserved.`,
  provider: "parallel",
  cached: false,
  retrievedAt: 1_700_000_000_000,
  searchId: "search-observed",
};
const location: LocationData = {
  kind: "location",
  name: "Observed beach",
  address: "California",
  description: "A coastal location",
  creativeFit: "Open horizon fits the scene",
  authority: "Park authority",
  availability: "unverified",
  restrictions: [],
  costs: [],
  requirements: [],
  sources: [source],
  sceneIds: ["scene"],
  rejected: false,
};
function candidate(
  id: string,
  data: Partial<LocationData> = {},
  planId?: string,
): Entity {
  return {
    _id: id,
    boardId: "board",
    data: { ...location, ...data },
    scope: planId
      ? { kind: "plan_scene", planId, sceneId: "scene" }
      : { kind: "scene", sceneId: "scene" },
    revision: 1,
    stale: false,
    createdAt: 1,
    updatedAt: 1,
    updatedBy: "owner",
    logicalKey: id,
  };
}

describe("saved research provenance", () => {
  it("only accepts allowlisted provider events and never forwards extra payloads", () => {
    expect(
      researchExecution({ modelDraft: "private unvalidated draft" }),
    ).toBeUndefined();
    const telemetry = researchExecution({
      operation: "search",
      phase: "complete",
      requestId: "search-real",
      queries: ["actual public query", 2],
      retrievedAt: 123,
      cached: false,
      resultCount: 0,
      apiKey: "must-never-render",
      rawResponse: { modelDraft: "unvalidated" },
    });
    expect(telemetry).toMatchObject({
      requestId: "search-real",
      queries: ["actual public query"],
      cached: false,
      resultCount: 0,
    });
    expect(JSON.stringify(telemetry)).not.toContain("must-never-render");
    expect(JSON.stringify(telemetry)).not.toContain("unvalidated");
  });

  it("keeps absent cache and request metadata unknown", () => {
    const telemetry = researchExecution({
      operation: "extract",
      phase: "request",
      retrievedAt: Number.NaN,
    });
    expect(telemetry?.cached).toBeUndefined();
    expect(telemetry?.requestId).toBeUndefined();
    expect(telemetry?.retrievedAt).toBeUndefined();
  });

  it("does not create executable or credential-bearing source links", () => {
    expect(safeSourceUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeSourceUrl("https://key:secret@example.com/")).toBeUndefined();
    expect(safeSourceUrl(source.url)).toBe(source.url);
  });

  it("retains the full saved excerpt, original request reference and reused provenance", () => {
    const markup = renderToStaticMarkup(
      createElement(SourceEvidence, { sources: [{ ...source, cached: true }] }),
    );
    expect(markup).toContain("The final excerpt sentence is preserved.");
    expect(markup).toContain("search-observed");
    expect(markup).toContain("original retrieval time");
  });

  it("deduplicates identical references without merging fresh and reused evidence", () => {
    expect(
      locationEvidence({
        ...location,
        sources: [source, source, { ...source, cached: true }],
      }),
    ).toHaveLength(2);
  });

  it("filters candidate and run history to the scene and relevant plan", () => {
    const shared = candidate("shared");
    const samePlan = candidate("same", {}, "budget");
    const otherPlan = candidate("other", {}, "creative");
    const entities = [
      shared,
      samePlan,
      otherPlan,
      candidate("rejected", { rejected: true }),
      candidate("other-scene", { sceneIds: ["excluded"] }),
    ];
    expect(
      candidateLocations(entities, "scene", "budget").map((item) => item._id),
    ).toEqual(["shared", "same"]);
    const run: BoardRun = {
      _id: "search",
      kind: "research",
      status: "complete",
      activity: "Research complete",
      targetId: "scene",
      scope: { kind: "scene", sceneId: "scene" },
      createdAt: 1,
      updatedAt: 1,
    };
    const runs = [
      run,
      {
        ...run,
        _id: "other-plan",
        scope: { kind: "plan" as const, planId: "creative" },
      },
      {
        ...run,
        _id: "requirements",
        kind: "requirements" as const,
        targetId: "shared",
        createdAt: 2,
      },
    ];
    expect(
      evidenceRuns(runs, shared, entities, "budget").map((item) => item._id),
    ).toEqual(["requirements", "search"]);
  });
});

function comparisonMarkup(entities: Entity[]) {
  const snapshot: BoardSnapshot = {
    board: {
      _id: "board",
      name: "Production",
      ownerId: "owner",
      archived: false,
    },
    role: "viewer",
    entities,
    nodes: [],
    edges: [],
    choices: [],
    runs: [],
    me: { _id: "owner", name: "Producer" },
  };
  return renderToStaticMarkup(
    createElement(
      BoardContext.Provider,
      {
        value: {
          snapshot,
          activePlanId: "budget",
          previewMode: true,
          actions: {} as BoardActions,
          focus: () => {},
          inspect: () => {},
          edit: () => {},
          act: async () => {},
        },
      },
      createElement(CandidateComparison, { sceneId: "scene" }),
    ),
  );
}

describe("evidence-based candidate comparison", () => {
  it("states the single candidate limitation and does not render missing fees as zero", () => {
    const markup = comparisonMarkup([candidate("one")]);
    expect(markup).toContain("Only one usable candidate");
    expect(markup).toContain("Price evidence is missing. Cost is unknown.");
    expect(markup).not.toContain("$0");
    expect(markup).toContain("Unverified");
  });

  it("shows a sourced zero fee separately from an unquoted fee", () => {
    const markup = comparisonMarkup([
      candidate("one", {
        costs: [
          {
            id: "application",
            label: "Application fee",
            amountMinor: 0,
            currency: "USD",
            unit: "application",
            quantity: 1,
            basis: "published",
            coverageKey: "application",
            coverageReason: "One application",
            source,
            assumptions: "",
          },
          {
            id: "booking",
            label: "Booking fee",
            amountMinor: null,
            currency: "USD",
            unit: "day",
            quantity: 1,
            basis: "unknown",
            coverageKey: "booking",
            coverageReason: "Location hire",
            assumptions: "Awaiting quote",
          },
        ],
      }),
    ]);
    expect(markup).toContain("$0.00");
    expect(markup).toContain("Not quoted");
    expect(markup).toContain("Fee evidence");
    expect(markup).toContain("Awaiting quote");
  });
});
