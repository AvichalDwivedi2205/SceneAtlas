"use client";
import { useState } from "react";
import { GitBranch, ArrowRight } from "lucide-react";
import { useBoard } from "./board-context";
import { AsyncButton } from "../../components/async-button";
import { PlanScenePicker } from "./scene-scope";
import { isPending } from "./workflow-state";
import type { PlanData } from "../../domain/model";
import { formatTime } from "../../domain/planning";
import "./variant-setup.css";

/** Initial shared inputs only. Existing work continues through reviewed revisions. */
export function VariantSetup({ onDone }: { onDone: () => void }) {
  const { snapshot, actions, previewMode } = useBoard();
  const plans = snapshot.entities.filter((e) => e.data.kind === "plan");
  const fixed = plans.find(
    (e) => e.data.kind === "plan" && e.data.budgetMode === "fixed",
  );
  const initial = fixed?.data.kind === "plan" ? fixed.data : undefined;
  const scenes = snapshot.entities.filter((e) => e.data.kind === "scene");
  const script = snapshot.entities.find((e) => e.data.kind === "script");
  const [budget, setBudget] = useState(
    initial?.budgetMinor ? String(initial.budgetMinor / 100) : "",
  );
  const [ideal, setIdeal] = useState(initial?.idealShoot ?? "");
  const [date, setDate] = useState(initial?.dates[0] ?? "");
  const [timezone, setTimezone] = useState(
    initial?.timezone ?? "America/Los_Angeles",
  );
  const [start, setStart] = useState(formatTime(initial?.dayStart ?? 480));
  const [end, setEnd] = useState(formatTime(initial?.dayEnd ?? 1080));
  const [move, setMove] = useState(
    initial?.moveMinutes === null || initial?.moveMinutes === undefined
      ? ""
      : String(initial.moveMinutes),
  );
  const [setup, setSetup] = useState(
    initial?.setupMinutes === null || initial?.setupMinutes === undefined
      ? ""
      : String(initial.setupMinutes),
  );
  const [basis, setBasis] = useState<PlanData["timingBasis"]>(
    initial?.timingBasis ?? "unknown",
  );
  const [duration, setDuration] = useState("");
  const [windows, setWindows] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sceneScope, setSceneScope] = useState<
    NonNullable<PlanData["sceneScope"]>
  >(
    initial?.sceneScope?.mode === "selected"
      ? initial.sceneScope
      : { mode: "selected", sceneIds: [] },
  );
  const working = snapshot.runs.some(
    (r) => ["ingest", "scenes"].includes(r.kind) && isPending(r),
  );
  const existingWork =
    snapshot.choices.length > 0 ||
    snapshot.runs.some((r) =>
      ["research", "requirements", "schedule", "packet"].includes(r.kind),
    );
  const editable = snapshot.role !== "viewer" && !previewMode && !existingWork;
  const scopeIds =
    sceneScope.mode === "all" ? scenes.map((e) => e._id) : sceneScope.sceneIds;
  const questions = snapshot.entities.filter(
    (entity) =>
      entity.data.kind === "question" &&
      entity.data.resolution !== "answered" &&
      (!entity.scope.planId ||
        plans.some((plan) => plan._id === entity.scope.planId)) &&
      (entity.scope.kind === "workspace" ||
        scopeIds.includes(entity.scope.sceneId ?? "")),
  );
  const minutes = (value: string) => {
    const [h, m] = value.split(":").map(Number);
    return h * 60 + m;
  };
  const valid =
    !!initial &&
    plans.length === 2 &&
    Number(budget) > 0 &&
    !!ideal.trim() &&
    !!date &&
    Number.isFinite(minutes(start)) &&
    minutes(end) > minutes(start) &&
    move !== "" &&
    setup !== "" &&
    basis !== "unknown" &&
    questions.every((q) => !!answers[q._id]?.trim()) &&
    (!scenes.length ||
      (scopeIds.length > 0 && Number(duration) > 0 && windows));
  return (
    <div className="variant-setup">
      <div className="variant-intro">
        <span className="eyebrow">ONE SCREENPLAY · TWO POSSIBILITIES</span>
        <h2>
          {scenes.length
            ? "Choose scenes. Start both plans."
            : "Set up your two plans"}
        </h2>
        <p>
          One production brief, two budget approaches. Compare locations,
          shooting schedules and preparation packets as each plan takes shape.
        </p>
      </div>
      {existingWork && (
        <p className="notice">
          Planning has started. Open each plan’s settings to review changes to
          saved decisions.
        </p>
      )}
      <fieldset disabled={!editable || working} className="variant-fields">
        <div className="variant-options">
          <section>
            <GitBranch size={18} />
            <h3>Budget plan</h3>
            <p>Prioritize cost within your fixed cap.</p>
            <label>
              Budget cap (USD)
              <input
                aria-label="Budget cap (USD)"
                type="number"
                min="0.01"
                step="0.01"
                placeholder="Enter your budget"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </label>
          </section>
          <section>
            <GitBranch size={18} />
            <h3>No fixed budget</h3>
            <p>Prioritize creative fit. Costs still tracked.</p>
            <strong className="variant-uncapped">No fixed cap</strong>
            <span className="small muted">
              Unquoted costs remain visible in both plans.
            </span>
          </section>
        </div>
        <label>
          Creative priorities
          <textarea
            aria-label="Creative priorities"
            rows={2}
            value={ideal}
            onChange={(e) => setIdeal(e.target.value)}
            placeholder="What matters most in your locations and shoot?"
          />
        </label>
        {questions.length > 0 && (
          <section className="variant-brief">
            <h3>Shared production brief</h3>
            <p>These answers apply to both variants.</p>
            {questions.map(
              (q) =>
                q.data.kind === "question" && (
                  <label key={q._id}>
                    {q.data.prompt}
                    <small>{q.data.reason}</small>
                    <textarea
                      aria-label={q.data.prompt}
                      rows={2}
                      value={answers[q._id] ?? ""}
                      onChange={(e) =>
                        setAnswers({ ...answers, [q._id]: e.target.value })
                      }
                    />
                    {!!q.data.suggestions.length && (
                      <span className="variant-suggestions">
                        {q.data.suggestions.map((suggestion) => (
                          <button
                            type="button"
                            className="button tiny quiet"
                            key={suggestion}
                            onClick={() =>
                              setAnswers({ ...answers, [q._id]: suggestion })
                            }
                          >
                            {suggestion}
                          </button>
                        ))}
                      </span>
                    )}
                  </label>
                ),
            )}
          </section>
        )}
        <section>
          <h3>Shared shooting day</h3>
          <div className="variant-grid">
            <label>
              Shooting date
              <input
                aria-label="Shared shooting date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            <label>
              Timezone
              <input
                aria-label="Shared timezone"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
            </label>
            <label>
              Day starts
              <input
                aria-label="Shared day start"
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label>
              Day ends
              <input
                aria-label="Shared day end"
                type="time"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
            <label>
              Move time (minutes)
              <input
                aria-label="Shared move minutes"
                type="number"
                min="0"
                value={move}
                onChange={(e) => setMove(e.target.value)}
              />
            </label>
            <label>
              Setup time (minutes)
              <input
                aria-label="Shared setup minutes"
                type="number"
                min="0"
                value={setup}
                onChange={(e) => setSetup(e.target.value)}
              />
            </label>
          </div>
          <label>
            Timing basis
            <select
              aria-label="Shared timing basis"
              value={basis}
              onChange={(e) =>
                setBasis(e.target.value as PlanData["timingBasis"])
              }
            >
              <option value="unknown">Choose a basis</option>
              <option value="estimate">Producer estimate</option>
              <option value="confirmed">Producer confirmed</option>
            </select>
          </label>
        </section>
        {scenes.length > 0 && initial && (
          <section>
            <PlanScenePicker
              plan={{ ...initial, sceneScope }}
              onChange={setSceneScope}
            />
            <p>
              Same selected scenes in both variants. All {scenes.length}{" "}
              screenplay scenes remain available.
            </p>
            <label>
              Shooting time per selected scene (minutes)
              <input
                aria-label="Shared scene duration"
                type="number"
                min="1"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
            </label>
            <label className="variant-window">
              <input
                type="checkbox"
                aria-label="Confirm shared scene windows"
                checked={windows}
                onChange={(e) => setWindows(e.target.checked)}
              />
              <span>
                I allow these selected scenes within {start}–{end} on{" "}
                {date || "the selected date"}. Timing basis: {basis}.
              </span>
            </label>
          </section>
        )}
      </fieldset>
      <footer className="variant-footer">
        <p>
          {scenes.length
            ? "Start shared location research for both plans. Review location choices before generating each shooting schedule."
            : "Save both variants, then break down the complete screenplay. You’ll choose the shoot-day scenes next."}
        </p>
        <AsyncButton
          className="button primary"
          pendingLabel={
            scenes.length ? "Starting research…" : "Creating scene breakdown…"
          }
          disabled={
            !editable ||
            !valid ||
            working ||
            !actions.configureVariants ||
            (scenes.length > 0 && !actions.startVariantResearch)
          }
          onClick={async () => {
            if (!script || !actions.configureVariants) return;
            await actions.configureVariants({
              plans: plans.map((p) => ({
                planId: p._id,
                expectedRevision: p.revision,
              })),
              budgetMinor: Math.round(Number(budget) * 100),
              idealShoot: ideal,
              dates: [date],
              timezone,
              dayStart: minutes(start),
              dayEnd: minutes(end),
              moveMinutes: Number(move),
              setupMinutes: Number(setup),
              timingBasis: basis,
              ...(scenes.length
                ? {
                    sceneIds: scopeIds,
                    durationMinutes: Number(duration),
                    applyTimeWindows: windows,
                  }
                : {}),
              answers: questions.map((q) => ({
                entityId: q._id,
                expectedRevision: q.revision,
                answer: answers[q._id].trim(),
              })),
            });
            if (scenes.length)
              await actions.startVariantResearch!(plans.map((p) => p._id));
            else
              await actions.start("scenes", script._id, { kind: "workspace" });
            onDone();
          }}
        >
          {scenes.length
            ? "Start both plans"
            : "Save variants & break down screenplay"}
          <ArrowRight size={16} />
        </AsyncButton>
      </footer>
    </div>
  );
}
