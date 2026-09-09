"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  ArrowRight,
  Check,
  CircleHelp,
  Clock3,
  FileText,
  GitBranch,
  LoaderCircle,
  SlidersHorizontal,
  Upload,
} from "lucide-react";
import type { Entity } from "../../domain/model";
import { useBoard } from "./board-context";
import { currentRuns } from "./workflow-state";
import {
  overviewPlanState,
  overviewSetupStage,
  screenplayStatus,
  type OverviewStatus,
} from "./production-overview-state";
import "@xyflow/react/dist/style.css";
import styles from "./production-overview.module.css";

export type ProductionOverviewProps = {
  onUpload: () => void;
  onSetup: () => void;
  onPlan: (planId: string) => void;
  onScenes: () => void;
  uploadProgress: number | null;
};

type OverviewNodeData = ProductionOverviewProps & {
  editable: boolean;
  script?: Entity;
  sceneCount: number;
  planCount: number;
  scriptStatus: OverviewStatus;
  setupLabel: string;
  setupAction: () => void;
  setupWrites: boolean;
  planState?: ReturnType<typeof overviewPlanState>;
  onRetry?: () => void;
};
type OverviewNode = Node<OverviewNodeData, "overview">;

function Status({ status }: { status: OverviewStatus }) {
  const Icon =
    status.tone === "working"
      ? LoaderCircle
      : status.tone === "ready"
        ? Check
        : status.tone === "attention"
          ? CircleHelp
          : Clock3;
  return (
    <div
      className={`${styles.status} ${styles[status.tone]}`}
      role="status"
      aria-live="polite"
    >
      <Icon size={15} aria-hidden="true" />
      <span>
        <strong>{status.label}</strong>
        {status.detail && <small title={status.detail}>{status.detail}</small>}
      </span>
    </div>
  );
}

