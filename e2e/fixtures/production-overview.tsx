import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  entitySchema,
  type BoardSnapshot,
  type Entity,
} from "../../src/domain/model";
import {
  BoardContext,
  type BoardActions,
} from "../../src/features/canvas/board-context";
import { ProductionOverview } from "../../src/features/canvas/production-overview";

function entity(id: string, data: unknown): Entity {
  return {
    _id: id,
    boardId: "fixture",
    data: entitySchema.parse(data),
    scope: { kind: "workspace" },
    revision: 1,
    stale: false,
    createdAt: 1,
    updatedAt: 1,
    updatedBy: "fixture",
    logicalKey: id,
  };
}

const initial: BoardSnapshot = {
  board: {
    _id: "fixture",
    name: "Production overview regression fixture",
    ownerId: "fixture",
    archived: false,
  },
  role: "viewer",
  me: { _id: "fixture", name: "Viewer" },
  nodes: [],
  edges: [],
  choices: [],
  runs: [],
  entities: [
    entity("script", {
      kind: "script",
      filename: "Example screenplay.pdf",
      pageCount: 12,
      sceneCount: 3,
      assetId: "fixture",
      summary: "Synthetic input for a browser regression test.",
    }),
    ...["budget", "alternate"].map((id) =>
      entity(id, {
        kind: "plan",
        name: id === "budget" ? "Budget plan" : "No fixed budget",
        budgetMode: id === "budget" ? "fixed" : "uncapped",
        budgetMinor: id === "budget" ? 500000 : null,
        priority: "cost",
        dates: ["2026-11-16"],
        setupMinutes: 15,
        moveMinutes: 30,
        timingBasis: "estimate",
        sceneScope: {
          mode: "selected",
          sceneIds: ["scene-1", "scene-2", "scene-3"],
        },
      }),
    ),
    ...[1, 2, 3].map((number) =>
      entity(`scene-${number}`, {
        kind: "scene",
        number,
        heading: "EXT. COURTYARD - DAY",
        excerpt: "A conversation in the courtyard.",
        pageStart: number,
        pageEnd: number,
        setting: "Courtyard",
        interiorExterior: "EXT",
        timeOfDay: "DAY",
        needs: [],
        durationMinutes: 45,
        durationBasis: "estimate",
        windows: [{ date: "2026-11-16", start: 480, end: 1080 }],
      }),
    ),
  ],
};

const noop = () => {};
const unexpectedWrite = async () => {
  throw new Error("The viewer fixture must not write production data");
};
const actions: BoardActions = {
  upload: unexpectedWrite,
  start: unexpectedWrite,
  preview: unexpectedWrite,
  move: unexpectedWrite,
  choose: unexpectedWrite,
  note: unexpectedWrite,
  cancel: unexpectedWrite,
  retry: unexpectedWrite,
  change: unexpectedWrite,
};

function Fixture() {
  const [snapshot, setSnapshot] = useState(initial);
  const [revision, setRevision] = useState(0);
  const [openedPlan, setOpenedPlan] = useState("");

  function streamSnapshots() {
    let nextRevision = 0;
    function update() {
      nextRevision++;
      setRevision(nextRevision);
      setSnapshot((previous) => ({
        ...previous,
        entities: previous.entities.map((item) => ({
          ...item,
          updatedAt: item.updatedAt + 1,
        })),
        runs: [1, 2, 3].map((number) => ({
          _id: `run-${number}`,
          kind: "research",
          status: "running",
          activity: "Searching location sources",
          targetId: `scene-${number}`,
          scope: { kind: "scene", sceneId: `scene-${number}` },
          createdAt: 1,
          updatedAt: nextRevision,
        })),
      }));
      if (nextRevision < 100) requestAnimationFrame(update);
    }
    update();
  }

  return (
    <>
      <header style={{ height: 40 }}>
        <button onClick={streamSnapshots}>Stream snapshot updates</button>
        <output aria-label="Snapshot revision">{revision}</output>
        <output aria-label="Opened plan">{openedPlan}</output>
      </header>
      <div style={{ height: "calc(100vh - 40px)" }}>
        <BoardContext.Provider
          value={{
            snapshot,
            actions,
            act: async (operation) => {
              await operation();
            },
            previewMode: true,
            focus: noop,
            inspect: noop,
            edit: noop,
          }}
        >
          <ProductionOverview
            onUpload={noop}
            onSetup={noop}
            onScenes={noop}
            onPlan={setOpenedPlan}
            uploadProgress={null}
          />
        </BoardContext.Provider>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
