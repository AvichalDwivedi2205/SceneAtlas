"use client";
import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  LockKeyhole,
  MapPin,
  Settings2,
} from "lucide-react";
import { useBoard } from "./board-context";
import { planReadiness } from "../../domain/plan-readiness";
import { candidateLocations } from "../../domain/research-evidence";
import { formatMoney } from "../../domain/planning";
import { AsyncButton } from "../../components/async-button";
import { CandidateComparison, ResearchDetails } from "./research-details";
import { currentRuns, isPending, latestRun, RunState } from "./workflow-state";
import "./plan-journey.css";

export function PlanJourney({
  onBack,
  onCompare,
  onPacket,
  onSetup,
}: {
  onBack: () => void;
  onCompare: () => void;
  onPacket: () => void;
  onSetup: () => void;
}) {
  const {
    snapshot,
    activePlanId,
    actions,
    previewMode,
    inspect,
    edit,
    selectPlan,
  } = useBoard();
  const plan = snapshot.entities.find(
    (e) => e._id === activePlanId && e.data.kind === "plan",
  );
  const [sceneId, setSceneId] = useState<string>();
  if (!plan || plan.data.kind !== "plan") return null;
  const ready = planReadiness(plan, snapshot.entities, snapshot.choices);
  const scene = ready.scenes.find((e) => e._id === sceneId) ?? ready.scenes[0];
  const choice = snapshot.choices.find(
    (c) => c.planId === plan._id && c.sceneId === scene?._id,
  );
  const candidates = scene
    ? candidateLocations(snapshot.entities, scene._id, plan._id)
    : [];
  const editable = snapshot.role !== "viewer" && !previewMode;
  const questions = ready.entities.filter(
    (e) => e.data.kind === "question" && e.data.resolution !== "answered",
  );
  const research = scene
    ? latestRun(
        snapshot.runs.filter(
          (r) => !r.scope.planId || r.scope.planId === plan._id,
        ),
        "research",
        scene._id,
      )
    : undefined;
  const requirementTargets = ready.locations.filter(
    (e) =>
      e.data.kind === "location" &&
      (e.stale ||
        !e.data.requirements.length ||
        latestRun(snapshot.runs, "requirements", e._id)?.status !== "complete"),
  );
  const relevant = currentRuns(snapshot.runs).filter(
    (r) =>
      (!r.scope.planId || r.scope.planId === plan._id) &&
      ((!r.scope.sceneId && !r.targetId) ||
        r.scope.planId === plan._id ||
        ready.sceneIds.includes(r.scope.sceneId ?? "") ||
        ready.locations.some((l) => l._id === r.targetId)),
  );
  const requirementWorking = relevant.some(
    (r) => r.kind === "requirements" && isPending(r),
  );
  return (
    <section className="plan-journey" aria-label={`${plan.data.name} workflow`}>
      <header className="journey-heading">
        <button className="button tiny quiet" onClick={onBack}>
          <ArrowLeft size={14} /> Back to plan tree
        </button>
        <div className="journey-title">
          <div>
            <span className="eyebrow">FROM YOUR SCREENPLAY</span>
            <h1>{plan.data.name}</h1>
            <p>
              {ready.sceneIds.length} selected scenes ·{" "}
              {plan.data.budgetMode === "fixed"
                ? plan.data.budgetMinor === null
                  ? "Set a budget cap"
                  : `${formatMoney(plan.data.budgetMinor, plan.data.currency)} budget cap`
                : "No fixed budget cap"}
            </p>
          </div>
          <button
            className="button small-button"
            disabled={!editable}
            onClick={() => edit(plan)}
          >
            <Settings2 size={14} /> Plan settings
          </button>
        </div>
        <div className="journey-variants" aria-label="Switch plan branch">
          {snapshot.entities
            .filter((e) => e.data.kind === "plan")
            .map(
              (p) =>
                p.data.kind === "plan" && (
                  <button
                    className={`button small-button ${p._id === plan._id ? "primary" : "quiet"}`}
                    key={p._id}
                    aria-pressed={p._id === plan._id}
                    onClick={() => selectPlan?.(p._id)}
                  >
                    {p.data.name}
                  </button>
                ),
            )}
        </div>
      </header>
      <div className="journey-next">
        <div>
          <span className="eyebrow">NEXT STEP</span>
          <h2>
            {!ready.scenes.length
              ? "Choose shared scenes"
              : ready.choices.length < ready.scenes.length
                ? "Review your filming locations"
                : requirementTargets.length
                  ? "Check the selected locations’ requirements"
                  : ready.currentSchedule
                    ? "Compare your plans or prepare the handoff"
                    : ready.blockers.length
                      ? "Resolve the remaining production inputs"
                      : "Choose schedules to generate"}
          </h2>
          <p>
            {ready.choices.length} of {ready.scenes.length} scenes have a
            location selected. Shared evidence stays available across your
            plans.
          </p>
        </div>
        {!ready.scenes.length ? (
          <button
            className="button primary"
            onClick={onSetup}
            disabled={!editable}
          >
            Choose scenes
            <ArrowRight size={15} />
          </button>
        ) : ready.choices.length === ready.scenes.length &&
          requirementTargets.length > 0 ? (
          <AsyncButton
            className="button primary"
            pendingLabel="Queuing requirement checks…"
            disabled={!editable || requirementWorking}
            onClick={async () => {
              const outcomes = await Promise.allSettled(
                requirementTargets.map((location) =>
                  actions.start("requirements", location._id, location.scope),
                ),
              );
              const failed = outcomes.filter((o) => o.status === "rejected");
              if (failed.length)
                throw new Error(
                  `${outcomes.length - failed.length} checks queued; ${failed.length} could not start. ${failed.map((o) => String(o.reason)).join(" ")}`,
                );
            }}
          >
            Check location requirements
          </AsyncButton>
        ) : ready.choices.length === ready.scenes.length ? (
          <div className="actions">
            <button className="button primary" onClick={onCompare}>
              Compare shooting plans
              <ArrowRight size={15} />
            </button>
            {ready.currentSchedule && (
              <button className="button" onClick={onPacket}>
                Prepare packet
              </button>
            )}
          </div>
        ) : null}
      </div>
      {questions.length > 0 && (
        <section className="journey-questions">
          <h3>Production questions</h3>
          {questions.map(
            (q) =>
              q.data.kind === "question" && (
                <div key={q._id}>
                  <p>{q.data.prompt}</p>
                  <button
                    className="button tiny"
                    disabled={!editable}
                    onClick={() => edit(q)}
                  >
                    Answer question
                  </button>
                </div>
              ),
          )}
        </section>
      )}
      {relevant
        .filter(
          (r) =>
            ["waiting", "failed"].includes(r.status) ||
            (r.kind !== "research" && isPending(r)),
        )
        .map((run) => (
          <div className="journey-run" key={run._id}>
            <RunState run={run} />
            {["waiting", "failed"].includes(run.status) && (
              <AsyncButton
                className="button tiny"
                pendingLabel="Retrying…"
                disabled={!editable}
                onClick={() => actions.retry(run._id)}
              >
                Retry task
              </AsyncButton>
            )}
          </div>
        ))}
      {ready.scenes.length > 0 && (
        <div className="journey-workspace">
          <nav className="journey-scenes" aria-label="Selected scenes in plan">
            {ready.scenes.map(
              (s) =>
                s.data.kind === "scene" && (
                  <button
                    key={s._id}
                    aria-current={s._id === scene?._id ? "step" : undefined}
                    onClick={() => setSceneId(s._id)}
                  >
                    <span className="journey-scene-number">
                      {String(s.data.number).padStart(2, "0")}
                    </span>
                    <span>
                      <strong>{s.data.heading}</strong>
                      <small>
                        {ready.choices.some((c) => c.sceneId === s._id)
                          ? "Location selected"
                          : "Review locations"}
                      </small>
                    </span>
                    {ready.choices.some((c) => c.sceneId === s._id) && (
                      <Check size={15} />
                    )}
                  </button>
                ),
            )}
          </nav>
          {scene?.data.kind === "scene" && (
            <div className="journey-detail" key={`${plan._id}:${scene._id}`}>
              <div className="journey-scene-title">
                <div>
                  <span className="eyebrow">
                    SCENE {scene.data.number} · PAGES {scene.data.pageStart}–
                    {scene.data.pageEnd}
                  </span>
                  <h2>{scene.data.heading}</h2>
                </div>
                <button
                  className="button tiny quiet"
                  onClick={() => inspect(scene)}
                >
                  Screenplay & scene details
                </button>
              </div>
              <p className="journey-needs">{scene.data.needs.join(" · ")}</p>
              {research && <RunState run={research} compact />}
              {!candidates.length && (
                <div className="journey-no-results">
                  <MapPin size={28} />
                  <h3>
                    {isPending(research)
                      ? "Finding source-backed locations"
                      : "No usable locations saved yet"}
                  </h3>
                  <p>
                    {isPending(research)
                      ? "Research continues while you explore either plan."
                      : "Find locations from your saved scene needs and production brief."}
                  </p>
                </div>
              )}
              <div className="journey-candidates">
                {candidates.map((candidate) => (
                  <article
                    key={candidate._id}
                    className={
                      choice?.locationId === candidate._id
                        ? "location-chosen"
                        : ""
                    }
                  >
                    <span className="eyebrow">
                      {candidate.stale ? "NEEDS REFRESH" : "LOCATION CANDIDATE"}
                    </span>
                    <h3>{candidate.data.name}</h3>
                    <p>{candidate.data.creativeFit}</p>
                    <small>
                      Availability unverified ·{" "}
                      {candidate.data.costs.some(
                        (c) => c.amountMinor === null,
                      ) || !candidate.data.costs.length
                        ? "Fees need a quote"
                        : "See sourced fees"}
                    </small>
                    <div className="actions">
                      <button
                        className="button small-button"
                        onClick={() => inspect(candidate)}
                      >
                        Review evidence
                      </button>
                      <AsyncButton
                        className={`button small-button ${choice?.locationId === candidate._id ? "quiet" : "primary"}`}
                        pendingLabel="Saving choice…"
                        disabled={
                          !editable ||
                          candidate.stale ||
                          (!!choice?.locked &&
                            choice.locationId !== candidate._id)
                        }
                        onClick={() =>
                          actions.choose(
                            plan._id,
                            scene._id,
                            candidate._id,
                            choice?.locationId === candidate._id
                              ? !choice.locked
                              : true,
                            choice?.revision ?? 0,
                          )
                        }
                      >
                        {choice?.locationId === candidate._id ? (
                          choice.locked ? (
                            <>
                              <LockKeyhole size={13} /> Locked · unlock
                            </>
                          ) : (
                            "Lock this choice"
                          )
                        ) : (
                          "Select & lock"
                        )}
                      </AsyncButton>
                    </div>
                  </article>
                ))}
              </div>
              <div className="actions">
                <AsyncButton
                  className="button tiny quiet"
                  pendingLabel="Starting research…"
                  disabled={!editable || isPending(research)}
                  onClick={() =>
                    actions.start("research", scene._id, {
                      kind: "scene",
                      sceneId: scene._id,
                    })
                  }
                >
                  {candidates.length
                    ? "Find more locations"
                    : "Find filming locations"}
                </AsyncButton>
                <button
                  className="button tiny quiet"
                  disabled={!editable}
                  onClick={() => edit(scene)}
                >
                  Edit scene timing or needs
                </button>
              </div>
              {candidates.length > 0 && (
                <details className="journey-comparison">
                  <summary>Compare creative fit, fees and requirements</summary>
                  <CandidateComparison sceneId={scene._id} />
                </details>
              )}
              <ResearchDetails entity={scene} />
            </div>
          )}
        </div>
      )}
      {ready.blockers.length > 0 && (
        <details className="journey-blockers">
          <summary>
            {ready.blockers.length} inputs needed before this shooting schedule
            can run
          </summary>
          <ul>
            {ready.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
