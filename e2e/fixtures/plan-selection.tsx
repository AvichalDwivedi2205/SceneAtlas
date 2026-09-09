import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  entitySchema,
  type BoardSnapshot,
  type Entity,
} from "../../src/domain/model";
import { BoardView } from "../../src/features/canvas/board-view";
import type { BoardActions } from "../../src/features/canvas/board-context";
import "../../src/app/globals.css";

const record = (id: string, data: unknown): Entity => ({
  _id: id,
  boardId: "selection",
  data: entitySchema.parse(data),
  scope: { kind: "workspace" },
  logicalKey: id,
  revision: 1,
  stale: false,
  createdAt: 1,
  updatedAt: 1,
  updatedBy: "test",
});
const initial: BoardSnapshot = {
  board: {
    _id: "selection",
    name: "Choose your plans",
    ownerId: "test",
    archived: false,
  },
  me: { _id: "test", name: "Producer" },
  role: "owner",
  entities: [
    record("script", {
      kind: "script",
      filename: "Example screenplay.pdf",
      pageCount: 12,
      sceneCount: 3,
      summary: "Synthetic test input",
    }),
    ...[1, 2, 3].map((number) =>
      record(`scene-${number}`, {
        kind: "scene",
        number,
        heading: `EXT. COAST ${number} - DAY`,
        excerpt: "Coastal scene",
        pageStart: number,
        pageEnd: number,
        setting: "Coast",
        interiorExterior: "EXT",
        timeOfDay: "DAY",
        needs: [],
      }),
    ),
  ],
  nodes: [],
  edges: [],
  choices: [],
  runs: [],
};
const unexpected = async () => {
  throw new Error("Unexpected fixture operation");
};

function Fixture() {
  const [snapshot, setSnapshot] = useState(initial);
  const [created, setCreated] = useState<unknown>(null);
  const [configured, setConfigured] = useState<unknown>(null);
  const actions: BoardActions = {
    upload: unexpected,
    start: async () => {},
    startVariantResearch: async () => {},
    preview: unexpected,
    move: async () => {},
    choose: unexpected,
    note: unexpected,
    cancel: unexpected,
    retry: unexpected,
    change: unexpected,
    createPlans: async (plans) => {
      setCreated(plans);
      setSnapshot((previous) => ({
        ...previous,
        entities: [
          ...previous.entities,
          ...plans.map((p) => ({
            ...record(p.key, {
              kind: "plan",
              name: p.name,
              budgetMode: p.budgetMode,
              budgetMinor: p.budgetMinor,
              sceneScope: p.sceneScope,
              priority: p.budgetMode === "fixed" ? "cost" : "creative",
            }),
            scope: { kind: "plan" as const, planId: p.key },
          })),
        ],
      }));
      return plans.map((p) => p.key);
    },
    configureVariants: async (input) => {
      setConfigured(input);
    },
  };
  return (
    <>
      <output data-testid="created-plans" hidden>
        {JSON.stringify(created)}
      </output>
      <output data-testid="configured-plans" hidden>
        {JSON.stringify(configured)}
      </output>
      <BoardView
        snapshot={snapshot}
        actions={actions}
        changes={[]}
        messages={[]}
        people={[]}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