const OverviewCard = memo(function OverviewCard({
  data,
}: NodeProps<OverviewNode>) {
  const { planState, script } = data;
  if (planState) {
    return (
      <article
        className={`${styles.card} ${styles.planCard} ${planState.budgetMode === "fixed" ? styles.budgetCard : styles.uncappedCard}`}
        aria-label={`${planState.name} overview`}
        data-testid="overview-plan-card"
        data-plan-id={planState.plan._id}
      >
        <Handle type="target" position={Position.Top} isConnectable={false} />
        <div className={styles.cardHeading}>
          <span className={styles.cardIcon}>
            <GitBranch size={20} aria-hidden="true" />
          </span>
          <div>
            <span className={styles.eyebrow}>
              {planState.budgetMode === "fixed"
                ? "Budget plan"
                : "No fixed budget"}
            </span>
            <h3 title={planState.name}>{planState.name}</h3>
          </div>
        </div>
        <div className={styles.planMeta}>
          <strong>{planState.budget}</strong>
          <span>
            {planState.sceneCount} included{" "}
            {planState.sceneCount === 1 ? "scene" : "scenes"}
          </span>
        </div>
        <Status status={planState.status} />
        <div className={styles.planFooter}>
          <span className={styles.scheduleState}>
            {planState.currentSchedule ? (
              <Check size={13} />
            ) : (
              <Clock3 size={13} />
            )}
            {planState.scheduleLabel}
          </span>
          <button
            className={`${styles.openButton} nodrag nopan`}
            onClick={() => data.onPlan(planState.plan._id)}
            aria-label={`Open plan: ${planState.name}`}
          >
            Open plan <ArrowRight size={15} aria-hidden="true" />
          </button>
        </div>
      </article>
    );
  }

  const screenplay = script?.data.kind === "script" ? script.data : undefined;
  const busy = data.scriptStatus.tone === "working";
  return (
    <article
      className={`${styles.card} ${styles.scriptCard} ${!screenplay ? styles.emptyCard : ""}`}
      aria-label={
        screenplay ? "Screenplay overview" : "Start production planning"
      }
      data-testid="overview-screenplay-card"
    >
      {screenplay ? (
        <>
          <div className={styles.cardHeading}>
            <span className={styles.cardIcon}>
              <FileText size={22} aria-hidden="true" />
            </span>
            <div>
              <span className={styles.eyebrow}>The screenplay</span>
              <h2 title={screenplay.filename}>{screenplay.filename}</h2>
            </div>
          </div>
          <p className={styles.scriptMeta}>
            <span>
              <strong>{screenplay.pageCount}</strong> pages
            </span>
            <span>
              <strong>{screenplay.sceneCount || data.sceneCount}</strong> scenes
              found
            </span>
          </p>
          <Status status={data.scriptStatus} />
          <button
            className={`${styles.primaryButton} nodrag nopan`}
            onClick={data.setupAction}
            disabled={data.setupWrites && !data.editable}
          >
            <SlidersHorizontal size={16} aria-hidden="true" />
            {data.setupLabel}
            <ArrowRight size={16} aria-hidden="true" />
          </button>
          <button
            className={`${styles.textButton} nodrag nopan`}
            onClick={data.onScenes}
            disabled={!data.sceneCount}
          >
            All screenplay scenes <span>{data.sceneCount}</span>
          </button>
          {data.planCount > 0 && (
            <Handle
              type="source"
              position={Position.Bottom}
              isConnectable={false}
            />
          )}
        </>
      ) : (
        <>
          <span className={`${styles.cardIcon} ${styles.welcomeIcon}`}>
            <FileText size={27} aria-hidden="true" />
          </span>
          <span className={styles.eyebrow}>For filmmakers &amp; producers</span>
          <h2>Start with your screenplay.</h2>
          <p className={styles.welcomeCopy}>
            Compare two shoot plans. Bring locations, sources, and a shooting
            schedule into one workspace.
          </p>
          {(busy || data.scriptStatus.tone === "attention") && (
            <Status status={data.scriptStatus} />
          )}
          {data.uploadProgress !== null && (
            <progress
              className={styles.progress}
              value={Math.min(100, Math.max(0, data.uploadProgress))}
              max={100}
              aria-label="Screenplay upload progress"
            />
          )}
          <button
            className={`${styles.primaryButton} nodrag nopan`}
            onClick={data.onRetry ?? data.onUpload}
            disabled={!data.editable || busy}
          >
            <Upload size={17} aria-hidden="true" />
            {data.onRetry ? "Retry screenplay read" : "Upload screenplay"}
            <ArrowRight size={17} aria-hidden="true" />
          </button>
          <small className={styles.emptyHint}>
            {data.editable
              ? "Start with a screenplay PDF"
              : "View-only workspace"}
          </small>
        </>
      )}
    </article>
  );
});
const nodeTypes = { overview: OverviewCard };

export function ProductionOverview(props: ProductionOverviewProps) {
  return (
    <ReactFlowProvider>
      <OverviewCanvas {...props} />
    </ReactFlowProvider>
  );
}

