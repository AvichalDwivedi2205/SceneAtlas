import type { Choice, Cost, Entity, PlanData, SceneData } from "./model";
import { proposeSchedule, summarizeCosts } from "./planning";
import { scopedPlan } from "./scope";

export function planCostItems(
  locations: { _id: string; data: Entity["data"] }[],
  currency: string,
): Cost[] {
  return locations.flatMap((location) =>
    location.data.kind !== "location"
      ? []
      : location.data.costs.length
        ? location.data.costs
        : [
            {
              id: `${location._id}:unquoted`,
              label: `${location.data.name}: filming fees need a quote`,
              amountMinor: null,
              currency,
              unit: "location" as const,
              quantity: 1,
              basis: "unknown" as const,
              coverageKey: `${location._id}:unquoted`,
              coverageReason: "No fee evidence attached",
              assumptions:
                "Confirm applicable fees with the location authority.",
            },
          ],
  );
}

export function planReadiness<
  T extends Pick<Entity, "_id" | "data" | "scope" | "stale" | "ownerId">,
>(plan: T, all: T[], choices: (Choice & { planId: string })[]) {
  const selection = scopedPlan(plan, all, choices);
  const data = plan.data as PlanData;
  const blockers: string[] = [];
  if (plan.stale)
    blockers.push(
      "Refresh this plan's location research for its changed production answers.",
    );
  if (!selection.scenes.length)
    blockers.push("Choose scenes for this shoot plan.");
  if (data.budgetMode === "fixed" && data.budgetMinor === null)
    blockers.push("Enter the Budget plan's fixed cap.");
  for (const scene of selection.scenes) {
    if (scene.stale)
      blockers.push(
        `Scene ${(scene.data as SceneData).number}: refresh location research for its changed needs.`,
      );
    const choice = selection.choices.find((c) => c.sceneId === scene._id);
    if (
      !choice ||
      !selection.locations.some(
        (l) =>
          l._id === choice.locationId &&
          l.data.kind === "location" &&
          !l.data.rejected &&
          l.data.sceneIds.includes(scene._id),
      )
    )
      blockers.push(
        `Scene ${(scene.data as SceneData).number}: select a filming location.`,
      );
  }
  for (const entity of selection.entities) {
    if (
      entity.data.kind === "question" &&
      entity.data.resolution !== "answered" &&
      entity.data.blocks.includes("schedule")
    )
      blockers.push(entity.data.prompt);
    if (
      entity.stale &&
      ["location", "cost", "requirement"].includes(entity.data.kind)
    )
      blockers.push("Refresh selected location evidence.");
  }
  const inputs = selection.scenes.flatMap((scene) => {
    const choice = selection.choices.find((c) => c.sceneId === scene._id);
    const location = selection.locations.find(
      (l) => l._id === choice?.locationId,
    );
    return location?.data.kind === "location"
      ? [
          {
            id: scene._id,
            data: scene.data as SceneData,
            locationId: location._id,
            locationName: location.data.name,
          },
        ]
      : [];
  });
  const proposed = proposeSchedule(plan._id, data, inputs);
  blockers.push(...proposed.conflicts);
  const schedule = selection.entities.find((e) => e.data.kind === "schedule");
  const scheduled = schedule?.data.kind === "schedule" ? schedule.data : null;
  const expectedIds = [...selection.sceneIds].sort();
  const currentSchedule =
    !!scheduled &&
    !schedule?.stale &&
    !scheduled.conflicts.length &&
    expectedIds.length > 0 &&
    JSON.stringify(scheduled.entries.map((e) => e.sceneId).sort()) ===
      JSON.stringify(expectedIds) &&
    scheduled.entries.every((e) =>
      selection.choices.some(
        (c) => c.sceneId === e.sceneId && c.locationId === e.locationId,
      ),
    );
  const costs = summarizeCosts(
    planCostItems(selection.locations, data.currency),
    data.currency,
    data.budgetMode === "fixed" ? data.budgetMinor : null,
  );
  return {
    ...selection,
    blockers: [...new Set(blockers)],
    proposed,
    schedule,
    currentSchedule,
    costs,
  };
}
