"use client";
import { PlanComparison } from "./plan-comparison";
import { PacketReadiness } from "./packet-readiness";
import { PlanScenePicker } from "./scene-scope";
import { useState } from "react";
import {
  ArrowUpRight,
  Download,
  ExternalLink,
  MapPin,
  LoaderCircle,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useBoard, type ChangeView } from "./board-context";
import { titleFor, PlanTotals } from "./cards";
import {
  entitySchema,
  type Entity,
  type EntityData,
  type Source,
} from "../../domain/model";
import { formatMoney, formatTime } from "../../domain/planning";
import { AsyncButton } from "../../components/async-button";
import { AssetButton } from "../../components/asset-button";
import { latestRun, RunState, TaskButton } from "./workflow-state";
import {
  CandidateComparison,
  ResearchDetails,
  SourceEvidence,
} from "./research-details";
import { RevisionReview } from "./revision-review";
import {
  isStartTimeChange,
  revisionInputChanges,
} from "../../domain/revision-review";
export function SourceList({ sources }: { sources: Source[] }) {
  return <SourceEvidence sources={sources} />;
}
export function Inspector({ entity }: { entity: Entity }) {
  const { snapshot, previewMode, edit, actions, act } = useBoard();
  const d = entity.data;
  const script = snapshot.entities.find((e) => e.data.kind === "script");
  const run = latestRun(snapshot.runs, undefined, entity._id);
  return (
    <div className="inspector-content">
      <span className="eyebrow">
        {d.kind.toUpperCase()} · {entity.scope.kind.replace("_", " + ")}
      </span>
      <h2>{titleFor(entity)}</h2>
      {run &&
        ["queued", "running", "waiting", "failed"].includes(run.status) && (
          <RunState run={run} />
        )}
      {entity.stale && (
        <div className="notice clay-notice">
          An upstream decision changed. This result needs refresh.
        </div>
      )}
      {d.kind === "location" && (
        <>
          <div className="inspector-location-art">
            <MapPin size={48} />
            <span>{d.address}</span>
          </div>
          <h3>Why it matches</h3>
          <p>{d.creativeFit}</p>
          <p>{d.description}</p>
          <h3>What it costs</h3>
          {!d.costs.length && (
            <p>Price evidence is missing. Cost is unknown.</p>
          )}
          {d.costs.map((c) => (
            <div key={c.id}>
              <div className="detail-row">
                <div>
                  <strong>{c.label}</strong>
                  <p>{c.coverageReason}</p>
                </div>
                <div>
                  <strong>
                    {c.amountMinor === null
                      ? "Not quoted"
                      : formatMoney(c.amountMinor, c.currency)}
                  </strong>
                  <small>
                    {c.basis} · per {c.unit} × {c.quantity}
                  </small>
                </div>
              </div>
              {c.assumptions && <p className="small muted">{c.assumptions}</p>}
              {c.source && <SourceList sources={[c.source]} />}
            </div>
          ))}
          <p className="small muted">
            Unknown costs remain separate from totals.
          </p>
          <h3>Access and availability</h3>
          <div className="detail-row">
            <span>Authority</span>
            <strong>{d.authority || "Unresolved"}</strong>
          </div>
          <div className="detail-row">
            <span>Availability</span>
            <span className="badge brass-badge">Unverified</span>
          </div>
          {d.restrictions.map((r) => (
            <p key={r} className="restriction">
              {r}
            </p>
          ))}
          <h3>Permit readiness</h3>
          {d.requirements.map((r, i) => (
            <div className="requirement-detail" key={i}>
              <span
                className={`badge ${r.status === "sourced" ? "moss-badge" : "clay-badge"}`}
              >
                {r.status}
              </span>
              <h4>{r.title}</h4>
              <p>{r.detail}</p>
              {r.applicableFacts.length > 0 && (
                <p>Applies to: {r.applicableFacts.join("; ")}</p>
              )}
              {r.leadTime && <p>Published lead time: {r.leadTime}</p>}
              <SourceList sources={r.sources} />
            </div>
          ))}
          <h3>Where this came from</h3>
          <SourceList sources={d.sources} />
          <ResearchDetails entity={entity} />
          <div className="notice">
            Finding a location is not permission to film there.
          </div>
          {!previewMode && snapshot.role !== "viewer" && (
            <TaskButton
              kind={"requirements"}
              targetId={entity._id}
              className="button"
              onClick={() =>
                act(() =>
                  actions.start("requirements", entity._id, entity.scope),
                )
              }
            >
              <ShieldCheck size={15} /> Refresh requirements
            </TaskButton>
          )}
        </>
      )}
      {d.kind === "scene" && (
        <>
          <div className="chip-row">
            <span className="chip">{d.interiorExterior}</span>
            <span className="chip">{d.timeOfDay}</span>
            <span className="chip">
              Pages {d.pageStart}–{d.pageEnd}
            </span>
          </div>
          <h3>Original screenplay excerpt</h3>
          <blockquote className="full-excerpt">{d.excerpt}</blockquote>
          {script?.data.kind === "script" &&
            script.data.assetId &&
            !previewMode && (
              <a
                className="button"
                href={`/api/assets/${script.data.assetId}#page=${d.pageStart}`}
                target="_blank"
                rel="noreferrer"
              >
                Open source page <ArrowUpRight size={14} />
              </a>
            )}
          <h3>Location needs</h3>
          <div className="chip-row">
            {d.needs.map((n) => (
              <span key={n} className="chip">
                {n}
              </span>
            ))}
          </div>
          <h3>Inherited production decisions</h3>
          {snapshot.entities
            .filter(
              (e) =>
                e.data.kind === "question" &&
                e.scope.kind === "workspace" &&
                e.data.answer,
            )
            .map((e) => (
              <div className="detail-row" key={e._id}>
                <span>{e.data.kind === "question" ? e.data.prompt : ""}</span>
                <strong>
                  {e.data.kind === "question" ? e.data.answer : ""}
                </strong>
              </div>
            ))}
          <CandidateComparison sceneId={entity._id} />
          <ResearchDetails entity={entity} />
          {!previewMode && snapshot.role !== "viewer" && (
            <button className="button primary" onClick={() => edit(entity)}>
              Edit scene settings
            </button>
          )}
        </>
      )}
      {d.kind === "script" && (
        <>
          <p>{d.summary}</p>
          <div className="detail-row">
            <span>Source</span>
            <strong>{d.pageCount} pages</strong>
          </div>
          {d.assetId && !previewMode && (
            <a
              className="button"
              href={`/api/assets/${d.assetId}`}
              target="_blank"
              rel="noreferrer"
            >
              Open screenplay <ArrowUpRight size={14} />
            </a>
          )}
          <h3>Saved production decisions</h3>
          {snapshot.entities
            .filter(
              (e) => e.data.kind === "answer" && e.scope.kind === "workspace",
            )
            .map((e) => (
              <div className="detail-row" key={e._id}>
                <span>{e.data.kind === "answer" ? e.data.question : ""}</span>
                <strong>
                  {e.data.kind === "answer" ? e.data.original : ""}
                </strong>
              </div>
            ))}
        </>
      )}
      {(d.kind === "question" || d.kind === "answer") && (
        <>
          <h3>{d.kind === "question" ? d.prompt : d.question}</h3>
          <p>
            {d.kind === "question"
              ? d.reason
              : "Original answer, preserved with its scope."}
          </p>
          <div className="saved-answer">
            <strong>
              {d.kind === "question"
                ? d.answer || "Awaiting your answer"
                : d.original}
            </strong>
          </div>
          {d.rule && (
            <div className="notice">
              <span className="badge">{d.rule.strength}</span>
              <p>{d.rule.explanation}</p>
              <strong>{String(d.rule.value)}</strong>
            </div>
          )}
          {d.kind === "question" &&
            snapshot.role !== "viewer" &&
            !previewMode && (
              <button className="button primary" onClick={() => edit(entity)}>
                Edit answer
              </button>
            )}
        </>
      )}
      {d.kind === "cost" &&
        d.items.map((c) => (
          <div className="requirement-detail" key={c.id}>
            <h3>{c.label}</h3>
            <p>
              {c.amountMinor === null
                ? "Unquoted"
                : formatMoney(c.amountMinor, c.currency)}{" "}
              · {c.basis} · per {c.unit}
            </p>
            <p>{c.coverageReason}</p>
            <p>{c.assumptions}</p>
            {c.source && <SourceList sources={[c.source]} />}
          </div>
        ))}
      {d.kind === "requirement" && (
        <>
          <span className="badge">{d.status}</span>
          <p>{d.detail}</p>
          <h3>Required attachments</h3>
          {d.attachments.map((a) => (
            <p className="checklist-item" key={a}>
              <span className="empty-check" />
              {a}
            </p>
          ))}
          <SourceList sources={d.sources} />
          {d.formUrl && (
            <a
              className="button"
              href={d.formUrl}
              target="_blank"
              rel="noreferrer"
            >
              Official form <ExternalLink size={14} />
            </a>
          )}
        </>
      )}
      {d.kind === "plan" && (
        <>
          <p>
            {d.idealShoot ||
              "Plan preferences are editable. Confirmed hard constraints stay in effect."}
          </p>
          <PlanTotals planId={entity._id} />
          {!previewMode && snapshot.role !== "viewer" && (
            <button className="button primary" onClick={() => edit(entity)}>
              Edit plan settings
            </button>
          )}
        </>
      )}
      {d.kind === "schedule" && (
        <>
          <p>{d.explanation}</p>
          {d.conflicts.map((c) => (
            <div key={c} className="notice clay-notice">
              {c}
            </div>
          ))}
          {d.entries.map((e) => (
            <div className="schedule-row" key={e.sceneId}>
              <span>
                {e.date} · {formatTime(e.start)}–{formatTime(e.end)}
              </span>
              <h3>
                Scene {e.sceneNumber} · {e.locationName}
              </h3>
              <p>{e.reason}</p>
              <small>Duration {e.durationBasis}</small>
            </div>
          ))}
        </>
      )}
      {d.kind === "packet" && (
        <>
          <div className="notice">Draft preparation packet · Not submitted</div>
          {d.unresolved.map((u) => (
            <p className="restriction" key={u}>
              {u}
            </p>
          ))}
          {!previewMode && (
            <AssetButton
              assetId={d.assetId}
              filename={d.filename}
              className="button primary"
            >
              <Download size={15} /> Download preparation packet
            </AssetButton>
          )}
        </>
      )}
      {d.kind === "note" && <p className="full-excerpt">{d.text}</p>}
      <footer className="record-footer">
        Version {entity.revision} ·{" "}
        {new Date(entity.updatedAt).toLocaleString()}
        <br />
        Saved changes retain their original version in history.
      </footer>
    </div>
  );
}
export function EditForm({
  entity,
  onSaved,
}: {
  entity: Entity;
  onSaved: (id: string) => void;
}) {
  const { actions } = useBoard();
  const [draft, setDraft] = useState<EntityData>(entity.data);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const patch = (values: Record<string, unknown>) =>
    setDraft({ ...draft, ...values } as EntityData);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      let data = draft;
      if (data.kind === "question")
        data = {
          ...data,
          resolution: /^(not sure|unknown|i don.t know|not sure yet)$/i.test(
            data.answer?.trim() || "",
          )
            ? "unknown"
            : "answered",
        };
      const parsed = entitySchema.parse(data);
      onSaved(await actions.preview(entity, parsed));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not preview change.");
    } finally {
      setBusy(false);
    }
  }
  const input = (
    label: string,
    value: string | number,
    onChange: (v: string) => void,
    type = "text",
  ) => (
    <label>
      {label}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
  return (
    <form onSubmit={submit} className="edit-form">
      <span className="eyebrow">
        {entity.scope.kind.replace("_", " + ")} · VERSION {entity.revision}
      </span>
      <h2>
        {draft.kind === "question" ? draft.prompt : `Edit ${titleFor(entity)}`}
      </h2>
      {draft.kind === "question" && (
        <>
          <p>{draft.reason}</p>
          <div className="chip-row">
            {[...draft.suggestions, "Not sure"].map((s) => (
              <button
                type="button"
                className={`chip ${draft.answer === s ? "brass-badge" : ""}`}
                key={s}
                onClick={() => patch({ answer: s })}
              >
                {s}
              </button>
            ))}
          </div>
          <label>
            Your answer
            <textarea
              autoFocus
              rows={4}
              value={draft.answer ?? ""}
              onChange={(e) => patch({ answer: e.target.value })}
              placeholder="Use your own words…"
              required
            />
          </label>
          <p className="small muted">
            Your original words stay attached to this question. Unknowns remain
            visible.
          </p>
        </>
      )}
      {draft.kind === "scene" && (
        <>
          {input("Scene heading", draft.heading, (v) => patch({ heading: v }))}
          {input("Fictional setting", draft.setting, (v) =>
            patch({ setting: v }),
          )}
          <div className="form-grid">
            <label>
              Interior / exterior
              <select
                value={draft.interiorExterior}
                onChange={(e) => patch({ interiorExterior: e.target.value })}
              >
                {["INT", "EXT", "INT/EXT", "UNKNOWN"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            {input("Time of day", draft.timeOfDay, (v) =>
              patch({ timeOfDay: v }),
            )}
          </div>
          <label>
            Location needs, one per line
            <textarea
              rows={3}
              value={draft.needs.join("\n")}
              onChange={(e) =>
                patch({ needs: e.target.value.split("\n").filter(Boolean) })
              }
            />
          </label>
          <div className="form-grid">
            {input(
              "Candidate count (1–5)",
              draft.candidateCount,
              (v) => patch({ candidateCount: Number(v) }),
              "number",
            )}
            <label>
              Prioritize
              <select
                value={draft.ranking}
                onChange={(e) => patch({ ranking: e.target.value })}
              >
                <option value="creative">Creative fit</option>
                <option value="cost">Lower cost</option>
                <option value="moves">Fewer moves</option>
              </select>
            </label>
          </div>
          <div className="form-grid">
            {input(
              "Shooting duration, minutes",
              draft.durationMinutes ?? "",
              (v) => patch({ durationMinutes: v ? Number(v) : null }),
              "number",
            )}
            <label>
              Duration basis
              <select
                value={draft.durationBasis}
                onChange={(e) => patch({ durationBasis: e.target.value })}
              >
                <option value="unknown">Unknown</option>
                <option value="confirmed">Confirmed by producer</option>
                <option value="estimate">Producer-approved estimate</option>
              </select>
            </label>
          </div>
          <h3>Allowed shooting windows</h3>
          <p className="small muted">
            Confirm dates and local times that satisfy this scene’s daylight,
            access, and creative needs.
          </p>
          {draft.windows.map((w, i) => (
            <div className="window-row" key={i}>
              <input
                aria-label={`Window ${i + 1} date`}
                type="date"
                value={w.date}
                onChange={(e) =>
                  patch({
                    windows: draft.windows.map((r, j) =>
                      i === j ? { ...r, date: e.target.value } : r,
                    ),
                  })
                }
              />
              {["start", "end"].map((key) => (
                <input
                  key={key}
                  type="time"
                  aria-label={`Window ${i + 1} ${key}`}
                  value={formatTime(w[key as "start" | "end"])}
                  onChange={(e) => {
                    const [h, m] = e.target.value.split(":").map(Number);
                    patch({
                      windows: draft.windows.map((r, j) =>
                        i === j ? { ...r, [key]: h * 60 + m } : r,
                      ),
                    });
                  }}
                />
              ))}
              <button
                type="button"
                className="icon-button"
                aria-label="Remove window"
                onClick={() =>
                  patch({ windows: draft.windows.filter((_, j) => i !== j) })
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button"
            onClick={() =>
              patch({
                windows: [
                  ...draft.windows,
                  { date: "", start: 480, end: 1080 },
                ],
              })
            }
          >
            <Plus size={14} /> Add window
          </button>
        </>
      )}
      {draft.kind === "plan" && (
        <>
          {input("Plan name", draft.name, (v) => patch({ name: v }))}
          <PlanScenePicker
            plan={draft}
            onChange={(sceneScope) => patch({ sceneScope })}
          />
          <label>
            Budget mode
            <select
              value={draft.budgetMode}
              onChange={(e) =>
                patch({
                  budgetMode: e.target.value,
                  budgetMinor:
                    e.target.value === "uncapped" ? null : draft.budgetMinor,
                })
              }
            >
              <option value="fixed">Fixed budget for whole plan</option>
              <option value="uncapped">No fixed cap</option>
            </select>
          </label>
          {draft.budgetMode === "fixed" &&
            input(
              "Whole-plan budget",
              draft.budgetMinor === null ? "" : draft.budgetMinor / 100,
              (v) =>
                patch({ budgetMinor: v ? Math.round(Number(v) * 100) : null }),
              "number",
            )}
          {input("Currency", draft.currency, (v) =>
            patch({ currency: v.toUpperCase() }),
          )}
          <label>
            Planning priority
            <select
              value={draft.priority}
              onChange={(e) => patch({ priority: e.target.value })}
            >
              <option value="cost">Lower cost</option>
              <option value="moves">Fewer location moves</option>
              <option value="days">Fewer shooting days</option>
              <option value="creative">Creative fit</option>
            </select>
          </label>
          <label>
            Describe your ideal shoot
            <textarea
              value={draft.idealShoot}
              onChange={(e) => patch({ idealShoot: e.target.value })}
              rows={3}
            />
          </label>
          {input(
            "Shooting dates, comma-separated",
            draft.dates.join(", "),
            (v) =>
              patch({
                dates: v
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              }),
          )}
          {input("Production timezone", draft.timezone, (v) =>
            patch({ timezone: v }),
          )}
          <div className="form-grid">
            {input(
              "Day starts",
              formatTime(draft.dayStart),
              (v) => {
                const [h, m] = v.split(":").map(Number);
                patch({ dayStart: h * 60 + m });
              },
              "time",
            )}
            {input(
              "Day ends",
              formatTime(draft.dayEnd),
              (v) => {
                const [h, m] = v.split(":").map(Number);
                patch({ dayEnd: h * 60 + m });
              },
              "time",
            )}
            {input(
              "Move time, minutes",
              draft.moveMinutes ?? "",
              (v) => patch({ moveMinutes: v ? Number(v) : null }),
              "number",
            )}
            {input(
              "Setup time, minutes",
              draft.setupMinutes ?? "",
              (v) => patch({ setupMinutes: v ? Number(v) : null }),
              "number",
            )}
          </div>
          <label>
            Move/setup basis
            <select
              value={draft.timingBasis}
              onChange={(e) => patch({ timingBasis: e.target.value })}
            >
              <option value="unknown">Unknown</option>
              <option value="confirmed">Confirmed by producer</option>
              <option value="estimate">Producer-approved estimate</option>
            </select>
          </label>
          <p className="small muted">
            No fixed cap removes only the budget cap. Other constraints remain
            in place.
          </p>
        </>
      )}
      {draft.kind === "note" && (
        <label>
          Note
          <textarea
            rows={7}
            value={draft.text}
            onChange={(e) => patch({ text: e.target.value })}
          />
        </label>
      )}
      {error && (
        <div className="notice clay-notice" role="alert">
          {error}
        </div>
      )}
      <div className="edit-footer">
        <p>Preview affected outputs before applying.</p>
        <button className="button primary" disabled={busy} aria-busy={busy}>
          {busy && <LoaderCircle size={14} className="spin" />}
          {busy ? "Preparing preview…" : "Review change"}
          <ArrowUpRight size={14} />
        </button>
      </div>
    </form>
  );
}
export function ChangePanel({ change }: { change: ChangeView }) {
  const { snapshot, actions, previewMode } = useBoard();
  const target = snapshot.entities.find((e) => e._id === change.targetId);
  const editable = snapshot.role !== "viewer" && !previewMode;
  const differences = revisionInputChanges(
    change.before,
    change.proposed,
    snapshot.entities,
  );
  const startTimeOnly = isStartTimeChange(differences);
  const runs = change.runIds.flatMap((id) => {
    const run = snapshot.runs.find((candidate) => candidate._id === id);
    return run ? [run] : [];
  });
  const working = runs.some(
    (run) => run.status === "running" || run.status === "queued",
  );
  const waiting = runs.some((run) => run.status === "waiting");
  const interrupted = runs.some((run) =>
    ["failed", "cancelled", "superseded"].includes(run.status),
  );
  const scheduleChange =
    (change.stagedSchedules?.length ?? 0) > 0 ||
    change.affectedIds.some((id) =>
      snapshot.entities.some(
        (entity) => entity._id === id && entity.data.kind === "schedule",
      ),
    );
  const statusLabel =
    {
      preview: "Review production inputs",
      regenerating: working
        ? "Updating dependent outputs"
        : waiting
          ? "Needs production answers"
          : interrupted
            ? "Update interrupted"
            : "Inputs saved · update outputs",
      ready: scheduleChange
        ? "Review updated schedule"
        : "Review updated outputs",
      applied: "Revision applied",
      undone: "Revision undone",
      discarded: "Draft discarded",
    }[change.status] ?? change.status;
  return (
    <div className="change-content">
      <span className="eyebrow">PRODUCTION REVISION</span>
      <h2>{statusLabel}</h2>
      <p>{target ? titleFor(target) : change.summary}</p>
      <RevisionReview change={change} snapshot={snapshot} />
      <h3>Affected outputs</h3>
      <div className="affected-list">
        {change.affectedIds.map((id) => {
          const e = snapshot.entities.find((e) => e._id === id);
          return e ? (
            <div key={id}>
              <span className="dot clay" />
              {titleFor(e)}
            </div>
          ) : null;
        })}
        {!change.affectedIds.length && (
          <p>No generated outputs depend on this input yet.</p>
        )}
      </div>
      {change.status === "preview" && (
        <p className="small muted">
          Save the proposed inputs first, then generate and inspect the updated
          outputs before applying them.
        </p>
      )}
      {change.status === "regenerating" && !working && !waiting && (
        <p className="small muted">
          The inputs are saved. Generate updated outputs to review them before
          Apply.
        </p>
      )}
      {waiting && (
        <p className="notice brass-notice">
          Answer the pending producer questions to continue this revision. The
          saved input change remains available.
        </p>
      )}
      {change.regenerationError && (
        <p className="notice clay-notice" role="alert">
          {change.regenerationError}
        </p>
      )}
      {interrupted && (
        <p className="notice clay-notice">
          An update was interrupted. Retry the affected outputs using the saved
          inputs, or undo this revision.
        </p>
      )}
      {!editable && (
        <p className="small muted">
          View only · an owner or editor can apply production revisions.
        </p>
      )}
      <div className="actions">
        {change.status === "preview" && (
          <>
            <AsyncButton
              pendingLabel="Discarding…"
              className="button"
              disabled={!editable}
              onClick={() => actions.change("discard", change._id)}
            >
              Discard
            </AsyncButton>
            <AsyncButton
              pendingLabel="Saving…"
              className="button primary"
              disabled={!editable}
              onClick={() => actions.change("commitInputs", change._id)}
            >
              {startTimeOnly
                ? "Save new start time"
                : "Save production input changes"}
            </AsyncButton>
          </>
        )}
        {change.status === "regenerating" && (
          <AsyncButton
            pendingLabel="Starting refresh…"
            className="button primary"
            disabled={!editable || working || waiting}
            onClick={() => actions.change("regenerate", change._id)}
          >
            <Sparkles size={14} />{" "}
            {working
              ? "Updating outputs…"
              : waiting
                ? "Waiting for production answers"
                : interrupted
                  ? "Retry updated outputs"
                  : scheduleChange
                    ? "Generate updated schedule"
                    : "Regenerate affected outputs"}
          </AsyncButton>
        )}
        {change.status === "ready" && (
          <AsyncButton
            pendingLabel="Applying changes…"
            className="button primary"
            disabled={!editable}
            onClick={() => actions.change("apply", change._id)}
          >
            {scheduleChange
              ? "Apply updated schedule"
              : "Apply updated outputs"}
          </AsyncButton>
        )}
        {["regenerating", "ready", "applied"].includes(change.status) && (
          <AsyncButton
            pendingLabel="Undoing change…"
            className="button"
            disabled={!editable}
            onClick={() => actions.change("undo", change._id)}
          >
            Undo change
          </AsyncButton>
        )}
      </div>
      {runs.map((run) => (
        <RunState key={run._id} run={run} />
      ))}
    </div>
  );
}
export function SchedulePanel() {
  return <PlanComparison />;
}
export function PacketPanel({ planId }: { planId?: string }) {
  return <PacketReadiness planId={planId} />;
}
