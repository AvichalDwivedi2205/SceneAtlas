import type { BoardRun, Entity, LocationData, Source } from "./model";

export type ResearchEvent = {
  _id: string;
  activity: string;
  createdAt: number;
  sequence: number;
  attempt: number;
  providerId?: string;
  research?: unknown;
};

export type ResearchExecution = {
  operation: "search" | "extract";
  phase: "request" | "complete" | "failed";
  objective?: string;
  queries: string[];
  urls: string[];
  retrievedAt?: number;
  cached?: boolean;
  requestId?: string;
  resultCount?: number;
  error?: string;
};

export function safeSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** Render only saved provider telemetry, never arbitrary event/model payloads. */
export function researchExecution(
  value: unknown,
): ResearchExecution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  if (
    !["search", "extract"].includes(String(item.operation)) ||
    !["request", "complete", "failed"].includes(String(item.phase))
  )
    return;
  const strings = (key: string) =>
    Array.isArray(item[key])
      ? (item[key] as unknown[]).filter(
          (part): part is string => typeof part === "string",
        )
      : [];
  const number = (key: string) =>
    typeof item[key] === "number" && Number.isFinite(item[key])
      ? (item[key] as number)
      : undefined;
  return {
    operation: item.operation as ResearchExecution["operation"],
    phase: item.phase as ResearchExecution["phase"],
    objective: typeof item.objective === "string" ? item.objective : undefined,
    queries: strings("queries"),
    urls: strings("urls").filter((url) => !!safeSourceUrl(url)),
    retrievedAt: number("retrievedAt"),
    cached: typeof item.cached === "boolean" ? item.cached : undefined,
    requestId: typeof item.requestId === "string" ? item.requestId : undefined,
    resultCount: number("resultCount"),
    error: typeof item.error === "string" ? item.error : undefined,
  };
}

export function locationEvidence(location: LocationData): Source[] {
  const unique = new Map<string, Source>();
  for (const source of [
    ...location.sources,
    ...location.costs.flatMap((cost) => (cost.source ? [cost.source] : [])),
    ...location.requirements.flatMap((requirement) => requirement.sources),
  ]) {
    const key = JSON.stringify([
      source.url,
      source.searchId,
      source.retrievedAt,
      source.cached,
    ]);
    if (!unique.has(key)) unique.set(key, source);
  }
  return [...unique.values()];
}

export function candidateLocations(
  entities: Entity[],
  sceneId: string,
  planId?: string,
) {
  return entities.filter(
    (entity): entity is Entity & { data: LocationData } =>
      entity.data.kind === "location" &&
      !entity.data.rejected &&
      entity.data.sceneIds.includes(sceneId) &&
      (!entity.scope.planId || entity.scope.planId === planId),
  );
}

export function evidenceRuns(
  runs: BoardRun[],
  entity: Entity,
  entities: Entity[],
  planId?: string,
) {
  const targetIds = new Set([entity._id]);
  if (entity.data.kind === "location")
    entity.data.sceneIds.forEach((id) => targetIds.add(id));
  if (entity.data.kind === "scene")
    candidateLocations(entities, entity._id, planId).forEach((candidate) =>
      targetIds.add(candidate._id),
    );
  return runs
    .filter(
      (run) =>
        ["research", "requirements"].includes(run.kind) &&
        !!run.targetId &&
        targetIds.has(run.targetId) &&
        (!run.scope.planId || run.scope.planId === planId),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
}
