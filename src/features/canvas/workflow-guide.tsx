"use client";
import { scopedPlan } from "../../domain/scope";
import { planReadiness } from "../../domain/plan-readiness";
import { packetReadiness } from "../../domain/packet";
import { currentRuns } from "./workflow-state";
import { useBoard } from "./board-context";

export function WorkflowGuide({
  onStage,
}: {
  onStage: (
    stage: "screenplay" | "scenes" | "locations" | "schedule" | "packet",
  ) => void;
}) {
  const { snapshot, activePlanId } = useBoard();
  const script = snapshot.entities.find((e) => e.data.kind === "script");
  const scenes = snapshot.entities.filter((e) => e.data.kind === "scene");
  const plan = snapshot.entities.find(
    (e) => e._id === activePlanId && e.data.kind === "plan",
  );
  const selection = plan
    ? scopedPlan(plan, snapshot.entities, snapshot.choices)
    : null;
  const ready = plan
    ? planReadiness(plan, snapshot.entities, snapshot.choices)
    : null;
  const packet = selection?.entities.find((e) => e.data.kind === "packet");
  const packetState = packetReadiness(snapshot, activePlanId);
  const runs = currentRuns(snapshot.runs)
    .filter((r) => !r.scope.planId || r.scope.planId === activePlanId)
    .filter(
      (r) => !r.scope.sceneId || selection?.sceneIds.includes(r.scope.sceneId),
    );
  const status = (
    complete: boolean,
    stale: boolean,
    kinds: string[],
    waiting = false,
  ) => {
    if (stale) return "Needs refresh";
    if (
      runs.some(
        (r) =>
          kinds.includes(r.kind) && ["queued", "running"].includes(r.status),
      )
    )
      return "Working";
    if (
      waiting ||
      runs.some((r) => kinds.includes(r.kind) && r.status === "waiting")
    )
      return "Waiting";
    return complete ? "Complete" : "Needs input";
  };
  const stages = [
    {
      id: "screenplay" as const,
      label: "Screenplay",
      state: status(!!script, !!script?.stale, ["ingest"]),
    },
    {
      id: "scenes" as const,
      label: "Scenes",
      state: status(
        !!selection?.sceneIds.length &&
          script?.data.kind === "script" &&
          scenes.length === script.data.sceneCount,
        !!selection?.scenes.some((e) => e.stale),
        ["scenes"],
      ),
    },
    {
      id: "locations" as const,
      label: "Locations",
      state: status(
        !!selection?.sceneIds.length &&
          selection.choices.length === selection.sceneIds.length &&
          selection.locations.every(
            (e) => e.data.kind === "location" && !e.data.rejected,
          ),
        !!plan?.stale ||
          !!selection?.entities.some(
            (e) =>
              e.stale &&
              ["scene", "location", "cost", "requirement"].includes(
                e.data.kind,
              ),
          ),
        ["research", "requirements"],
        !!selection?.entities.some(
          (e) =>
            e.data.kind === "question" &&
            e.data.resolution !== "answered" &&
            e.data.blocks.some((k) => ["research", "requirements"].includes(k)),
        ),
      ),
    },
    {
      id: "schedule" as const,
      label: "Shoot plan",
      state: status(
        !!ready?.currentSchedule,
        !!ready?.schedule?.stale,
        ["schedule"],
        !!ready?.blockers.length,
      ),
    },
    {
      id: "packet" as const,
      label: "Preparation packet",
      state: status(
        !!packet && !!ready?.currentSchedule && !packetState?.historical,
        !!packetState?.historical,
        ["packet"],
      ),
    },
  ];
  const next = stages.find((s) => s.state !== "Complete") ?? stages[4];
  return (
    <nav className="workflow-guide" aria-label="Production workflow">
      {stages.map((stage, index) => (
        <button
          key={stage.id}
          className={`workflow-stage ${next.id === stage.id ? "current" : ""}`}
          onClick={() => onStage(stage.id)}
          aria-current={next.id === stage.id ? "step" : undefined}
        >
          <span className="workflow-step">
            {stage.state === "Complete" ? "✓" : index + 1}
          </span>
          <span>
            <strong>{stage.label}</strong>
            <small>{stage.state}</small>
          </span>
        </button>
      ))}
    </nav>
  );
}
