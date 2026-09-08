"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { ExternalLink } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { BoardRun, Cost, Entity, Source } from "../../domain/model";
import {
  candidateLocations,
  evidenceRuns,
  locationEvidence,
  researchExecution,
  safeSourceUrl,
  type ResearchEvent,
} from "../../domain/research-evidence";
import { useBoard } from "./board-context";
import { RunState } from "./workflow-state";
import styles from "./research-details.module.css";

const timestamp = (value: number) => new Date(value).toLocaleString();

export function SourceEvidence({ sources }: { sources: Source[] }) {
  if (!sources.length)
    return <p className="small muted">No supporting source attached.</p>;
  return (
    <div className={styles.sources}>
      {sources.map((source, index) => {
        const url = safeSourceUrl(source.url);
        return (
          <article className={styles.source} key={`${source.url}-${index}`}>
            {url ? (
              <a href={url} target="_blank" rel="noreferrer">
                {source.title}
                <ExternalLink size={13} aria-hidden="true" />
              </a>
            ) : (
              <strong>{source.title}</strong>
            )}
            <p>
              {source.excerpt.slice(0, 230)}
              {source.excerpt.length > 230 ? "…" : ""}
            </p>
            <small>
              {source.provider === "parallel" ? "Parallel" : source.provider}
              {url ? ` · ${new URL(url).hostname}` : ""}
              {` · ${source.cached ? "Reused evidence" : "Retrieved"} · ${timestamp(source.retrievedAt)}`}
            </small>
            <details>
              <summary>Full saved excerpt and reference</summary>
              <p className={styles.excerpt}>
                {source.excerpt || "No excerpt was saved."}
              </p>
              <span className={styles.reference}>
                Request reference: {source.searchId || "Not recorded"}
              </span>
              <small>
                {source.cached
                  ? "Reused from an earlier retrieval; the timestamp is the original retrieval time."
                  : "Saved retrieval evidence; availability and permission still need confirmation."}
              </small>
            </details>
          </article>
        );
      })}
    </div>
  );
}

