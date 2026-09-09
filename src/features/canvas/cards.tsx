"use client";
import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleHelp,
  FileText,
  GitBranch,
  MapPin,
  LockKeyhole,
  Pencil,
  Sparkles,
  Clock3,
  ReceiptText,
  ShieldCheck,
  StickyNote,
  AlertCircle,
} from "lucide-react";
import type { Entity, QuestionData } from "../../domain/model";
import { formatMoney, summarizeCosts } from "../../domain/planning";
import {
  effectivePlanSceneIds,
  scopedPlan,
  isCurrentLocationEvidence,
} from "../../domain/scope";
import { planCostItems } from "../../domain/plan-readiness";
import { useBoard } from "./board-context";
import { AsyncButton } from "../../components/async-button";
import { latestRun, RunState, TaskButton } from "./workflow-state";
export type CardNode = Node<{ entity: Entity }, "card">;
const icons = {
  script: FileText,
  scene: FileText,
  question: CircleHelp,
  answer: Check,
  location: MapPin,
  cost: ReceiptText,
  requirement: ShieldCheck,
  plan: GitBranch,
  schedule: Clock3,
  packet: FileText,
  note: StickyNote,
};
export function titleFor(entity: Entity): string {
  const d = entity.data;
  switch (d.kind) {
    case "script":
      return d.filename;
    case "scene":
      return `Scene ${d.number} · ${d.setting}`;
    case "question":
      return d.resolution === "answered"
        ? "Decision saved"
        : "A decision to make";
    case "answer":
      return "Saved production input";
    case "location":
      return d.name;
    case "cost":
      return "Location costs";
    case "requirement":
      return d.title;
    case "plan":
      return d.name;
    case "schedule":
      return "Proposed shooting order";
    case "packet":
      return "Preparation packet";
    case "note":
      return "Production note";
  }
}
export const ProductionCard = memo(function ProductionCard({
  data,
  selected,
}: NodeProps<CardNode>) {
  const {
    snapshot,
    actions,
    activePlanId,
    previewMode,
    focus,
    inspect,
    edit,
    act,
  } = useBoard();
  const entity = data.entity;
  const d = entity.data;
  const historicalEvidence =
    (d.kind === "requirement" || d.kind === "cost") &&
    !isCurrentLocationEvidence(
      entity,
      snapshot.entities.find((e) => e._id === d.locationId),
    );
  const Icon = icons[d.kind];
  const editable = snapshot.role !== "viewer" && !previewMode;
  const latest = latestRun(snapshot.runs, undefined, entity._id);
  const run =
    latest && ["queued", "running", "waiting", "failed"].includes(latest.status)
      ? latest
      : undefined;
  const scriptScenes = snapshot.entities.filter((e) => e.data.kind === "scene");
  return (
    <article
      className={`production-card type-${d.kind} ${selected ? "is-selected" : ""} ${entity.stale ? "is-stale" : ""} ${run?.status === "running" ? "is-working" : ""}`}
    >
      <Handle type="target" position={Position.Top} />
      <header className="node-header">
        <span className="node-icon">
          <Icon size={15} />
        </span>
        <div>
          <span className="node-kicker">
            {d.kind === "scene"
              ? `SCENE ${String(d.number).padStart(2, "0")}`
              : d.kind === "script"
                ? "THE SCREENPLAY"
                : d.kind === "question"
                  ? d.resolution === "answered"
                    ? "ANSWER SAVED"
                    : "NEEDS YOUR ANSWER"
                  : d.kind.toUpperCase()}
          </span>
          <h3>{titleFor(entity)}</h3>
        </div>
        <button
          className="icon-button nodrag"
          aria-label={`Inspect ${titleFor(entity)}`}
          onClick={() => inspect(entity)}
        >
          <ArrowUpRight size={15} />
        </button>
      </header>
      {historicalEvidence && (
        <p className="notice">
          Historical evidence · omitted from current plan inputs
        </p>
      )}
      {d.kind === "answer" ? (
        <div className="answer-body">
          <p>{d.question}</p>
          <div>
            <strong>{d.original}</strong>
            <button
              className="button tiny quiet nodrag"
              onClick={() => {
                const q = snapshot.entities.find((e) => e._id === d.questionId);
                if (q) {
                  if (editable) edit(q);
                  else inspect(q);
                }
              }}
            >
              Review <ChevronRight size={12} />
            </button>
          </div>
          {d.resolution === "unknown" && (
            <span className="badge clay-badge">Still unresolved</span>
          )}
        </div>
      ) : (
        <div className="node-body">
          {d.kind === "script" && (
            <>
              <p className="node-meta">
                {d.pageCount} pages · {scriptScenes.length || d.sceneCount}{" "}
                scenes
              </p>
              <p>{d.summary}</p>
              <div className="chip-row">
                {scriptScenes.slice(0, 6).map((e) => (
                  <button
                    key={e._id}
                    className="chip nodrag"
                    onClick={() => focus(e._id)}
                  >
                    Scene {e.data.kind === "scene" ? e.data.number : ""}
                  </button>
                ))}
              </div>
              {!scriptScenes.length && (
                <TaskButton
                  kind={"scenes"}
                  targetId={entity._id}
                  className="button primary nodrag"
                  disabled={!editable}
                  onClick={() =>
                    act(() =>
                      actions.start("scenes", entity._id, {
                        kind: "workspace",
                      }),
                    )
                  }
                >
                  <Sparkles size={14} /> Generate scenes
                </TaskButton>
              )}
              <div className="node-footer">
                <span className="dot brass" /> Shared production decisions start
                here.
              </div>
            </>
          )}
          {d.kind === "scene" && (
            <>
              <p className="node-meta">
                {d.interiorExterior} · {d.timeOfDay} ·{" "}
                {d.durationMinutes
                  ? `${d.durationMinutes} min (${d.durationBasis})`
                  : "Duration unknown"}
              </p>
              <blockquote>
                “{d.excerpt.slice(0, 160)}
                {d.excerpt.length > 160 ? "…" : ""}”
              </blockquote>
              <div className="chip-row">
                {d.needs.slice(0, 3).map((n) => (
                  <span className="chip" key={n}>
                    {n}
                  </span>
                ))}
              </div>
              <div className="node-row">
                <span>Candidates requested</span>
                <strong>{d.candidateCount}</strong>
              </div>
              <div className="actions">
                <TaskButton
                  kind={"research"}
                  targetId={entity._id}
                  className="button primary small-button nodrag"
                  disabled={!editable}
                  onClick={() =>
                    act(() =>
                      actions.start("research", entity._id, entity.scope),
                    )
                  }
                >
                  <Sparkles size={13} />{" "}
                  {snapshot.entities.some(
                    (e) =>
                      e.data.kind === "location" &&
                      e.data.sceneIds.includes(entity._id),
                  )
                    ? "Research again"
                    : "Find locations"}
                </TaskButton>
                <button
                  className="icon-button nodrag"
                  disabled={!editable}
                  aria-label={`Edit scene ${d.number}`}
                  onClick={() => edit(entity)}
                >
                  <Pencil size={14} />
                </button>
              </div>
            </>
          )}
          {d.kind === "question" && (
            <QuestionBody
              data={d}
              onAnswer={() => edit(entity)}
              editable={editable}
            />
          )}
          {d.kind === "location" && (
            <>
              <div className="location-visual">
                <MapPin size={28} />
                <span>{d.address || "See sourced location description"}</span>
              </div>
              <p className="fit-copy">{d.creativeFit}</p>
              <div className="chip-row">
                <span className="badge moss-badge">
                  <Check size={11} />
                  {d.sources.length} source{d.sources.length !== 1 ? "s" : ""}
                </span>
                {d.sceneIds.length > 1 && (
                  <span className="badge brass-badge">
                    Shared · {d.sceneIds.length} scenes
                  </span>
                )}
              </div>
              <div className="node-row">
                <span>Availability</span>
                <span className="muted">Unverified</span>
              </div>
              <div className="location-choice-list">
                {d.sceneIds.map((sceneId) => {
                  const scene = snapshot.entities.find(
                    (candidate) => candidate._id === sceneId,
                  );
                  const choice = snapshot.choices.find(
                    (candidate) =>
                      candidate.planId === activePlanId &&
                      candidate.sceneId === sceneId,
                  );
                  const selectedLocation = choice?.locationId === entity._id;
                  const sceneLabel =
                    scene?.data.kind === "scene"
                      ? `Scene ${scene.data.number}`
                      : "Scene";
                  return (
                    <AsyncButton
                      pendingLabel="Saving selection…"
                      key={sceneId}
                      className={`button small-button nodrag ${selectedLocation ? "selected-choice" : "quiet"}`}
                      disabled={
                        !editable ||
                        !activePlanId ||
                        !snapshot.entities.some(
                          (p) =>
                            p._id === activePlanId &&
                            p.data.kind === "plan" &&
                            effectivePlanSceneIds(
                              p.data,
                              snapshot.entities,
                            ).includes(sceneId),
                        )
                      }
                      onClick={() =>
                        act(
                          () =>
                            actions.choose(
                              activePlanId!,
                              sceneId,
                              entity._id,
                              selectedLocation ? !choice?.locked : false,
                              choice?.revision ?? 0,
                            ),
                          selectedLocation
                            ? `${sceneLabel} location lock updated`
                            : `${sceneLabel} location selected`,
                        )
                      }
                    >
                      <span>{sceneLabel}</span>
                      <strong>
                        {selectedLocation ? (
                          choice?.locked ? (
                            <>
                              <LockKeyhole size={13} /> Locked
                            </>
                          ) : (
                            <>
                              <Check size={13} /> Selected · lock
                            </>
                          )
                        ) : (
                          "Select"
                        )}
                      </strong>
                    </AsyncButton>
                  );
                })}
              </div>
              <div className="actions location-actions">
                <button
                  className="button small-button quiet nodrag"
                  onClick={() => inspect(entity)}
                >
                  Evidence <ArrowUpRight size={12} />
                </button>
              </div>
            </>
          )}
          {d.kind === "cost" && (
            <>
              {d.items.slice(0, 4).map((c) => (
                <div className="node-row" key={c.id}>
                  <span>
                    {c.label}
                    <small>
                      {c.basis} · per {c.unit}
                    </small>
                  </span>
                  <strong>
                    {c.amountMinor === null
                      ? "Unquoted"
                      : `${c.basis === "estimate" ? "~" : ""}${formatMoney(c.amountMinor, c.currency)}`}
                  </strong>
                </div>
              ))}
              {!d.items.length && <p>Costs have not been verified.</p>}
              <p className="small muted">
                Shared charges follow their documented coverage.
              </p>
            </>
          )}
          {d.kind === "requirement" && (
            <>
              <span
                className={`badge ${d.status === "sourced" ? "moss-badge" : "clay-badge"}`}
              >
                {d.status}
              </span>
              <p>{d.detail.slice(0, 200)}</p>
              <div className="node-footer">
                {d.authority} · {d.externalStatus}
              </div>
            </>
          )}
          {d.kind === "plan" && (
            <>
              <div className="plan-budget">
                {d.budgetMode === "uncapped"
                  ? "No fixed location cap"
                  : d.budgetMinor
                    ? `${formatMoney(d.budgetMinor, d.currency)} location cap`
                    : "Set location budget"}
              </div>
              <p>
                {d.idealShoot ||
                  {
                    cost: "Prioritize lower location costs.",
                    creative: "Prioritize creative fit.",
                    moves: "Keep location moves down.",
                    days: "Use fewer shooting days.",
                  }[d.priority]}
              </p>
              <PlanTotals planId={entity._id} />
              <div className="actions">
                <TaskButton
                  kind={"schedule"}
                  targetId={entity._id}
                  className="button small-button primary nodrag"
                  disabled={!editable}
                  onClick={() =>
                    act(() =>
                      actions.start("schedule", entity._id, entity.scope),
                    )
                  }
                >
                  Plan schedule <ArrowUpRight size={13} />
                </TaskButton>
                <button
                  className="icon-button nodrag"
                  aria-label={`Edit ${d.name}`}
                  disabled={!editable}
                  onClick={() => edit(entity)}
                >
                  <Pencil size={14} />
                </button>
              </div>
            </>
          )}
          {d.kind === "schedule" && (
            <>
              {d.entries.slice(0, 3).map((e) => (
                <div className="node-row" key={e.sceneId}>
                  <span>
                    Scene {e.sceneNumber}
                    <small>{e.locationName}</small>
                  </span>
                  <span>{e.date}</span>
                </div>
              ))}
              {d.conflicts.length > 0 && (
                <p className="error">
                  <AlertCircle size={12} /> {d.conflicts.length} timing
                  decisions need review
                </p>
              )}
              <span className="badge brass-badge">
                Proposed · availability unverified
              </span>
            </>
          )}
          {d.kind === "packet" && (
            <>
              <p>
                Scene assignments, shooting order, costs, requirements, and
                source evidence.
              </p>
              <div className="chip-row">
                <span className="badge moss-badge">Draft prepared</span>
                <span className="badge">Not submitted</span>
              </div>
              {!previewMode && (
                <a
                  className="button primary small-button nodrag"
                  href={`/api/assets/${d.assetId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open packet <ArrowUpRight size={13} />
                </a>
              )}
            </>
          )}
          {d.kind === "note" && <p className="note-text">{d.text}</p>}
        </div>
      )}
      {(entity.stale || run) && (
        <div
          className={`node-status ${run?.status === "failed" ? "status-failed" : ""}`}
        >
          {run ? (
            <RunState run={run} compact />
          ) : (
            <>
              <span className="dot clay" /> Needs refresh
            </>
          )}
          {run?.status === "failed" && editable && (
            <AsyncButton
              pendingLabel="Retrying…"
              className="nodrag"
              onClick={() => act(() => actions.retry(run._id))}
            >
              Retry
            </AsyncButton>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </article>
  );
});
function QuestionBody({
  data,
  onAnswer,
  editable,
}: {
  data: QuestionData;
  onAnswer: () => void;
  editable: boolean;
}) {
  return (
    <>
      <h4>{data.prompt}</h4>
      <p>{data.reason}</p>
      {data.answer && (
        <div className="saved-answer">
          <span className="small muted">Saved answer</span>
          <strong>{data.answer}</strong>
        </div>
      )}
      <div className="chip-row">
        {data.suggestions.slice(0, 3).map((s) => (
          <span className="chip" key={s}>
            {s}
          </span>
        ))}
      </div>
      <button
        className="button small-button nodrag"
        disabled={!editable}
        onClick={onAnswer}
      >
        {data.answer ? "Review answer" : "Answer this question"}
        <ChevronRight size={13} />
      </button>
    </>
  );
}
export function PlanTotals({ planId }: { planId: string }) {
  const { snapshot } = useBoard();
  const p = snapshot.entities.find((e) => e._id === planId);
  if (p?.data.kind !== "plan") return null;
  const selected = scopedPlan(p, snapshot.entities, snapshot.choices);
  const ids = new Set(selected.locations.map((e) => e._id));
  const costs = planCostItems(selected.locations, p.data.currency);
  const s = summarizeCosts(
    costs,
    p.data.currency,
    p.data.budgetMode === "fixed" ? p.data.budgetMinor : null,
  );
  return (
    <>
      <p className="small muted">Location costs for {selected.sceneIds.length} included scenes. Cast, crew, equipment and post-production are separate.</p>
      <div className="node-row">
        <span>Known location costs</span>
        <strong>{formatMoney(s.known, p.data.currency)}</strong>
      </div>
      <div className="node-row">
        <span>Estimated additions</span>
        <strong>{formatMoney(s.estimated, p.data.currency)}</strong>
      </div>
      <div className="node-row">
        <span>Still unquoted</span>
        <strong className={s.unknown.length ? "clay" : ""}>
          {s.unknown.length} items
        </strong>
      </div>
      <p className="small muted">
        {!ids.size
          ? "Choose locations to compare costs."
          : p.data.budgetMode === "fixed" && p.data.budgetMinor === null
            ? "Set the location cap for these scenes before checking costs."
            : s.budgetStatus === "over"
              ? "Partial location total exceeds this cap."
              : s.budgetStatus === "unconfirmed"
                ? "Location budget unconfirmed. Missing quotes are not zero-cost items."
                : s.budgetStatus === "estimated_within"
                  ? "Estimated total is within cap; verification remains."
                  : "Costs reflect selected locations and available evidence."}
      </p>
    </>
  );
}
