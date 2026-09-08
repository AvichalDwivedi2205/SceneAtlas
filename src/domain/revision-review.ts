import type {
  BoardSnapshot,
  Entity,
  EntityData,
  PlanData,
  ScheduleData,
} from "./model";
import { effectivePlanSceneIds } from "./scope";
import { formatTime } from "./planning";

export type InputDifference = {
  field: string;
  label: string;
  before: string;
  after: string;
};
export type DecisionBaseline = {
  choices: {
    planId: string;
    sceneId: string;
    locationId: string;
    locked: boolean;
    revision: number;
  }[];
  answers: { id: string; revision: number; answer: string | null }[];
};

const labels: Record<string, string> = {
  name: "Plan name",
  budgetMode: "Budget setting",
  budgetMinor: "Budget cap",
  currency: "Currency",
  priority: "Planning priority",
  idealShoot: "Creative priorities",
  rules: "Production rules",
  dates: "Shooting dates",
  timezone: "Timezone",
  dayStart: "Production start",
  dayEnd: "Production end",
  moveMinutes: "Move time",
  setupMinutes: "Setup time",
  timingBasis: "Timing basis",
  sceneScope: "Included scenes",
  number: "Scene number",
  heading: "Scene heading",
  excerpt: "Screenplay excerpt",
  pageStart: "First page",
  pageEnd: "Last page",
  setting: "Setting",
  interiorExterior: "Interior / exterior",
  timeOfDay: "Time of day",
  needs: "Location needs",
  durationMinutes: "Scene duration",
  durationBasis: "Duration basis",
  candidateCount: "Candidates requested",
  ranking: "Candidate priority",
  windows: "Allowed scene windows",
  answer: "Production answer",
  resolution: "Answer status",
  rule: "Interpreted production rule",
  text: "Production note",
};

function sceneScopeLabel(plan: PlanData, entities: Entity[]) {
  const sceneIds = new Set(effectivePlanSceneIds(plan, entities));
  const numbers = entities
    .filter(
      (entity) => entity.data.kind === "scene" && sceneIds.has(entity._id),
    )
    .map((entity) => (entity.data.kind === "scene" ? entity.data.number : 0))
    .sort((a, b) => a - b);
  const mode =
    !plan.sceneScope || plan.sceneScope.mode === "all"
      ? "All scenes"
      : "Selected scenes";
  return `${mode} · ${sceneIds.size} included${numbers.length ? ` · Scenes ${numbers.join(", ")}` : " · Choose scenes before planning"}`;
}

function fieldValue(
  data: EntityData,
  field: string,
  value: unknown,
  entities: Entity[],
): string {
  if (data.kind === "plan" && field === "sceneScope")
    return sceneScopeLabel(data, entities);
  if (value === undefined || value === null || value === "")
    return "Not supplied";
  if (field === "dayStart" || field === "dayEnd")
    return formatTime(Number(value));
  if (
    field === "moveMinutes" ||
    field === "setupMinutes" ||
    field === "durationMinutes"
  )
    return `${value} minutes`;
  if (data.kind === "plan" && field === "budgetMinor")
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: data.currency,
    }).format(Number(value) / 100);
  if (field === "budgetMode")
    return value === "uncapped" ? "No fixed cap" : "Fixed cap";
  if (Array.isArray(value)) {
    if (!value.length) return "None saved";
    if (field === "windows")
      return value
        .map(
          (window) =>
            `${window.date}: ${formatTime(window.start)}–${formatTime(window.end)}`,
        )
        .join("; ");
    if (field === "rules")
      return value
        .map(
          (rule) =>
            `${rule.strength}: ${rule.explanation} (${rule.field}: ${Array.isArray(rule.value) ? rule.value.join(", ") : rule.value})`,
        )
        .join("; ");
    return value.join(", ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function revisionInputChanges(
  before: EntityData | undefined,
  after: EntityData | undefined,
  entities: Entity[],
): InputDifference[] {
  if (!before || !after || before.kind !== after.kind) return [];
  const previous = before as unknown as Record<string, unknown>;
  const proposed = after as unknown as Record<string, unknown>;
  return [...new Set([...Object.keys(previous), ...Object.keys(proposed)])]
    .filter(
      (field) =>
        field !== "kind" &&
        JSON.stringify(previous[field]) !== JSON.stringify(proposed[field]),
    )
    .map((field) => ({
      field,
      label: labels[field] ?? field,
      before: fieldValue(before, field, previous[field], entities),
      after: fieldValue(after, field, proposed[field], entities),
    }));
}

export function isStartTimeChange(changes: InputDifference[]) {
  return changes.length === 1 && changes[0].field === "dayStart";
}

export function lockedSceneExclusions(
  planId: string | undefined,
  before: EntityData | undefined,
  after: EntityData | undefined,
  snapshot: BoardSnapshot,
) {
  if (!planId || before?.kind !== "plan" || after?.kind !== "plan") return [];
  const previous = new Set(effectivePlanSceneIds(before, snapshot.entities));
  const next = new Set(effectivePlanSceneIds(after, snapshot.entities));
  return snapshot.choices.filter(
    (choice) =>
      choice.planId === planId &&
      choice.locked &&
      previous.has(choice.sceneId) &&
      !next.has(choice.sceneId),
  );
}

export function decisionPreservation(
  baseline: DecisionBaseline | undefined,
  snapshot: BoardSnapshot,
) {
  if (!baseline) return;
  return {
    choices: baseline.choices.map((saved) => {
      const current = snapshot.choices.find(
        (choice) =>
          choice.planId === saved.planId && choice.sceneId === saved.sceneId,
      );
      return {
        saved,
        current,
        unchanged:
          !!current &&
          current.locationId === saved.locationId &&
          current.locked === saved.locked &&
          current.revision === saved.revision,
      };
    }),
    answers: baseline.answers.map((saved) => {
      const current = snapshot.entities.find(
        (entity) => entity._id === saved.id && entity.data.kind === "question",
      );
      return {
        saved,
        current,
        unchanged:
          current?.data.kind === "question" &&
          current.data.answer === saved.answer &&
          current.revision === saved.revision &&
          !current.stale,
      };
    }),
  };
}

export function scheduleRowChanges(
  before: ScheduleData | undefined,
  after: ScheduleData,
) {
  const previous = new Map(
    before?.entries.map((entry) => [entry.sceneId, entry]) ?? [],
  );
  const proposed = new Map(
    after.entries.map((entry) => [entry.sceneId, entry]),
  );
  return [...new Set([...previous.keys(), ...proposed.keys()])]
    .map((sceneId) => ({
      sceneId,
      before: previous.get(sceneId),
      after: proposed.get(sceneId),
      changed:
        JSON.stringify(previous.get(sceneId)) !==
        JSON.stringify(proposed.get(sceneId)),
    }))
    .sort(
      (a, b) =>
        (a.after ?? a.before)!.sceneNumber - (b.after ?? b.before)!.sceneNumber,
    );
}