function SavedResearchEvents({ run }: { run: BoardRun }) {
  const events = useQuery(api.runs.events, { runId: run._id as Id<"runs"> }) as
    ResearchEvent[] | undefined;
  if (!events) return <p role="status">Loading saved research details…</p>;
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const executions = ordered.flatMap((event) => {
    const execution = researchExecution(event.research);
    return execution ? [{ event, execution }] : [];
  });
  const hasRequest = executions.some(
    ({ execution }) => execution.phase === "request",
  );
  const hasExtract = executions.some(
    ({ execution }) => execution.operation === "extract",
  );
  return (
    <div className={styles.executions}>
      {!hasRequest && (
        <p className="small muted">
          The exact provider request was not recorded in these saved events.
        </p>
      )}
      {!hasExtract && (
        <p className="small muted">
          No Extract execution is recorded here. Source excerpts retain their
          own retrieval references.
        </p>
      )}
      {executions.map(({ event, execution }) => (
        <article className={styles.execution} key={event._id}>
          <h4>
            Parallel {execution.operation === "search" ? "Search" : "Extract"} ·{" "}
            {execution.phase === "request"
              ? "Request sent"
              : execution.phase === "complete"
                ? "Response received"
                : "Failed"}
          </h4>
          <small>
            {timestamp(event.createdAt)} · Attempt {event.attempt}
          </small>
          {execution.objective && (
            <>
              <p>
                <strong>Actual request</strong>
              </p>
              <p className={styles.excerpt}>{execution.objective}</p>
            </>
          )}
          {execution.queries.length > 0 && (
            <>
              <p>
                <strong>Search queries</strong>
              </p>
              <ul>
                {execution.queries.map((query, index) => (
                  <li key={index}>{query}</li>
                ))}
              </ul>
            </>
          )}
          {execution.urls.length > 0 && (
            <>
              <p>
                <strong>Requested source pages</strong>
              </p>
              <ul>
                {execution.urls.map((url) => (
                  <li key={url}>
                    <a href={url} target="_blank" rel="noreferrer">
                      {url}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
          {execution.resultCount !== undefined && (
            <p>
              {execution.resultCount} source result
              {execution.resultCount === 1 ? "" : "s"} returned
            </p>
          )}
          {execution.retrievedAt !== undefined && (
            <small>Retrieved {timestamp(execution.retrievedAt)}</small>
          )}
          <small>
            Cache state:{" "}
            {execution.cached === true
              ? "Reused evidence"
              : execution.cached === false
                ? "Fresh retrieval"
                : "Not recorded"}
          </small>
          <span className={styles.reference}>
            Request reference:{" "}
            {execution.requestId || event.providerId || "Not recorded"}
          </span>
          {execution.error && (
            <p className="notice clay-notice">{execution.error}</p>
          )}
        </article>
      ))}
      {!!ordered.length && (
        <details>
          <summary>
            Saved activity ({ordered.length}
            {ordered.length === 100 ? ", most recent" : ""} events)
          </summary>
          {ordered.map((event) => (
            <p key={event._id}>
              <strong>{event.activity}</strong>
              <small>
                {timestamp(event.createdAt)} · Attempt {event.attempt}
                {event.providerId ? ` · Reference ${event.providerId}` : ""}
              </small>
            </p>
          ))}
        </details>
      )}
      {!ordered.length && (
        <p>No research events have been saved for this task yet.</p>
      )}
    </div>
  );
}

export function ResearchDetails({ entity }: { entity: Entity }) {
  const { snapshot, activePlanId, previewMode } = useBoard();
  const [open, setOpen] = useState(false);
  const [runId, setRunId] = useState<string>();
  const runs = evidenceRuns(
    snapshot.runs,
    entity,
    snapshot.entities,
    activePlanId,
  );
  const run = runs.find((candidate) => candidate._id === runId) ?? runs[0];
  return (
    <details
      className={styles.details}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Research details</summary>
      <p className="small muted">
        Saved provider requests, execution and retrieval references.
      </p>
      {run && (
        <label className={styles.runSelect}>
          Research task
          <select
            value={run._id}
            onChange={(event) => setRunId(event.target.value)}
          >
            {runs.map((candidate) => (
              <option value={candidate._id} key={candidate._id}>
                {candidate.kind === "research" ? "Locations" : "Requirements"} ·{" "}
                {timestamp(candidate.createdAt)} · {candidate.status}
              </option>
            ))}
          </select>
        </label>
      )}
      {run && <RunState run={run} compact />}
      {run && (
        <span className={styles.reference}>Task reference: {run._id}</span>
      )}
      {open && !previewMode && run && <SavedResearchEvents run={run} />}
      {previewMode && (
        <p>
          Live task history is available in the authenticated production
          workspace.
        </p>
      )}
      {!run && !previewMode && (
        <p>
          No matching research task is in the current history. Attached sources
          retain their retrieval references.
        </p>
      )}
    </details>
  );
}

function ClaimSources({
  sources,
  label = "Supporting sources",
}: {
  sources: Source[];
  label?: string;
}) {
  return sources.length ? (
    <details>
      <summary>
        {label} ({sources.length})
      </summary>
      <SourceEvidence sources={sources} />
    </details>
  ) : (
    <p className="small muted">No supporting source attached.</p>
  );
}

function FeeList({ costs, empty }: { costs: Cost[]; empty: string }) {
  if (!costs.length) return <p>{empty}</p>;
  return costs.map((cost) => (
    <div key={cost.id}>
      <p>
        <strong>{cost.label}</strong>
        <br />
        {cost.amountMinor === null
          ? "Not quoted"
          : new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: cost.currency,
            }).format(cost.amountMinor / 100)}{" "}
        · {cost.basis} · per {cost.unit} × {cost.quantity}
      </p>
      {cost.coverageReason && <p>{cost.coverageReason}</p>}
      {cost.assumptions && <p>{cost.assumptions}</p>}
      {cost.source && (
        <ClaimSources sources={[cost.source]} label="Fee evidence" />
      )}
    </div>
  ));
}

export function CandidateComparison({ sceneId }: { sceneId: string }) {
  const { snapshot, activePlanId, inspect } = useBoard();
  const candidates = candidateLocations(
    snapshot.entities,
    sceneId,
    activePlanId,
  );
  const choice = snapshot.choices.find(
    (item) => item.planId === activePlanId && item.sceneId === sceneId,
  );
  if (!candidates.length)
    return (
      <section className={styles.comparison}>
        <h3>Location candidates</h3>
        <p>
          No usable candidates are saved for this scene. Find filming locations
          to review evidence and compare options.
        </p>
      </section>
    );
  return (
    <section className={styles.comparison}>
      <h3>Compare location candidates</h3>
      {candidates.length === 1 && (
        <p className="notice brass-notice">
          Only one usable candidate is saved. There is no alternative to compare
          yet; research again to look for more options.
        </p>
      )}
      <div
        className={styles.scroll}
        tabIndex={0}
        role="region"
        aria-label="Location candidate comparison"
      >
        <table className={styles.table}>
          <caption>
            Saved candidates for this scene. Fees retain their quoted,
            published, estimated or unknown basis.
          </caption>
          <thead>
            <tr>
              <th scope="col">Review</th>
              {candidates.map((candidate) => (
                <th key={candidate._id} scope="col">
                  {candidate.data.name}
                  {candidate.stale && (
                    <p className="badge clay-badge">Needs refresh</p>
                  )}
                  {choice?.locationId === candidate._id && (
                    <p className="badge moss-badge">
                      {choice.locked ? "Selected · locked" : "Selected"}
                    </p>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Creative fit</th>
              {candidates.map((candidate) => (
                <td key={candidate._id}>
                  <p>{candidate.data.creativeFit || "Fit not described."}</p>
                  <ClaimSources
                    sources={candidate.data.sources}
                    label="Location evidence"
                  />
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Access constraints</th>
              {candidates.map((candidate) => (
                <td key={candidate._id}>
                  <p>Authority: {candidate.data.authority || "Unresolved"}</p>
                  {candidate.data.restrictions.length ? (
                    candidate.data.restrictions.map((restriction, index) => (
                      <p key={index}>{restriction}</p>
                    ))
                  ) : (
                    <p>
                      Restrictions not established; confirm access with the
                      authority.
                    </p>
                  )}
                  <ClaimSources
                    sources={candidate.data.sources}
                    label="Access references"
                  />
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Published / quoted fees</th>
              {candidates.map((candidate) => (
                <td key={candidate._id}>
                  <FeeList
                    costs={candidate.data.costs.filter(
                      (cost) =>
                        cost.basis === "published" || cost.basis === "quote",
                    )}
                    empty="No published or quoted fees established."
                  />
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Estimates</th>
              {candidates.map((candidate) => (
                <td key={candidate._id}>
                  <FeeList
                    costs={candidate.data.costs.filter(
                      (cost) => cost.basis === "estimate",
                    )}
                    empty="No estimates saved."
                  />
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Missing quotes</th>
              {candidates.map((candidate) => (
                <td key={candidate._id}>
                  {!candidate.data.costs.length ? (
                    <p>Price evidence is missing. Cost is unknown.</p>
                  ) : (
                    <FeeList
                      costs={candidate.data.costs.filter(
                        (cost) =>
                          cost.basis === "unknown" || cost.amountMinor === null,
                      )}
                      empty="No unknown items among the recorded fees. Confirm the full booking quote."
                    />
                  )}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Applicable requirements</th>
              {candidates.map((candidate) => (
                <td key={candidate._id}>
                  {candidate.data.requirements.length ? (
                    candidate.data.requirements.map((requirement, index) => (
                      <div key={index}>
                        <p>
                          <strong>{requirement.title}</strong> ·{" "}
                          {requirement.status}
                        </p>
                        <p>{requirement.detail}</p>
                        {requirement.applicableFacts.length > 0 && (
                          <p>
                            Applies to: {requirement.applicableFacts.join("; ")}
                          </p>
                        )}
                        <ClaimSources
                          sources={requirement.sources}
                          label="Requirement evidence"
                        />
                      </div>
                    ))
                  ) : (
                    <p>Requirements have not been established.</p>
                  )}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Availability</th>
              {candidates.map((candidate) => (
                <td key={candidate._id}>
                  Unverified · confirm dates and permission with the authority.
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Review candidate</th>
              {candidates.map((candidate) => (
                <td key={candidate._id}>
                  <div className={styles.actions}>
                    <button
                      className="button small-button"
                      onClick={() => inspect(candidate)}
                    >
                      Review location evidence
                    </button>
                    <small>
                      {locationEvidence(candidate.data).length} saved sources
                    </small>
                  </div>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Select or lock the reviewed location on its canvas card. Candidate
        evidence does not establish availability or approval.
      </p>
    </section>
  );
}