function OverviewCanvas(props: ProductionOverviewProps) {
  const { snapshot, actions, act, previewMode } = useBoard();
  const surface = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const flow = useReactFlow<OverviewNode>();
  const editable = snapshot.role !== "viewer" && !previewMode;
  const script = snapshot.entities.find(
    (entity) => entity.data.kind === "script",
  );
  const sceneCount = snapshot.entities.filter(
    (entity) => entity.data.kind === "scene",
  ).length;
  const plans = useMemo(
    () =>
      snapshot.entities
        .filter((entity) => entity.data.kind === "plan")
        .sort((a, b) => {
          const aFixed =
            a.data.kind === "plan" && a.data.budgetMode === "fixed";
          const bFixed =
            b.data.kind === "plan" && b.data.budgetMode === "fixed";
          return Number(bFixed) - Number(aFixed) || a.createdAt - b.createdAt;
        })
        .map((plan) => overviewPlanState(plan, snapshot)),
    [snapshot],
  );
  const ingest = currentRuns(snapshot.runs).find(
    (run) => run.kind === "ingest",
  );
  const scriptState = screenplayStatus(
    snapshot,
    script,
    sceneCount,
    props.uploadProgress,
  );
  const setupStage = overviewSetupStage(snapshot);
  const setupWrites = setupStage !== "work";
  const setupLabel =
    setupStage === "work"
      ? plans.length
        ? "Open plans"
        : "Review selected scenes"
      : setupStage === "scenes"
        ? "Choose scenes & start both"
        : "Set up two plans";
  const setupAction = setupWrites
    ? props.onSetup
    : plans.length
      ? () => props.onPlan(plans[0].plan._id)
      : props.onScenes;
  const shared: OverviewNodeData = {
    ...props,
    editable,
    script,
    sceneCount,
    planCount: plans.length,
    scriptStatus: scriptState,
    setupLabel,
    setupAction,
    setupWrites,
    onRetry:
      ingest?.status === "failed" && editable
        ? () => {
            void act(() => actions.retry(ingest._id));
          }
        : undefined,
  };
  const rootId = script ? `overview:${script._id}` : "overview:welcome";
  const nodes: OverviewNode[] = [
    {
      id: rootId,
      type: "overview",
      position: { x: narrow || !plans.length ? 0 : 220, y: 0 },
      width: narrow ? 360 : 400,
      style: { pointerEvents: "auto" },
      data: shared,
      ariaLabel: script
        ? "Screenplay and shared production setup"
        : "Upload a screenplay to begin",
    },
    ...plans.map((planState, index): OverviewNode => ({
      id: `overview:${planState.plan._id}`,
      type: "overview",
      position: narrow
        ? { x: 0, y: 330 + index * 285 }
        : { x: (index % 2) * 440, y: 330 + Math.floor(index / 2) * 285 },
      width: narrow ? 360 : 400,
      style: { pointerEvents: "auto" },
      data: { ...shared, planState },
      ariaLabel: `${planState.name}, ${planState.budget}, ${planState.sceneCount} included scenes`,
    })),
  ];
  const edges: Edge[] = script
    ? plans.map((plan) => ({
        id: `${rootId}:overview:${plan.plan._id}`,
        source: rootId,
        target: `overview:${plan.plan._id}`,
        type: "smoothstep",
        style: { stroke: "#89966a", strokeWidth: 1.5 },
        selectable: false,
        focusable: false,
      }))
    : [];
  const structure = nodes.map((node) => node.id).join("|");

  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setNarrow(entry.contentRect.width < 720);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // Reframe only when the projected tree changes, never for each run update.
    // A phone starts at the root at readable size; the tree remains pannable.
    const frame = requestAnimationFrame(() => {
      void flow.fitView({
        nodes: narrow ? [{ id: rootId }] : undefined,
        padding: 0.12,
        minZoom: narrow ? 0.75 : 0.65,
        maxZoom: 1,
        duration: 0,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [flow, structure, narrow, rootId]);

  return (
    <section className={styles.overview} aria-label="Production overview">
      <header className={styles.toolbar}>
        <div>
          <span className={styles.eyebrow}>Your production workspace</span>
          <h1>Production overview</h1>
        </div>
        <div className={styles.toolbarActions}>
          {!editable && (
            <span className={styles.viewOnly}>
              {previewMode ? "Preview" : "View only"}
            </span>
          )}
          {script && (
            <button
              className={styles.setupButton}
              onClick={setupAction}
              disabled={setupWrites && !editable}
              aria-label={setupWrites ? "Open production setup" : setupLabel}
            >
              <SlidersHorizontal size={15} aria-hidden="true" />
              {setupLabel}
            </button>
          )}
        </div>
      </header>
      <div className={styles.surface} ref={surface}>
        <ReactFlow<OverviewNode>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          elementsSelectable={false}
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          minZoom={0.4}
          maxZoom={1.5}
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
          aria-label="Screenplay and shoot plans canvas"
        >
          <Background
            id="production-overview-dots"
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1.15}
            color="#45513b"
          />
          <Controls
            showInteractive={false}
            position="bottom-left"
            fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
          />
          <Panel position="bottom-center" className={styles.canvasHint}>
            Drag to explore <span aria-hidden="true">·</span>{" "}
            {narrow ? "Pinch" : "Scroll"} to zoom
          </Panel>
        </ReactFlow>
      </div>
    </section>
  );
}
