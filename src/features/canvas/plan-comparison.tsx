"use client";
import { useState } from "react";
import { planReadiness } from "../../domain/plan-readiness";
import { formatMoney, formatTime } from "../../domain/planning";
import { useBoard } from "./board-context";
import { PlanTotals } from "./cards";
import { AsyncButton } from "../../components/async-button";
import { isPending, latestRun, RunState, TaskButton } from "./workflow-state";

export function PlanComparison() {
  const {
    snapshot,
    actions,
    edit,
    act,
    previewMode,
    activePlanId,
    selectPlan,
  } = useBoard();
  const plans = snapshot.entities.filter((e) => e.data.kind === "plan");
  const ready = plans.map((plan) => ({
    plan,
    ready: planReadiness(plan, snapshot.entities, snapshot.choices),
    run: latestRun(snapshot.runs, "schedule", plan._id),
  }));
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selected = ready.filter((item) => selectedIds.includes(item.plan._id));
  const editable = snapshot.role !== "viewer" && !previewMode;
  const sameScenes =
    ready.length > 1 &&
    ready.every(
      (item) =>
        JSON.stringify([...item.ready.sceneIds].sort()) ===
        JSON.stringify([...ready[0].ready.sceneIds].sort()),
    );
  const current = plans.find((e) => e._id === activePlanId);
  const comparable = sameScenes && ready.every((r) => r.ready.currentSchedule);
  const signature = (item: (typeof ready)[number]) =>
    JSON.stringify([
      item.ready.costs.partial,
      item.ready.proposed.entries.map((e) => [
        e.sceneId,
        e.locationId,
        e.start,
        e.end,
        e.date,
      ]),
    ]);
  const equivalent =
    comparable &&
    ready.every((item) => signature(item) === signature(ready[0]));
  return (
    <section className="planning-view">
      <div className="planning-heading">
        <span className="eyebrow">COMPARE CONFIRMED LOCATION CHOICES</span>
        <h1>
          {current?.data.kind === "plan"
            ? `${current.data.name} shooting schedule`
            : "Shooting schedules"}
        </h1>
        <p>
          Generate an order for each plan’s confirmed choices, then choose the
          plan to revise and export.
        </p>
        <AsyncButton
          className="button primary"
          pendingLabel="Queuing selected plans…"
          disabled={
            !editable ||
            !actions.startPlans ||
            !selected.length ||
            selected.length > 8 ||
            selected.some((r) => r.ready.blockers.length || isPending(r.run))
          }
          onClick={() =>
            act(
              () => actions.startPlans!(selected.map((p) => p.plan._id)),
              "Selected plan jobs queued independently",
            )
          }
        >
          Generate selected schedules ({selected.length})
        </AsyncButton>
        <p className="small muted">
          {ready.length < 2
            ? "Add another plan on the canvas to compare alternatives."
            : sameScenes
              ? "These alternatives include the same scenes."
              : "These alternatives have different scene sets; their totals are not directly comparable."}{" "}
          Shared retrieved evidence is reused; location choices stay
          independent.
        </p>
        {equivalent && (
          <p className="notice">
            These current results have equivalent selected locations, timing and
            totals. Different caps or priorities do not guarantee different
            outcomes.
          </p>
        )}
        {comparable && !equivalent && (
          <p className="notice">
            Compare{" "}
            {ready
              .map(
                (r) =>
                  `${r.plan.data.kind === "plan" ? r.plan.data.name : "Plan"}: ${formatMoney(r.ready.costs.partial, r.plan.data.kind === "plan" ? r.plan.data.currency : "USD")} in known and estimated location costs, ${r.ready.proposed.moves} moves`,
              )
              .join("; ")}
            . Unquoted fees remain outside these totals.
          </p>
        )}
      </div>
      <div className="plan-comparison">
        {ready.map(({ plan: p, ready: r, run }) => {
          if (p.data.kind !== "plan") return null;
          const schedule =
            r.schedule?.data.kind === "schedule" ? r.schedule.data : null;
          return (
            <article
              className={`comparison-card glass ${activePlanId === p._id ? "chosen-plan" : ""}`}
              key={p._id}
            >
              <div className="comparison-title">
                <span className="badge">
                  {p.data.budgetMode === "fixed"
                    ? p.data.budgetMinor === null
                      ? "Location cap needed"
                      : `Location cap ${formatMoney(p.data.budgetMinor, p.data.currency)}`
                    : "No fixed location cap"}
                </span>
                <button
                  className="button tiny quiet"
                  disabled={!editable}
                  onClick={() => edit(p)}
                >
                  Settings & scenes
                </button>
              </div>
              <label className="schedule-selection">
                <input
                  type="checkbox"
                  aria-label={`Generate ${p.data.name}`}
                  checked={selectedIds.includes(p._id)}
                  disabled={!editable}
                  onChange={(event) =>
                    setSelectedIds((previous) =>
                      event.target.checked
                        ? [...previous, p._id]
                        : previous.filter((id) => id !== p._id),
                    )
                  }
                />
                Include in generation
              </label>
              <h2>{p.data.name}</h2>
              <button
                className={`button small-button ${activePlanId === p._id ? "primary" : ""}`}
                onClick={() => selectPlan?.(p._id)}
                aria-pressed={activePlanId === p._id}
              >
                {activePlanId === p._id
                  ? "Chosen plan · revise & export"
                  : "Choose this plan"}
              </button>
              <p>
                {r.sceneIds.length} of{" "}
                {
                  snapshot.entities.filter((e) => e.data.kind === "scene")
                    .length
                }{" "}
                scenes ·{" "}
                {p.data.priority === "cost"
                  ? "Cost and fewer location moves"
                  : p.data.priority === "creative"
                    ? "Creative fit"
                    : p.data.priority}{" "}
                priority
              </p>
              <p>
                {p.data.idealShoot ||
                  "Add your creative and production priorities in settings."}
              </p>
              <p className="small muted">
                {r.scenes
                  .map((s) =>
                    s.data.kind === "scene" ? `Scene ${s.data.number}` : "",
                  )
                  .join(", ") || "No scenes selected"}{" "}
                · {p.data.dates.join(", ") || "Dates needed"}
              </p>
              <PlanTotals planId={p._id} />
              <details>
                <summary>Chosen locations ({r.locations.length})</summary>
                {r.choices.map((c) => (
                  <p key={c.sceneId}>
                    {r.scenes.find((s) => s._id === c.sceneId)?.data.kind ===
                    "scene"
                      ? `Scene ${(r.scenes.find((s) => s._id === c.sceneId)!.data as { number: number }).number}`
                      : "Scene"}
                    :{" "}
                    {r.locations
                      .map((l) =>
                        l._id === c.locationId && l.data.kind === "location"
                          ? l.data.name
                          : "",
                      )
                      .join("")}
                    {c.locked ? " · Locked" : ""}
                  </p>
                ))}
              </details>
              {run && <RunState run={run} />}
              {r.schedule?.stale && (
                <p className="notice clay-notice">
                  Historical schedule · needs refresh
                </p>
              )}
              <div className="comparison-metrics">
                <div>
                  <strong>{schedule?.days ?? "—"}</strong>
                  <span>shooting days</span>
                </div>
                <div>
                  <strong>{schedule?.moves ?? "—"}</strong>
                  <span>moves</span>
                </div>
                <div>
                  <strong>{r.blockers.length}</strong>
                  <span>input blockers</span>
                </div>
              </div>
              {!!r.blockers.length && (
                <details open>
                  <summary>Resolve before generation</summary>
                  <ul>
                    {r.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </details>
              )}
              {schedule?.entries.map((e) => (
                <div className="schedule-row" key={e.sceneId}>
                  <span>
                    {e.date} · {formatTime(e.start)}–{formatTime(e.end)}
                  </span>
                  <h3>
                    Scene {e.sceneNumber} · {e.locationName}
                  </h3>
                  <p>{e.reason}</p>
                  <small>Duration: {e.durationBasis}</small>
                </div>
              ))}
              {schedule?.conflicts.map((c) => (
                <p key={c} className="notice clay-notice">
                  {c}
                </p>
              ))}
              <TaskButton
                kind="schedule"
                targetId={p._id}
                className="button primary"
                disabled={!editable || !!r.blockers.length}
                onClick={() =>
                  act(() => actions.start("schedule", p._id, p.scope))
                }
              >
                {schedule ? "Replan schedule" : "Generate proposed schedule"}
              </TaskButton>
              {run &&
                ["failed", "cancelled", "superseded", "waiting"].includes(
                  run.status,
                ) && (
                  <AsyncButton
                    className="button"
                    disabled={!editable}
                    onClick={() => act(() => actions.retry(run._id))}
                  >
                    Retry {p.data.name}
                  </AsyncButton>
                )}
              <p className="small muted">
                Availability and permissions remain unverified. Timing is based
                on confirmed choices; budget compliance depends on complete fee
                evidence.
              </p>
            </article>
          );
        })}
      </div>
      {!plans.length && (
        <p>
          Upload a screenplay, then choose the plan branches you want on the
          canvas.
        </p>
      )}
    </section>
  );
}
