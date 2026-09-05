"use client";
import { BoardView } from "../../features/canvas/board-view";
import type { BoardActions } from "../../features/canvas/board-context";
import type {
  BoardSnapshot,
  Entity,
  EntityData,
  Scope,
} from "../../domain/model";

const now = Date.now();
const source = {
  url: "https://film.ca.gov/state-permits/",
  title: "California Film Commission — State permits",
  excerpt: "Official state filming permit guidance and application resources.",
  retrievedAt: now,
  provider: "official" as const,
  cached: false,
};
function entity(
  id: string,
  data: EntityData,
  scope: Scope,
  ownerId?: string,
): Entity {
  return {
    _id: id,
    boardId: "sample",
    data,
    scope,
    ownerId,
    revision: 1,
    stale: false,
    createdAt: now,
    updatedAt: now,
    updatedBy: "sample-user",
    logicalKey: id,
  };
}
const script = entity(
  "script",
  {
    kind: "script",
    filename: "coastal_short.pdf",
    pageCount: 12,
    summary:
      "Mara follows a trail of old photographs along the California coast before sunset changes what she came to find.",
    sceneCount: 3,
    assetId: "sample",
  },
  { kind: "workspace" },
);
const q = entity(
  "q-area",
  {
    kind: "question",
    key: "search-area",
    prompt: "Where can this production realistically travel?",
    reason:
      "Search radius changes candidate locations, moving costs, and permitting authorities.",
    suggestions: [
      "Within 60 miles of Los Angeles",
      "Southern California",
      "California state property only",
    ],
    blocks: ["research"],
    answer: "Southern California · state property preferred",
    resolution: "answered",
    rule: {
      field: "searchArea",
      value: "Southern California",
      strength: "hard",
      origin: "user",
      explanation: "Producer-confirmed search boundary.",
    },
  },
  { kind: "workspace" },
  "script",
);
const answer = entity(
  "answer-area",
  {
    kind: "answer",
    questionId: "q-area",
    question: "Where can this production realistically travel?",
    original: "Southern California · state property preferred",
    resolution: "answered",
    rule: {
      field: "searchArea",
      value: "Southern California",
      strength: "hard",
      origin: "user",
      explanation: "Producer-confirmed search boundary.",
    },
  },
  { kind: "workspace" },
  "script",
);
const scene1 = entity(
  "scene-1",
  {
    kind: "scene",
    number: 1,
    heading: "EXT. OPEN BEACH — DAY",
    excerpt:
      "Mara crosses the open sand toward the rocks, holding the photograph against the horizon.",
    pageStart: 1,
    pageEnd: 3,
    setting: "Open beach with rocks",
    interiorExterior: "EXT",
    timeOfDay: "DAY",
    needs: ["Open coastline", "Accessible sand", "Rock formation"],
    durationMinutes: 90,
    durationBasis: "estimate",
    candidateCount: 3,
    ranking: "creative",
    windows: [{ date: "2026-10-17", start: 540, end: 1020 }],
  },
  { kind: "scene", sceneId: "scene-1" },
  "script",
);
const scene2 = entity(
  "scene-2",
  {
    kind: "scene",
    number: 2,
    heading: "EXT. CLIFF OVERLOOK — DUSK",
    excerpt:
      "At the cliff edge, the last light catches a name written on the back of the photograph.",
    pageStart: 4,
    pageEnd: 7,
    setting: "Coastal cliff overlook",
    interiorExterior: "EXT",
    timeOfDay: "DUSK",
    needs: ["West-facing view", "Safe overlook", "Golden hour"],
    durationMinutes: null,
    durationBasis: "unknown",
    candidateCount: 3,
    ranking: "creative",
    windows: [{ date: "2026-10-17", start: 990, end: 1110 }],
  },
  { kind: "scene", sceneId: "scene-2" },
  "script",
);
const scene3 = entity(
  "scene-3",
  {
    kind: "scene",
    number: 3,
    heading: "INT. PARK VISITOR ROOM — NIGHT",
    excerpt:
      "Mara pins both photographs to the faded trail map. The two shorelines become one.",
    pageStart: 8,
    pageEnd: 12,
    setting: "Small coastal visitor room",
    interiorExterior: "INT",
    timeOfDay: "NIGHT",
    needs: ["Practical room", "Trail map", "Night control"],
    durationMinutes: 75,
    durationBasis: "confirmed",
    candidateCount: 2,
    ranking: "cost",
    windows: [],
  },
  { kind: "scene", sceneId: "scene-3" },
  "script",
);
const q2 = entity(
  "q-golden",
  {
    kind: "question",
    key: "golden-hour",
    prompt: "Is golden hour essential for Scene 2?",
    reason:
      "A hard dusk window makes the schedule dependent on exact seasonal light and access hours.",
    suggestions: ["Essential", "Preferred, but flexible", "Not needed"],
    blocks: ["schedule"],
    answer: null,
    resolution: "open",
    rule: null,
  },
  { kind: "scene", sceneId: "scene-2" },
  "scene-2",
);
const loc1 = entity(
  "loc-leo",
  {
    kind: "location",
    name: "Leo Carrillo State Park",
    address: "35000 Pacific Coast Hwy, Malibu, CA",
    description:
      "State park beach with rocky coves, broad sand, and coastal formations.",
    creativeFit:
      "Strong match for open sand and rocks; one candidate may cover Scenes 1 and 2.",
    restrictions: [
      "Filming permission requires official review.",
      "Operating hours and tide conditions need confirmation.",
    ],
    availability: "unverified",
    authority: "California State Parks",
    sources: [source],
    costs: [
      {
        id: "application",
        label: "Permit application",
        amountMinor: null,
        currency: "USD",
        unit: "application",
        quantity: 1,
        basis: "unknown",
        coverageKey: "parks-application",
        coverageReason:
          "One state parks application may cover selected scenes; coverage unverified.",
        assumptions: "Official quote needed.",
      },
    ],
    requirements: [
      {
        title: "State property film permit",
        detail:
          "Contact California Film Commission and relevant state property authority before filming.",
        authority: "California Film Commission",
        status: "sourced",
        sources: [source],
        attachments: ["Production details", "Certificate of insurance"],
        applicableFacts: ["California state property"],
        externalStatus: "unverified",
      },
    ],
    sceneIds: ["scene-1", "scene-2"],
    rejected: false,
  },
  { kind: "scene", sceneId: "scene-1" },
  "scene-1",
);
const loc2 = entity(
  "loc-point",
  {
    kind: "location",
    name: "Point Dume State Beach",
    address: "Cliffside Dr, Malibu, CA",
    description:
      "Headland, beach, and high coastal overlook on state property.",
    creativeFit:
      "Excellent west-facing cliff profile for dusk; access logistics need confirmation.",
    restrictions: [
      "Cliff-edge safety plan may be required.",
      "Public access cannot be represented as controlled.",
    ],
    availability: "unverified",
    authority: "California State Parks",
    sources: [source],
    costs: [
      {
        id: "location-fee",
        label: "Location fee",
        amountMinor: null,
        currency: "USD",
        unit: "day",
        quantity: 1,
        basis: "unknown",
        coverageKey: "point-dume-day",
        coverageReason: "Published amount not established in sample evidence.",
        assumptions: "Quote required.",
      },
    ],
    requirements: [
      {
        title: "Site authorization",
        detail:
          "Property-specific review remains required after state permit preparation.",
        authority: "California State Parks",
        status: "unresolved",
        sources: [],
        attachments: ["Site map", "Schedule"],
        applicableFacts: ["Cliff overlook", "Public beach"],
        externalStatus: "unverified",
      },
    ],
    sceneIds: ["scene-2"],
    rejected: false,
  },
  { kind: "scene", sceneId: "scene-2" },
  "scene-2",
);
const budget = entity(
  "plan-budget",
  {
    kind: "plan",
    name: "Budget plan",
    budgetMode: "fixed",
    budgetMinor: 350000,
    currency: "USD",
    priority: "cost",
    idealShoot: "Reuse one coastal state property where feasible.",
    rules: [],
    dates: ["2026-10-17"],
    timezone: "America/Los_Angeles",
    dayStart: 480,
    dayEnd: 1200,
    moveMinutes: 45,
    setupMinutes: 30,
    timingBasis: "estimate",
  },
  { kind: "plan", planId: "plan-budget" },
  "script",
);
const creative = entity(
  "plan-creative",
  {
    kind: "plan",
    name: "Creative plan",
    budgetMode: "uncapped",
    budgetMinor: null,
    currency: "USD",
    priority: "creative",
    idealShoot: "Protect west-facing dusk composition, even with one move.",
    rules: [],
    dates: ["2026-10-17", "2026-10-18"],
    timezone: "America/Los_Angeles",
    dayStart: 480,
    dayEnd: 1200,
    moveMinutes: 45,
    setupMinutes: 30,
    timingBasis: "estimate",
  },
  { kind: "plan", planId: "plan-creative" },
  "script",
);
const schedule = entity(
  "schedule",
  {
    kind: "schedule",
    planId: "plan-budget",
    entries: [
      {
        sceneId: "scene-1",
        sceneNumber: 1,
        locationId: "loc-leo",
        locationName: "Leo Carrillo State Park",
        date: "2026-10-17",
        start: 540,
        end: 630,
        durationBasis: "Producer-approved estimate",
        reason: "Starts on broad beach before public traffic increases.",
      },
    ],
    conflicts: [
      "Scene 2 duration still unknown.",
      "Scene 3 has no selected location.",
    ],
    provisional: true,
    moves: 0,
    days: 1,
    explanation:
      "Partial order only. Missing duration and location choices prevent a complete feasible schedule.",
  },
  { kind: "plan", planId: "plan-budget" },
  "plan-budget",
);
const entities = [
  script,
  q,
  answer,
  scene1,
  scene2,
  scene3,
  q2,
  loc1,
  loc2,
  budget,
  creative,
  schedule,
];
const coords: Record<string, [number, number]> = {
  script: [420, 20],
  "q-area": [30, 155],
  "answer-area": [65, 495],
  "scene-1": [310, 280],
  "scene-2": [690, 280],
  "scene-3": [1070, 280],
  "q-golden": [690, 650],
  "loc-leo": [250, 740],
  "loc-point": [740, 1010],
  "plan-budget": [280, 1230],
  "plan-creative": [710, 1230],
  schedule: [280, 1580],
};
const nodes = entities.map((e) => ({
  _id: `node-${e._id}`,
  entityId: e._id,
  x: coords[e._id]?.[0] ?? 0,
  y: coords[e._id]?.[1] ?? 0,
  width: 330,
  height: 260,
  geometryRevision: 1,
  manual: false,
}));
const edges = [
  ["script", "q-area", "clarifies"],
  ["q-area", "answer-area", "saved answer"],
  ["script", "scene-1", "contains"],
  ["script", "scene-2", "contains"],
  ["script", "scene-3", "contains"],
  ["scene-2", "q-golden", "clarifies"],
  ["scene-1", "loc-leo", "candidate"],
  ["scene-2", "loc-leo", "candidate"],
  ["scene-2", "loc-point", "candidate"],
  ["loc-leo", "plan-budget", "selected"],
  ["loc-point", "plan-creative", "selected"],
  ["plan-budget", "schedule", "proposes"],
].map((e, i) => ({
  _id: `edge-${i}`,
  sourceId: e[0],
  targetId: e[1],
  relation: e[2],
}));
const snapshot: BoardSnapshot = {
  board: {
    _id: "sample",
    name: "Coastal Short",
    ownerId: "sample-user",
    archived: false,
  },
  role: "owner",
  entities,
  nodes,
  edges,
  choices: [
    {
      planId: "plan-budget",
      sceneId: "scene-1",
      locationId: "loc-leo",
      locked: true,
      revision: 1,
    },
    {
      planId: "plan-creative",
      sceneId: "scene-2",
      locationId: "loc-point",
      locked: true,
      revision: 1,
    },
  ],
  runs: [],
  me: { _id: "sample-user", name: "You" },
};
const noop = async () => {};
const actions: BoardActions = {
  upload: noop,
  start: noop,
  preview: async () => "",
  move: noop,
  choose: noop,
  note: noop,
  cancel: noop,
  retry: noop,
  change: noop,
};
export default function Preview() {
  return (
    <BoardView
      snapshot={snapshot}
      actions={actions}
      changes={[]}
      messages={[]}
      people={[
        { userId: "sample-user", name: "You", online: true, signals: [] },
      ]}
      previewMode
    />
  );
}
