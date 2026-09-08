import type {
  BoardSnapshot,
  Entity,
  LocationData,
  SceneData,
  ScheduleData,
} from "./model";
import { proposeSchedule } from "./planning";
import { planReadiness } from "./plan-readiness";
import { scopedPlan } from "./scope";

export type PacketCheck = {
  key: string;
  label: string;
  state: "ready" | "needs_input" | "needs_refresh" | "unverified";
  detail: string;
};

/** Readiness follows saved inputs and selected locations for one plan. */
export function packetReadiness(snapshot: BoardSnapshot, planId?: string) {
  const plan = snapshot.entities.find(
    (e) => e.data.kind === "plan" && (!planId || e._id === planId),
  );
  if (!plan || plan.data.kind !== "plan") return null;
  const scoped = scopedPlan(plan, snapshot.entities, snapshot.choices);
  const planning = planReadiness(plan, snapshot.entities, snapshot.choices);
  const scenes = scoped.scenes as (Entity & { data: SceneData })[];
  const locations = scoped.locations as (Entity & { data: LocationData })[];
  const locationById = new Map(locations.map((e) => [e._id, e]));
  const assignments = scenes.flatMap((scene) => {
    const choice = scoped.choices.find((c) => c.sceneId === scene._id);
    const location = choice && locationById.get(choice.locationId);
    return location &&
      !location.data.rejected &&
      location.data.sceneIds.includes(scene._id)
      ? [{ scene, location }]
      : [];
  });
  const schedule = scoped.entities.find((e) => e.data.kind === "schedule") as
    (Entity & { data: ScheduleData }) | undefined;
  const packet = scoped.entities
    .filter((e) => e.data.kind === "packet")
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const data = packet?.data.kind === "packet" ? packet.data : null;
  const timing = proposeSchedule(
    plan._id,
    plan.data,
    scenes.map((scene) => {
      const location = assignments.find(
        (item) => item.scene._id === scene._id,
      )?.location;
      return {
        id: scene._id,
        data: scene.data,
        locationId: location?._id ?? "",
        locationName: location?.data.name ?? "Unselected",
      };
    }),
  );
  const questions = scoped.entities.filter(
    (e) =>
      e.data.kind === "question" &&
      (e.stale || e.data.resolution !== "answered"),
  );
  const requiredQuestions = questions.filter(
    (e) =>
      e.data.kind === "question" &&
      e.data.blocks.some((kind) => kind === "packet" || kind === "schedule"),
  );
  const missingLocations = scenes.length - assignments.length;
  const scheduleMatches =
    !!schedule &&
    schedule.data.entries.length === scenes.length &&
    scenes.every((scene) => {
      const assignment = assignments.find(
        (item) => item.scene._id === scene._id,
      );
      const entries = schedule.data.entries.filter(
        (entry) => entry.sceneId === scene._id,
      );
      return (
        entries.length === 1 &&
        entries[0].locationId === assignment?.location._id
      );
    });
  const scheduleCurrent =
    !!schedule &&
    !schedule.stale &&
    scheduleMatches &&
    !schedule.data.conflicts.length;
  const stale = scoped.entities.filter(
    (e) => e.stale && ["location", "cost", "requirement"].includes(e.data.kind),
  );
  const missingEvidence = locations.filter((e) => !e.data.sources.length);
  const costs = planning.costs;
  const missingCostEvidence = locations.filter((e) => !e.data.costs.length);
  const productionInputs = [
    ...planning.blockers,
    ...(!scenes.length ? ["Choose scenes for this shoot plan."] : []),
    ...(missingLocations
      ? [
          `Select a location for ${missingLocations} included scene${missingLocations === 1 ? "" : "s"}.`,
        ]
      : []),
    ...timing.conflicts,
    ...(plan.data.budgetMode === "fixed" && plan.data.budgetMinor === null
      ? ["Set the fixed budget cap or choose no fixed cap."]
      : []),
    ...requiredQuestions.map((e) =>
      e.data.kind === "question"
        ? `Answer before preparing: ${e.data.prompt}`
        : "",
    ),
    ...(!schedule
      ? ["Prepare a shooting schedule for this plan."]
      : !scheduleCurrent
        ? [
            "Refresh the shooting schedule to match the included scenes and selected locations.",
            ...schedule.data.conflicts,
          ]
        : []),
    ...(stale.length
      ? ["Refresh affected location, cost, and requirement evidence."]
      : []),
    ...missingEvidence.map(
      (e) => `Attach research evidence for ${e.data.name}.`,
    ),
  ];
  const externalFollowups = [
    ...locations.map((e) => `Confirm availability: ${e.data.name}.`),
    ...costs.unknown.map((label) => `Obtain a quote: ${label}.`),
    ...missingCostEvidence.map(
      (e) =>
        `No fee evidence recorded for ${e.data.name}; costs remain unquoted.`,
    ),
    ...costs.otherCurrencies.map(
      (label) => `Confirm currency conversion: ${label}.`,
    ),
    ...costs.conflicts,
    ...locations.flatMap((e) =>
      e.data.requirements.map(
        (req) =>
          `${e.data.name}: ${req.title} ${req.status === "sourced" ? "needs external confirmation; source guidance does not establish approval" : `is ${req.status}`}.`,
      ),
    ),
  ];
  const scopeMatches =
    !data?.includedSceneIds ||
    (data.includedSceneIds.length === scoped.sceneIds.length &&
      data.includedSceneIds.every((id) => scoped.sceneIds.includes(id)));
  const historical =
    !!packet &&
    (packet.stale ||
      !scheduleCurrent ||
      !scopeMatches ||
      (data?.sourcePlanRevision !== undefined &&
        data.sourcePlanRevision !== plan.revision) ||
      (data?.sourceScheduleRevision !== undefined &&
        data.sourceScheduleRevision !== schedule?.revision));
  const checks: PacketCheck[] = [
    {
      key: "locations",
      label: "Selected locations",
      state: scenes.length && !missingLocations ? "ready" : "needs_input",
      detail: `${assignments.length} of ${scenes.length} included scenes have a selected location.`,
    },
    {
      key: "timing",
      label: "Timing inputs",
      state: timing.conflicts.length ? "needs_input" : "ready",
      detail:
        timing.conflicts[0] ??
        `Saved dates, scene windows, durations, setup and move times (${plan.data.timingBasis}).`,
    },
    {
      key: "schedule",
      label: "Current schedule",
      state: scheduleCurrent
        ? "ready"
        : schedule
          ? "needs_refresh"
          : "needs_input",
      detail: scheduleCurrent
        ? `${schedule!.data.entries.length} scenes in the applied schedule, revision ${schedule!.revision}.`
        : schedule
          ? "Regenerate and apply a schedule matching this plan."
          : "Prepare the shooting schedule.",
    },
    {
      key: "evidence",
      label: "Attached evidence",
      state: stale.length
        ? "needs_refresh"
        : missingEvidence.length || !locations.length
          ? "needs_input"
          : "ready",
      detail: stale.length
        ? `${stale.length} saved evidence records need refresh.`
        : `${locations.length - missingEvidence.length} of ${locations.length} selected locations have research sources.`,
    },
    {
      key: "costs",
      label: "Cost confirmations",
      state:
        costs.unknown.length ||
        costs.otherCurrencies.length ||
        costs.conflicts.length
          ? "unverified"
          : "ready",
      detail: `${costs.unknown.length} unquoted items or locations · ${costs.otherCurrencies.length} currency conversions · ${costs.conflicts.length} evidence conflicts.`,
    },
    {
      key: "questions",
      label: "Production confirmations",
      state: requiredQuestions.length
        ? "needs_input"
        : questions.length
          ? "unverified"
          : "ready",
      detail: `${requiredQuestions.length} required answers before export · ${questions.length} unresolved production questions.`,
    },
    {
      key: "packet",
      label: "Packet status",
      state: historical ? "needs_refresh" : data ? "ready" : "needs_input",
      detail: historical
        ? "Historical draft: rebuild after applying the current schedule."
        : data
          ? "Saved preparation draft for this plan."
          : "Not prepared.",
    },
  ];
  return {
    plan,
    scenes,
    assignments,
    locations,
    schedule,
    packet,
    data,
    historical,
    checks,
    canBuild: productionInputs.length === 0,
    productionInputs: [...new Set(productionInputs)],
    externalFollowups: [...new Set(externalFollowups)],
    questions,
    costs,
  };
}
