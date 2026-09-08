"use client";

import { usePaginatedQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { Entity } from "../../domain/model";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  CircleHelp,
  Download,
  FileText,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { AssetButton } from "../../components/asset-button";
import { packetReadiness } from "../../domain/packet";
import { useBoard } from "./board-context";
import { latestRun, RunState, TaskButton } from "./workflow-state";

export { packetReadiness } from "../../domain/packet";

const stateLabel = {
  ready: "Ready",
  needs_input: "Needs input",
  needs_refresh: "Needs refresh",
  unverified: "Needs confirmation",
};

function PacketHistory({
  packet,
  currentAssetId,
}: {
  packet: Entity;
  currentAssetId: string;
}) {
  const { snapshot } = useBoard();
  const { results, status, loadMore } = usePaginatedQuery(
    api.packets.history,
    { packetId: packet._id as Id<"entities"> },
    { initialNumItems: 20 },
  );
  const seen = new Set([currentAssetId]);
  const documents = results.filter((version) => {
    if (seen.has(version.data.assetId)) return false;
    seen.add(version.data.assetId);
    return true;
  });
  return (
    <details className="source-item">
      <summary>
        Earlier packet PDFs{documents.length ? ` · ${documents.length}` : ""}
      </summary>
      <p className="small muted">
        Earlier documents retain the plan inputs and scene scope saved when they
        were built.
      </p>
      {status === "LoadingFirstPage" && (
        <p role="status">Loading document history…</p>
      )}
      {!documents.length && status === "Exhausted" && (
        <p>No earlier packet PDFs have been saved.</p>
      )}
      {documents.map(({ data }) => (
        <article className="source-item" key={data.assetId}>
          <strong>
            {new Date(data.builtAt).toLocaleString()} · Historical draft
          </strong>
          <p>
            {data.includedSceneIds
              ? `${data.includedSceneIds.length} included scenes · ${data.includedSceneIds
                  .map((id) => {
                    const scene = snapshot.entities.find(
                      (entity) => entity._id === id,
                    );
                    return scene?.data.kind === "scene"
                      ? `Scene ${scene.data.number}`
                      : "Removed scene";
                  })
                  .join(" · ")}`
              : "Legacy document: scene scope was not recorded."}
          </p>
          <p className="small muted">
            Plan revision {data.sourcePlanRevision ?? "not recorded"} · Schedule
            revision {data.sourceScheduleRevision ?? "not recorded"}
            <br />
            Source version: {data.sourceVersion ?? "not recorded"}
          </p>
          <div className="actions">
            <AssetButton
              mode="open"
              assetId={data.assetId}
              filename={data.filename}
            >
              <ArrowUpRight size={15} />
              Open historical PDF
            </AssetButton>
            <AssetButton assetId={data.assetId} filename={data.filename}>
              <Download size={15} />
              Download historical PDF
            </AssetButton>
          </div>
        </article>
      ))}
      {status !== "Exhausted" && status !== "LoadingFirstPage" && (
        <button
          className="button small"
          disabled={status === "LoadingMore"}
          onClick={() => loadMore(20)}
        >
          {status === "LoadingMore"
            ? "Loading older documents…"
            : "Load older documents"}
        </button>
      )}
    </details>
  );
}

export function PacketReadiness({ planId }: { planId?: string }) {
  const { snapshot, actions, act, previewMode, inspect } = useBoard();
  const readiness = packetReadiness(snapshot, planId);
  if (!readiness)
    return (
      <section className="planning-view">
        <h1>Production preparation packet</h1>
        <p>Choose a production plan to review packet readiness.</p>
      </section>
    );
  const { plan, packet, data, historical } = readiness;
  const run = latestRun(snapshot.runs, "packet", plan._id);
  const sourceLabel =
    data?.sourceVersion ?? "Not recorded for this legacy packet";
  return (
    <section className="planning-view">
      <div className="planning-heading">
        <span className="eyebrow">PREPARATION PACKET</span>
        <h1>Review your production handoff</h1>
        <p>
          {plan.data.kind === "plan" ? plan.data.name : "Active plan"} ·{" "}
          {readiness.scenes.length} of{" "}
          {snapshot.entities.filter((e) => e.data.kind === "scene").length}{" "}
          scenes included
        </p>
      </div>
      <div className="packet-grid">
        <article className="glass packet-main">
          <FileText size={28} className="brass" />
          <h2>Production preparation packet</h2>
          <p>
            Selected scenes, saved decisions, applied timings, costs, and source
            evidence.
          </p>
          {run &&
            ["queued", "running", "waiting", "failed"].includes(run.status) && (
              <RunState run={run} />
            )}
          {readiness.checks.map((check) => {
            const Icon =
              check.state === "ready"
                ? Check
                : check.state === "unverified"
                  ? CircleHelp
                  : AlertCircle;
            return (
              <div className="checklist-item" key={check.key}>
                <Icon
                  size={16}
                  className={check.state === "ready" ? "moss" : "brass"}
                  aria-hidden="true"
                />
                <div>
                  <strong>
                    {check.label} · {stateLabel[check.state]}
                  </strong>
                  <div className="muted">{check.detail}</div>
                </div>
              </div>
            );
          })}
          {historical && (
            <div className="notice clay-notice">
              This PDF records an earlier version of the plan. Apply the current
              schedule and rebuild before using the packet as current.
            </div>
          )}
          <div className="actions">
            <TaskButton
              kind="packet"
              targetId={plan._id}
              className="button primary"
              disabled={
                !readiness.canBuild || previewMode || snapshot.role === "viewer"
              }
              title={
                snapshot.role === "viewer"
                  ? "Viewers can open and download saved packets."
                  : readiness.productionInputs[0]
              }
              onClick={() =>
                act(() =>
                  actions.start("packet", plan._id, {
                    kind: "plan",
                    planId: plan._id,
                  }),
                )
              }
            >
              <Sparkles size={15} />{" "}
              {data ? "Rebuild packet" : "Prepare packet"}
            </TaskButton>
            {data && !previewMode && (
              <>
                <AssetButton
                  mode="open"
                  assetId={data.assetId}
                  filename={data.filename}
                >
                  <ArrowUpRight size={15} />
                  {historical ? "Open historical PDF" : "Open PDF"}
                </AssetButton>
                <AssetButton assetId={data.assetId} filename={data.filename}>
                  <Download size={15} />
                  {historical ? "Download historical PDF" : "Download PDF"}
                </AssetButton>
              </>
            )}
            {data?.manifestAssetId && !previewMode && (
              <AssetButton
                assetId={data.manifestAssetId}
                filename="source-manifest.json"
                className="text-link"
              >
                Download JSON manifest <ArrowUpRight size={13} />
              </AssetButton>
            )}
          </div>
          {!!readiness.productionInputs.length && (
            <>
              <h3>Production inputs needed</h3>
              {readiness.productionInputs.map((item) => (
                <p className="restriction" key={item}>
                  {item}
                </p>
              ))}
              <button className="button small" onClick={() => inspect(plan)}>
                Review plan inputs
              </button>
            </>
          )}
          {data && (
            <details className="source-item">
              <summary>Document version and included scenes</summary>
              <div className="detail-row">
                <span>Generated</span>
                <span>{new Date(data.builtAt).toLocaleString()}</span>
              </div>
              <div className="detail-row">
                <span>Source version</span>
                <span>{sourceLabel}</span>
              </div>
              <div className="detail-row">
                <span>Plan / schedule revisions</span>
                <span>
                  {data.sourcePlanRevision ?? "Legacy"} /{" "}
                  {data.sourceScheduleRevision ?? "Legacy"}
                </span>
              </div>
              <p>
                {data.includedSceneIds
                  ? `${data.includedSceneIds.length} scenes in this document`
                  : "Legacy document: consult its assignments in the PDF or manifest for scope."}
              </p>
              {data.includedSceneIds && (
                <p>
                  {data.includedSceneIds
                    .map((id) => {
                      const scene = snapshot.entities.find((e) => e._id === id);
                      return scene?.data.kind === "scene"
                        ? `Scene ${scene.data.number}`
                        : "Removed scene";
                    })
                    .join(" · ")}
                </p>
              )}
            </details>
          )}
          {packet && data && !previewMode && (
            <PacketHistory packet={packet} currentAssetId={data.assetId} />
          )}
        </article>
        <aside className="glass packet-sidebar">
          <ShieldCheck size={23} className="brass" />
          <h3>Preparation draft</h3>
          <div className="detail-row">
            <span>Document</span>
            <span className="badge">
              {historical
                ? "Historical draft"
                : packet
                  ? "Current draft"
                  : "Not prepared"}
            </span>
          </div>
          <div className="detail-row">
            <span>Application</span>
            <span className="badge">Not submitted</span>
          </div>
          <div className="detail-row">
            <span>Approval</span>
            <span className="badge brass-badge">Unverified</span>
          </div>
          <p>
            Filing, payment, signatures, bookings, and approvals happen outside
            SceneAtlas. A draft can carry unknown external facts for follow-up.
          </p>
          <h3>External confirmations</h3>
          {readiness.externalFollowups.length ? (
            readiness.externalFollowups.map((item) => (
              <p className="restriction" key={item}>
                {item}
              </p>
            ))
          ) : (
            <p>Select locations to identify external follow-ups.</p>
          )}
          {!!readiness.questions.length && (
            <>
              <h3>Unresolved production questions</h3>
              {readiness.questions.map((question) => (
                <button
                  className="text-link"
                  key={question._id}
                  onClick={() => inspect(question)}
                >
                  {question.data.kind === "question"
                    ? question.data.prompt
                    : "Review question"}
                </button>
              ))}
            </>
          )}
          {data && historical && (
            <details>
              <summary>Follow-ups saved in the historical PDF</summary>
              {data.unresolved.map((item) => (
                <p key={item}>{item}</p>
              ))}
            </details>
          )}
        </aside>
      </div>
    </section>
  );
}
