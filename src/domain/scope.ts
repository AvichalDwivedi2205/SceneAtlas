import type { Choice, EntityData, PlanData, Scope, TaskKind } from "./model";

type Record = { _id: string; data: EntityData; scope: Scope; ownerId?: string };
type PlanChoice = Choice & { planId: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Generated child cards omitted by a refresh are historical, not active blockers. */
export function isCurrentLocationEvidence(
  entity: Pick<Record, "data">,
  location?: Pick<Record, "data">,
): boolean {
  const data = entity.data;
  if (data.kind !== "cost" && data.kind !== "requirement") return true;
  if (location?.data.kind !== "location") return false;
  if (data.kind === "cost")
    return canonical(data.items) === canonical(location.data.costs);
  const evidence = Object.fromEntries(
    Object.entries(data).filter(
      ([key]) => key !== "kind" && key !== "locationId",
    ),
  );
  return location.data.requirements.some(
    (requirement) => canonical(requirement) === canonical(evidence),
  );
}

/** Membership is independent of canvas visibility and never grants board access. */
export function effectivePlanSceneIds(
  plan: PlanData,
  scenes: readonly Pick<Record, "_id" | "data">[],
): string[] {
  const available = scenes.filter((e) => e.data.kind === "scene");
  if (!plan.sceneScope || plan.sceneScope.mode === "all")
    return available.map((e) => e._id);
  const included = new Set(plan.sceneScope.sceneIds);
  return available.filter((e) => included.has(e._id)).map((e) => e._id);
}

export function scopedPlan<T extends Record, C extends PlanChoice>(
  plan: Pick<Record, "_id" | "data">,
  all: readonly T[],
  savedChoices: readonly C[] = [],
  includeCandidates = false,
) {
  const sceneIds =
    plan.data.kind === "plan" ? effectivePlanSceneIds(plan.data, all) : [];
  const membership = new Set(sceneIds);
  const scenes = all.filter(
    (e) => e.data.kind === "scene" && membership.has(e._id),
  );
  const choices = savedChoices.filter(
    (c) => c.planId === plan._id && membership.has(c.sceneId),
  );
  const locationIds = new Set(choices.map((c) => c.locationId));
  const locations = all.filter(
    (e) =>
      e.data.kind === "location" &&
      (locationIds.has(e._id) ||
        (includeCandidates &&
          e.data.sceneIds.some((id) => membership.has(id)))),
  );
  const relevantLocations = new Set(locations.map((e) => e._id));
  const entities = all.filter((e) => {
    const d = e.data;
    if (d.kind === "plan") return e._id === plan._id;
    if (d.kind === "scene") return membership.has(e._id);
    if (d.kind === "location") return relevantLocations.has(e._id);
    if (d.kind === "cost" || d.kind === "requirement")
      return (
        relevantLocations.has(d.locationId) &&
        isCurrentLocationEvidence(
          e,
          locations.find((l) => l._id === d.locationId),
        )
      );
    if (d.kind === "schedule" || d.kind === "packet")
      return d.planId === plan._id;
    if (e.scope.planId && e.scope.planId !== plan._id) return false;
    if (e.scope.kind === "plan_scene" && !membership.has(e.scope.sceneId!))
      return false;
    // Location-owned confirmations follow the location, even if first found for another scene.
    if (
      e.ownerId &&
      all.some(
        (owner) => owner._id === e.ownerId && owner.data.kind === "location",
      )
    )
      return relevantLocations.has(e.ownerId);
    if (e.scope.kind === "workspace") return true;
    if (e.scope.sceneId) return membership.has(e.scope.sceneId);
    return e.scope.planId === plan._id;
  });
  return { sceneIds, scenes, choices, locations, entities };
}

export function scopeEntities<T extends Record, C extends PlanChoice>(
  all: readonly T[],
  scope: Scope,
  targetId?: string,
  choices: readonly C[] = [],
  kind?: TaskKind,
): T[] {
  if (scope.kind === "workspace") return [...all];
  let candidates = [...all];
  if (scope.planId) {
    const plan = all.find(
      (e) => e._id === scope.planId && e.data.kind === "plan",
    );
    if (!plan) return [];
    candidates = scopedPlan(
      plan,
      all,
      choices,
      !["schedule", "packet"].includes(kind ?? ""),
    ).entities;
  }
  if (!scope.sceneId) return candidates;
  const locationIds = new Set(
    candidates
      .filter(
        (e) =>
          e.data.kind === "location" &&
          e.data.sceneIds.includes(scope.sceneId!),
      )
      .map((e) => e._id),
  );
  return candidates.filter((e) => {
    if (e.scope.planId && e.scope.planId !== scope.planId) return false;
    if (e.scope.kind === "plan_scene" && e.scope.sceneId !== scope.sceneId)
      return false;
    if (e.data.kind === "scene") return e._id === scope.sceneId;
    if (e.data.kind === "location") return locationIds.has(e._id);
    if (e.data.kind === "cost" || e.data.kind === "requirement")
      return (
        locationIds.has(e.data.locationId) &&
        isCurrentLocationEvidence(
          e,
          candidates.find(
            (l) => l._id === (e.data as { locationId: string }).locationId,
          ),
        )
      );
    if (e.data.kind === "plan") return e._id === scope.planId;
    if (e.data.kind === "schedule" || e.data.kind === "packet") return false;
    if (e.ownerId && locationIds.has(e.ownerId)) return true;
    return (
      e.scope.kind === "workspace" ||
      e._id === targetId ||
      ((!e.scope.planId || e.scope.planId === scope.planId) &&
        e.scope.sceneId === scope.sceneId) ||
      (e.scope.kind === "plan" && e.scope.planId === scope.planId)
    );
  });
}
