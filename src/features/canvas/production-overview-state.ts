import type { BoardRun, BoardSnapshot, Entity } from "../../domain/model";
import { formatMoney } from "../../domain/planning";
import { planReadiness } from "../../domain/plan-readiness";
import { currentRuns, runHeadline } from "./workflow-state";

export function overviewSetupStage(snapshot: BoardSnapshot) {
  if (
    snapshot.choices.length ||
    snapshot.runs.some((run) =>
      ["research", "requirements", "schedule", "packet"].includes(run.kind),
    ) ||
    snapshot.entities.some((entity) =>
      ["location", "schedule", "packet"].includes(entity.data.kind),
    )
  )
    return "work";
  return snapshot.entities.some((entity) => entity.data.kind === "scene")
    ? "scenes"
    : "initial";
}

export type OverviewStatus = {
  label: string;
  detail?: string;
  tone: "idle" | "working" | "attention" | "ready";
};

function runStatus(run: BoardRun): OverviewStatus {
  return {
    label: runHeadline(run),
    tone:
      run.status === "running" || run.status === "queued"
        ? "working"
        : run.status === "complete"
          ? "ready"
          : "attention",
  };
}

/** Shared work belongs here only when it touches this plan's included scenes. */
export function overviewPlanState(plan: Entity, snapshot: BoardSnapshot) {
  if (plan.data.kind !== "plan") throw new Error("Expected a shoot plan");
  const ready = planReadiness(plan, snapshot.entities, snapshot.choices);
  const sceneIds = new Set(ready.sceneIds);
  const locationIds = new Set(ready.locations.map((location) => location._id));
  const runs = currentRuns(snapshot.runs).filter((run) => {
    if (run.scope.planId && run.scope.planId !== plan._id) return false;
    if (run.scope.sceneId && !sceneIds.has(run.scope.sceneId)) return false;
    if (run.scope.planId === plan._id || run.targetId === plan._id) return true;
    if (run.kind !== "research" && run.kind !== "requirements") return false;
    return (
      !!(run.scope.sceneId && sceneIds.has(run.scope.sceneId)) ||
      !!(
        run.targetId &&
        (sceneIds.has(run.targetId) || locationIds.has(run.targetId))
      )
    );
  });
  const pending = runs.filter((run) =>
    ["running", "queued", "waiting"].includes(run.status),
  );
  const work =
    pending.find((run) => run.status === "running") ??
    pending.find((run) => run.status === "queued") ??
    pending[0] ??
    runs.find((run) => run.status === "failed");
  const chosenCount = ready.scenes.filter((scene) =>
    ready.choices.some(
      (choice) =>
        choice.sceneId === scene._id &&
        ready.locations.some(
          (location) =>
            location._id === choice.locationId &&
            location.data.kind === "location" &&
            !location.data.rejected &&
            location.data.sceneIds.includes(scene._id),
        ),
    ),
  ).length;
  const currentSchedule = ready.currentSchedule && !ready.blockers.length;
  let status: OverviewStatus;
  if (work) {
    status = {
      ...runStatus(work),
      detail:
        pending.length > 1
          ? `${pending.length} tasks in progress for these scenes`
          : !work.scope.planId && work.kind === "research"
            ? "Shared research for an included scene"
            : work.status === "failed"
              ? "Open the plan to review and retry."
              : "Saved work continues in this plan.",
    };
  } else if (currentSchedule) {
    status = { label: "Current schedule ready", tone: "ready" };
  } else if (!ready.sceneIds.length) {
    status = { label: "Choose scenes for this plan", tone: "idle" };
  } else if (plan.stale || ready.schedule?.stale) {
    status = { label: "Plan needs a refresh", tone: "attention" };
  } else if (chosenCount < ready.sceneIds.length) {
    status = { label: "Choose filming locations", tone: "idle" };
  } else if (ready.blockers.length) {
    status = {
      label: "Production details needed",
      detail: ready.blockers[0],
      tone: "attention",
    };
  } else {
    status = { label: "Ready to build a schedule", tone: "idle" };
  }
  return {
    plan,
    name: plan.data.name,
    budgetMode: plan.data.budgetMode,
    budget:
      plan.data.budgetMode === "uncapped"
        ? "No fixed cap"
        : plan.data.budgetMinor === null
          ? "Budget cap not set"
          : `${formatMoney(plan.data.budgetMinor, plan.data.currency)} cap`,
    sceneCount: ready.sceneIds.length,
    chosenCount,
    currentSchedule,
    scheduleLabel: currentSchedule
      ? "Current schedule"
      : ready.schedule
        ? "Schedule needs review"
        : "Schedule not built",
    status,
    runs,
  };
}

export function screenplayStatus(
  snapshot: BoardSnapshot,
  script: Entity | undefined,
  sceneCount: number,
  uploadProgress: number | null,
): OverviewStatus {
  if (uploadProgress !== null)
    return {
      label:
        uploadProgress >= 100
          ? "Upload received · starting first read"
          : `Uploading screenplay · ${Math.round(uploadProgress)}%`,
      tone: "working",
    };
  const runs = currentRuns(snapshot.runs).filter((run) =>
    ["ingest", "scenes"].includes(run.kind),
  );
  const pending = runs.find((run) =>
    ["running", "queued", "waiting", "failed"].includes(run.status),
  );
  if (pending) {
    const status = runStatus(pending);
    if (pending.kind === "scenes" && pending.status === "running")
      status.label = "Breaking down screenplay scenes…";
    return status;
  }
  if (script?.stale)
    return { label: "Screenplay needs review", tone: "attention" };
  if (
    snapshot.entities.some(
      (entity) =>
        entity.data.kind === "question" &&
        entity.scope.kind === "workspace" &&
        entity.data.resolution !== "answered" &&
        entity.data.blocks.includes("scenes"),
    )
  )
    return { label: "Shared production details needed", tone: "attention" };
  if (
    sceneCount > 0 &&
    script?.data.kind === "script" &&
    sceneCount >= script.data.sceneCount
  )
    return { label: "Scene breakdown available", tone: "ready" };
  return {
    label: script
      ? "Shared scene breakdown pending"
      : "Your screenplay starts here",
    tone: "idle",
  };
}
