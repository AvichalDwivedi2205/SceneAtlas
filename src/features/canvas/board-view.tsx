"use client";
import { ProductionOverview } from "./production-overview";
import { VariantSetup } from "./variant-setup";
import { PlanSelection } from "./plan-selection";
import { PlanJourney } from "./plan-journey";
import { WorkflowGuide } from "./workflow-guide";
import { SceneNavigator } from "./scene-scope";
import { effectivePlanSceneIds } from "../../domain/scope";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ViewportPortal,
  applyNodeChanges,
  useReactFlow,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  Clock3,
  FileText,
  GitBranch,
  LayoutGrid,
  ListFilter,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Plus,
  Search,
  Share2,
  Sparkles,
  StickyNote,
  Upload,
  Users,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AsyncButton } from "../../components/async-button";
import {
  BoardProgress,
  RunState,
  isPending,
  currentRuns,
} from "./workflow-state";
import {
  BoardContext,
  type BoardActions,
  type ChangeView,
  type MessageView,
  type Person,
} from "./board-context";
import { ProductionCard, titleFor, type CardNode } from "./cards";
import {
  ChangePanel,
  EditForm,
  Inspector,
  PacketPanel,
  SchedulePanel,
} from "./panels";
import { arrange } from "./layout";
import {
  stateLabel,
  type BoardSnapshot,
  type Entity,
  type Scope,
} from "../../domain/model";

type Props = {
  snapshot: BoardSnapshot;
  actions: BoardActions;
  changes: ChangeView[];
  messages: MessageView[];
  people: Person[];
  initialView?: "canvas" | "schedule" | "packet";
  uploadProgress?: number | null;
  previewMode?: boolean;
  sharePanel?: ReactNode;
  connected?: boolean;
};
const nodeTypes = { card: ProductionCard };
export function BoardView(props: Props) {
  return (
    <ReactFlowProvider>
      <BoardInterior {...props} />
    </ReactFlowProvider>
  );
}
function subscribeActivePlan(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener("sceneatlas:active-plan", onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener("sceneatlas:active-plan", onChange);
  };
}
function BoardInterior({
  snapshot,
  actions,
  changes,
  messages,
  people,
  initialView = "canvas",
  uploadProgress = null,
  previewMode = false,
  sharePanel,
  connected = true,
}: Props) {
  const flow = useReactFlow<CardNode>();
  const [view, setView] = useState<"canvas" | "plan" | "schedule" | "packet">(
    initialView,
  );
  const [canvasMode, setCanvasMode] = useState<"overview" | "cards">(
    "overview",
  );
  const planStorageKey = `sceneatlas:active-plan:${snapshot.board._id}:${snapshot.me._id}`;
  const activePlanId = useSyncExternalStore(
    subscribeActivePlan,
    () => window.localStorage.getItem(planStorageKey) ?? undefined,
    () => undefined,
  );
  const setPlan = useCallback(
    (id: string) => {
      window.localStorage.setItem(planStorageKey, id);
      window.dispatchEvent(new Event("sceneatlas:active-plan"));
    },
    [planStorageKey],
  );
  const [nodes, setNodes] = useState<CardNode[]>([]);
  const [selectedIds, setSelected] = useState<string[]>([]);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const dragging = useRef(new Set<string>());
  const [drawer, setDrawer] = useState<{
    kind: "inspect" | "edit";
    id: string;
  } | null>(null);
  const [modal, setModal] = useState<
    "share" | "upload" | "note" | "search" | "scenes" | "setup" | "plans" | null
  >(null);
  const [panel, setPanel] = useState<"chat" | "changes" | "activity" | null>(
    null,
  );
  const [changeId, setChangeId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(0);
  const [query, setQuery] = useState("");
  const [chat, setChat] = useState("");
  const [chatScope, setChatScope] = useState("active-plan");
  const [noteText, setNoteText] = useState("");
  const [paste, setPaste] = useState("");
  const [scriptName, setScriptName] = useState("screenplay.txt");
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = useRef(false);
  const viewportRestored = useRef(false);
  const editable = snapshot.role !== "viewer" && !previewMode;
  const plans = snapshot.entities.filter((e) => e.data.kind === "plan");
  const scenes = snapshot.entities
    .filter((e) => e.data.kind === "scene")
    .sort(
      (a, b) =>
        (a.data.kind === "scene" ? a.data.number : 0) -
        (b.data.kind === "scene" ? b.data.number : 0),
    );
  const effectivePlan = plans.find((p) => p._id === activePlanId) ?? plans[0];
  const effectivePlanId = effectivePlan?._id;
  const includedSceneIds =
    effectivePlan?.data.kind === "plan"
      ? effectivePlanSceneIds(effectivePlan.data, scenes)
      : [];
  const act = useCallback(
    async (fn: () => Promise<unknown>, message?: string) => {
      setError("");
      setBusy((n) => n + 1);
      try {
        await fn();
        if (message) setNotice(message);
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : "This change could not be saved. Try again.",
        );
      } finally {
        setBusy((n) => n - 1);
      }
    },
    [],
  );
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const byId = new Map(snapshot.entities.map((e) => [e._id, e]));
    setNodes((current) => {
      const currentById = new Map(current.map((n) => [n.id, n]));
      return snapshot.nodes.flatMap((n) => {
        const entity = byId.get(n.entityId);
        if (!entity) return [];
        const old = currentById.get(n.entityId);
        return [
          {
            id: n.entityId,
            type: "card" as const,
            data: { entity },
            position:
              dragging.current.has(n.entityId) && old
                ? old.position
                : { x: n.x, y: n.y },
            width: n.width,
            initialHeight: n.height,
            selected: old?.selected ?? false,
            draggable: editable,
            selectable: true,
          },
        ];
      });
    });
  }, [snapshot.nodes, snapshot.entities, editable]);
  const viewportKey = `sceneatlas:viewport:${snapshot.board._id}:${snapshot.me._id}`;
  useEffect(() => {
    if (viewportRestored.current || nodes.length === 0) return;
    viewportRestored.current = true;
    const saved = window.localStorage.getItem(viewportKey);
    if (!saved) return;
    try {
      const viewport = JSON.parse(saved) as {
        x?: unknown;
        y?: unknown;
        zoom?: unknown;
      };
      if (
        typeof viewport.x === "number" &&
        typeof viewport.y === "number" &&
        typeof viewport.zoom === "number"
      ) {
        void flow.setViewport(
          { x: viewport.x, y: viewport.y, zoom: viewport.zoom },
          { duration: 0 },
        );
      }
    } catch {
      window.localStorage.removeItem(viewportKey);
    }
  }, [flow, nodes.length, viewportKey]);
  const edges = useMemo(
    () =>
      snapshot.edges.map((e) => ({
        id: e._id,
        source: e.sourceId,
        target: e.targetId,
        type: "smoothstep",
        label: e.relation.replaceAll("_", " "),
        style: {
          stroke: e.relation.includes("plan") ? "#b88d3c" : "#576346",
          strokeWidth: 1.4,
        },
        labelStyle: { fill: "#9ba68d", fontSize: 10 },
        labelBgStyle: { fill: "#181d15" },
        labelBgPadding: [5, 4] as [number, number],
      })),
    [snapshot.edges],
  );
  const focus = useCallback((id: string) => {
    setView("canvas");
    setCanvasMode("cards");
    setSelected([id]);
    setPendingFocus(id);
  }, []);
  useEffect(() => {
    if (!pendingFocus || view !== "canvas" || canvasMode !== "cards") return;
    // Let the previously hidden canvas measure its viewport before centering.
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const node = flow.getNode(pendingFocus);
        if (node)
          void flow.setCenter(
            node.position.x + (node.measured?.width ?? 340) / 2,
            node.position.y + (node.measured?.height ?? 240) / 2,
            { duration: 450, zoom: 0.9 },
          );
        setPendingFocus(null);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [flow, pendingFocus, view, canvasMode]);
  const inspect = useCallback(
    (e: Entity) => setDrawer({ kind: "inspect", id: e._id }),
    [],
  );
  const edit = useCallback(
    (e: Entity) => setDrawer({ kind: "edit", id: e._id }),
    [],
  );
  const context = {
    snapshot,
    actions,
    activePlanId: effectivePlanId,
    selectPlan: setPlan,
    previewMode,
    focus,
    inspect,
    edit,
    act,
  };
  const scope: Scope =
    chatScope === "active-plan"
      ? effectivePlanId
        ? { kind: "plan", planId: effectivePlanId }
        : { kind: "workspace" }
      : chatScope === "workspace"
        ? { kind: "workspace" }
        : chatScope.startsWith("scene:")
          ? { kind: "scene", sceneId: chatScope.slice(6) }
          : chatScope.startsWith("both:")
            ? {
                kind: "plan_scene",
                planId: effectivePlanId,
                sceneId: chatScope.slice(5),
              }
            : { kind: "plan", planId: chatScope.slice(5) };
  const visibleMessages = messages.filter(
    (m) =>
      m.scope.kind === scope.kind &&
      m.scope.sceneId === scope.sceneId &&
      m.scope.planId === scope.planId,
  );
  const chatRun = [...snapshot.runs]
    .sort((a, b) => b.createdAt - a.createdAt)
    .find(
      (r) =>
        r.kind === "chat" &&
        r.scope.kind === scope.kind &&
        r.scope.sceneId === scope.sceneId &&
        r.scope.planId === scope.planId,
    );
  const chatWorking = isPending(chatRun);
  const entity = snapshot.entities.find((e) => e._id === drawer?.id);
  const activeChange = changes.find((c) => c._id === changeId) ?? changes[0];
  const relevantRuns = currentRuns(snapshot.runs).filter(
    (r) => !["complete", "cancelled", "superseded"].includes(r.status),
  );
  const signal = (
    point: { x: number; y: number } | null,
    drag: { entityId: string; x: number; y: number } | null = null,
  ) =>
    actions.signal?.({
      cursor: point,
      selectedIds,
      editingId: drawer?.kind === "edit" ? drawer.id : null,
      drag,
    });
  const onNodesChange = useCallback(
    (changes: NodeChange<CardNode>[]) =>
      setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );
  const onSelectionChange = useCallback(
    ({ nodes: selected }: { nodes: CardNode[] }) => {
      const ids = selected.map((node) => node.id);
      setSelected((current) =>
        current.length === ids.length &&
        current.every((id, index) => id === ids[index])
          ? current
          : ids,
      );
    },
    [],
  );
  async function uploadFile(file: File) {
    if (uploading.current) return;
    uploading.current = true;
    setModal(null);
    try {
      await act(
        () => actions.upload(file),
        "Screenplay uploaded. Reading started.",
      );
    } finally {
      uploading.current = false;
    }
  }
  async function autoLayout() {
    await act(async () => {
      await actions.move(await arrange(snapshot), false);
      setTimeout(
        () => void flow.fitView({ padding: 0.15, duration: 500 }),
        100,
      );
    }, "Unmoved cards arranged. Your placements stay in place.");
  }
  useEffect(() => {
    function key(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.closest("input,textarea,select,[contenteditable=true]"))
        return;
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setModal("search");
      }
      if (e.key === "Escape") {
        setDrawer(null);
        setModal(null);
      }
      if (e.key === "f" && !e.metaKey && !e.ctrlKey)
        void flow.fitView({ padding: 0.15, duration: 400 });
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [flow]);
  return (
    <BoardContext.Provider value={context}>
      <main className={`board-app ${previewMode ? "sample-board" : ""}`}>
        <header className="board-topbar">
          <Link
            className="board-back icon-button"
            href={previewMode ? "/" : "/workspaces"}
            aria-label="Back to workspaces"
          >
            <ArrowLeft size={18} />
          </Link>
          <Link href="/" className="brand compact-brand">
            <i />
            SceneAtlas
          </Link>
          <span className="topbar-divider" />
          <div className="board-name">
            <strong>{snapshot.board.name}</strong>
            <span>
              {previewMode
                ? "Example board · sample content"
                : snapshot.role === "viewer"
                  ? "Shared with you · View only"
                  : `${effectivePlan?.data.kind === "plan" ? effectivePlan.data.name : "No plan yet"} / ${includedSceneIds.length} of ${scenes.length} scenes`}
            </span>
          </div>
          <div className="topbar-right">
            <span className={`save-state ${error ? "clay" : ""}`} role="status">
              {!connected ? (
                "Reconnecting…"
              ) : error ? (
                "Change not saved"
              ) : busy ? (
                <>
                  <LoaderCircle size={12} className="spin" /> Saving
                </>
              ) : (
                <>
                  <Check size={12} />
                  {previewMode ? "Sample" : "Synced"}
                </>
              )}
            </span>
            <div
              className="people-stack"
              title={people
                .filter((p) => p.online)
                .map((p) => p.name)
                .join(", ")}
            >
              {people
                .filter((p) => p.online)
                .slice(0, 4)
                .map((p) => (
                  <span key={p.userId} className="avatar" title={p.name}>
                    {p.name.slice(0, 1).toUpperCase()}
                  </span>
                ))}
            </div>
            <button
              className="button small-button"
              onClick={() => setModal("share")}
            >
              <Share2 size={14} /> Share
            </button>
          </div>
        </header>
        {((view !== "canvas" && view !== "plan") ||
          (view === "canvas" && canvasMode === "cards")) && (
          <WorkflowGuide
            onStage={(stage) => {
              if (stage === "screenplay") {
                const script = snapshot.entities.find(
                  (e) => e.data.kind === "script",
                );
                if (script) focus(script._id);
                else setModal("upload");
              } else if (stage === "scenes" || stage === "locations")
                setModal("scenes");
              else setView(stage);
            }}
          />
        )}
        <div className="board-subbar">
          <div className="view-tabs">
            {(
              [
                { id: "canvas", label: "Infinite canvas", icon: LayoutGrid },
                { id: "schedule", label: "Schedule", icon: Clock3 },
                { id: "packet", label: "Preparation packet", icon: FileText },
              ] as const
            ).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={view === id ? "active" : ""}
                onClick={() => {
                  setView(id);
                  if (id === "canvas") setCanvasMode("overview");
                }}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>
          {view === "canvas" && (
            <button
              className="button tiny quiet"
              aria-pressed={canvasMode === "cards"}
              onClick={() =>
                setCanvasMode(canvasMode === "cards" ? "overview" : "cards")
              }
            >
              {canvasMode === "cards" ? "Plan tree" : "All cards"}
            </button>
          )}
          <div className="board-plan-select">
            <GitBranch size={14} />
            <select
              aria-label="Active plan"
              value={effectivePlanId ?? ""}
              onChange={(e) => setPlan(e.target.value)}
            >
              {!plans.length && (
                <option value="">
                  {snapshot.entities.some((e) => e.data.kind === "script")
                    ? "Choose scenes & plans"
                    : "Upload a screenplay to start"}
                </option>
              )}
              {plans.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.data.kind === "plan" ? p.data.name : ""}
                </option>
              ))}
            </select>
            <ChevronDown size={12} />
          </div>
          <button
            className={`button tiny quiet ${panel === "activity" ? "active" : ""}`}
            onClick={() => setPanel(panel === "activity" ? null : "activity")}
          >
            <span
              className={`dot ${relevantRuns.some((r) => r.status === "running") ? "brass pulse" : "moss"}`}
            />
            {relevantRuns.length
              ? `${relevantRuns.length} ${relevantRuns.some((r) => r.status === "failed" || r.status === "waiting") ? "tasks to review" : "active tasks"}`
              : "Activity"}
          </button>
        </div>
        {previewMode && (
          <div className="preview-banner">
            Example board. Explore cards and views; research and collaboration
            require your workspace.
            <Link href="/workspaces">
              Create workspace <ArrowUp size={12} />
            </Link>
          </div>
        )}
        {!previewMode && (
          <BoardProgress
            runs={snapshot.runs.filter(
              (r) =>
                (!r.scope.planId || r.scope.planId === effectivePlanId) &&
                (!r.scope.sceneId ||
                  includedSceneIds.includes(r.scope.sceneId)),
            )}
            uploadProgress={uploadProgress}
            onActivity={() => setPanel("activity")}
          />
        )}
        {!connected && (
          <div className="connection-notice" role="status">
            Connection interrupted. Showing saved board; pending changes will
            sync when reconnected.
          </div>
        )}
        <div className="board-body">
          <aside className="board-rail">
            <button
              className="rail-button"
              title="Find a card (⌘K)"
              aria-label="Find a card"
              onClick={() => setModal("search")}
            >
              <Search size={18} />
            </button>
            <span className="rail-divider" />
            <button
              className="rail-button"
              title="Scene navigator"
              aria-label="Scene navigator"
              onClick={() => {
                setModal("scenes");
              }}
            >
              <ListFilter size={19} />
            </button>
            <button
              className="rail-button"
              disabled={!editable}
              title="Add production note"
              aria-label="Add production note"
              onClick={() => setModal("note")}
            >
              <StickyNote size={18} />
            </button>
            <AsyncButton
              pendingLabel="Arranging…"
              className="rail-button"
              disabled={
                !editable || view !== "canvas" || canvasMode !== "cards"
              }
              title="Arrange unmoved cards"
              aria-label="Arrange unmoved cards"
              onClick={autoLayout}
            >
              <GitBranch size={18} />
            </AsyncButton>
            <button
              className="rail-button"
              title="Fit board (F)"
              aria-label="Fit board"
              disabled={view !== "canvas" || canvasMode !== "cards"}
              onClick={() =>
                void flow.fitView({ padding: 0.15, duration: 400 })
              }
            >
              <Maximize2 size={18} />
            </button>
            <span className="rail-spacer" />
            <button
              className={`rail-button ${panel === "changes" ? "active" : ""}`}
              title="Review changes"
              aria-label="Review changes"
              onClick={() => setPanel(panel === "changes" ? null : "changes")}
            >
              <GitBranch size={18} />
              {changes.some(
                (c) => c.status === "preview" || c.status === "ready",
              ) && <i />}
            </button>
            <button
              className={`rail-button ${panel === "chat" ? "active" : ""}`}
              title="Production assistant"
              aria-label="Production assistant"
              onClick={() => setPanel(panel === "chat" ? null : "chat")}
            >
              <MessageSquare size={18} />
            </button>
          </aside>
          <section
            className="board-stage"
            aria-label={view === "canvas" ? "Infinite production canvas" : view}
            onMouseMove={(e) => {
              if (view === "canvas" && canvasMode === "cards")
                signal(
                  flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
                );
            }}
            onMouseLeave={() => signal(null)}
          >
            <div
              className="flow-surface"
              data-node-count={nodes.length}
              style={{
                display:
                  view === "canvas" && canvasMode === "cards"
                    ? "block"
                    : "none",
              }}
            >
              <ReactFlow<CardNode>
                nodes={nodes}
                onlyRenderVisibleElements={nodes.length > 80}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onSelectionChange={onSelectionChange}
                onNodeDoubleClick={(_, n) => inspect(n.data.entity)}
                onNodeDragStart={(_, n) => dragging.current.add(n.id)}
                onNodeDrag={(_, n) =>
                  signal(n.position, { entityId: n.id, ...n.position })
                }
                onNodeDragStop={(_, n, group) => {
                  const moved = group.length ? group : [n];
                  signal(n.position);
                  const updates = moved.flatMap((node) => {
                    const saved = snapshot.nodes.find(
                      (record) => record.entityId === node.id,
                    );
                    return saved
                      ? [
                          {
                            nodeId: saved._id,
                            x: node.position.x,
                            y: node.position.y,
                            expectedRevision: saved.geometryRevision,
                          },
                        ]
                      : [];
                  });
                  setError("");
                  setBusy((count) => count + 1);
                  void actions
                    .move(updates, true)
                    .catch((reason: unknown) => {
                      setError(
                        reason instanceof Error
                          ? reason.message
                          : "This card move could not be saved. Try again.",
                      );
                      setNodes((current) =>
                        current.map((node) => {
                          const saved = snapshot.nodes.find(
                            (record) => record.entityId === node.id,
                          );
                          return saved &&
                            moved.some((item) => item.id === node.id)
                            ? { ...node, position: { x: saved.x, y: saved.y } }
                            : node;
                        }),
                      );
                    })
                    .finally(() => {
                      for (const node of moved)
                        dragging.current.delete(node.id);
                      setBusy((count) => count - 1);
                    });
                }}
                onMoveEnd={(_, viewport) =>
                  window.localStorage.setItem(
                    viewportKey,
                    JSON.stringify(viewport),
                  )
                }
                nodesConnectable={false}
                deleteKeyCode={null}
                minZoom={0.025}
                maxZoom={1.5}
                fitView
                fitViewOptions={{ padding: 0.18, maxZoom: 0.8 }}
                panOnScroll
                selectionOnDrag
                panOnDrag={[1, 2]}
                selectionKeyCode="Shift"
                zoomOnDoubleClick={false}
                proOptions={{ hideAttribution: false }}
              >
                <Background
                  variant={BackgroundVariant.Dots}
                  color="#46503b"
                  gap={22}
                  size={1}
                />
                <Controls showInteractive={false} />
                <MiniMap
                  nodeColor={(n) => {
                    const d = (n.data as CardNode["data"]).entity.data;
                    return d.kind === "question"
                      ? "#cc6250"
                      : d.kind === "plan"
                        ? "#dca83c"
                        : "#637b4a";
                  }}
                  maskColor="rgba(19,22,16,.7)"
                  pannable
                  zoomable
                />
                <ViewportPortal>
                  {people
                    .filter((p) => p.userId !== snapshot.me._id && p.online)
                    .flatMap((p) =>
                      p.signals
                        .filter((s) => s.cursor && s.expiresAt > Date.now())
                        .map((s, i) => (
                          <div
                            key={`${p.userId}-${i}`}
                            className="remote-cursor"
                            style={{
                              transform: `translate(${s.cursor!.x}px, ${s.cursor!.y}px)`,
                            }}
                          >
                            <svg width="16" height="20" viewBox="0 0 16 20">
                              <path
                                d="M1 1L14 13H7L4 19Z"
                                fill="#dca83c"
                                stroke="#181d15"
                              />
                            </svg>
                            <span>
                              {p.name}
                              {s.editingId ? " · editing" : ""}
                            </span>
                          </div>
                        )),
                    )}
                </ViewportPortal>
              </ReactFlow>
              {!snapshot.entities.length && (
                <div className="empty-board">
                  <div className="empty-board-icon">
                    <FileText size={28} />
                    <span>
                      <Plus size={12} />
                    </span>
                  </div>
                  <span className="eyebrow">A NEW PRODUCTION STARTS HERE</span>
                  <h1>Upload your screenplay</h1>
                  <p>
                    Upload a screenplay. Answer the production questions.
                    <br />
                    Build the shooting plan, one connected decision at a time.
                  </p>
                  {editable && (
                    <button
                      className="button primary"
                      disabled={
                        uploadProgress !== null ||
                        relevantRuns.some(
                          (r) => r.kind === "ingest" && isPending(r),
                        )
                      }
                      onClick={() => setModal("upload")}
                    >
                      <Upload size={15} /> Upload screenplay
                    </button>
                  )}
                  <span className="small muted">
                    PDF or plain text · up to 50 MB
                  </span>
                  {relevantRuns
                    .filter((r) => r.status === "failed")
                    .map((r) => (
                      <div className="notice" key={r._id}>
                        {r.activity}
                        {r.error && <p className="error">{r.error}</p>}
                        {r.status === "failed" && editable && (
                          <AsyncButton
                            pendingLabel="Retrying…"
                            className="button tiny"
                            onClick={() => act(() => actions.retry(r._id))}
                          >
                            Retry
                          </AsyncButton>
                        )}
                      </div>
                    ))}
                </div>
              )}
              {scenes.length > 0 && (
                <nav className="scene-jump" aria-label="Scene navigation">
                  <span>SCENES</span>
                  {scenes.map((s) => (
                    <button
                      key={s._id}
                      title={titleFor(s)}
                      onClick={() => focus(s._id)}
                    >
                      {s.data.kind === "scene"
                        ? String(s.data.number).padStart(2, "0")
                        : ""}
                    </button>
                  ))}
                </nav>
              )}
            </div>
            {view === "canvas" && canvasMode === "overview" && (
              <ProductionOverview
                onAddPlans={() => setModal("plans")}
                uploadProgress={uploadProgress}
                onUpload={() => setModal("upload")}
                onSetup={() => setModal("setup")}
                onScenes={() => setModal("scenes")}
                onPlan={(id) => {
                  setPlan(id);
                  setView("plan");
                }}
              />
            )}
            {view === "plan" && (
              <PlanJourney
                key={effectivePlanId}
                onBack={() => {
                  setView("canvas");
                  setCanvasMode("overview");
                }}
                onSetup={() => setModal("setup")}
                onCompare={() => setView("schedule")}
                onPacket={() => setView("packet")}
              />
            )}
            {view === "schedule" && <SchedulePanel />}
            {view === "packet" && <PacketPanel planId={effectivePlanId} />}
            {(error || notice) && (
              <div
                className={`toast ${error ? "error-toast" : ""}`}
                role={error ? "alert" : "status"}
              >
                <span>{error || notice}</span>
                <button
                  className="icon-button"
                  aria-label="Dismiss notification"
                  onClick={() => {
                    setError("");
                    setNotice("");
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </section>
          {panel && (
            <aside className="assistant-panel">
              <header>
                <div>
                  <span className="eyebrow">SCENEATLAS</span>
                  <h2>
                    {panel === "chat"
                      ? "Production assistant"
                      : panel === "changes"
                        ? "Review changes"
                        : "Board activity"}
                  </h2>
                </div>
                <button
                  className="icon-button"
                  aria-label="Close panel"
                  onClick={() => setPanel(null)}
                >
                  <X size={17} />
                </button>
              </header>
              {panel === "chat" && (
                <>
                  <label className="scope-select">
                    Working within
                    <select
                      value={chatScope}
                      onChange={(e) => setChatScope(e.target.value)}
                    >
                      <option value="active-plan">
                        {effectivePlan?.data.kind === "plan"
                          ? `${effectivePlan.data.name} · included scenes`
                          : "Workspace inputs"}
                      </option>
                      <option value="workspace">Whole workspace</option>
                      {plans.map((p) => (
                        <option key={p._id} value={`plan:${p._id}`}>
                          {titleFor(p)}
                        </option>
                      ))}
                      {scenes.map((s) => (
                        <option key={s._id} value={`scene:${s._id}`}>
                          {titleFor(s)}
                        </option>
                      ))}
                      {effectivePlanId &&
                        scenes
                          .filter((s) => includedSceneIds.includes(s._id))
                          .map((s) => (
                            <option
                              key={`both-${s._id}`}
                              value={`both:${s._id}`}
                            >
                              Active plan + {titleFor(s)}
                            </option>
                          ))}
                    </select>
                  </label>
                  <div className="chat-messages">
                    {!visibleMessages.length && (
                      <div className="chat-empty">
                        <Sparkles size={25} />
                        <h3>A second set of eyes.</h3>
                        <p>
                          Ask about evidence, explore tradeoffs, or describe a
                          change. Material edits arrive for your review.
                        </p>
                        <button
                          className="suggestion"
                          onClick={() =>
                            setChat(
                              "What production decisions still need my answer?",
                            )
                          }
                        >
                          What still needs my answer?
                        </button>
                        <button
                          className="suggestion"
                          onClick={() =>
                            setChat("Explain the cost tradeoffs in this scope.")
                          }
                        >
                          Explain the cost tradeoffs
                        </button>
                      </div>
                    )}
                    {visibleMessages.map((m) => (
                      <article key={m._id} className={`chat-message ${m.role}`}>
                        <span>
                          {m.role === "assistant" ? "SceneAtlas" : "Producer"}
                        </span>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {m.text}
                        </ReactMarkdown>
                        {m.changeId && (
                          <button
                            className="button tiny"
                            onClick={() => {
                              setChangeId(m.changeId!);
                              setPanel("changes");
                            }}
                          >
                            Review proposed change
                          </button>
                        )}
                      </article>
                    ))}
                    {chatRun &&
                      (chatWorking || chatRun.status === "failed") && (
                        <RunState run={chatRun} />
                      )}
                  </div>
                  <form
                    className="chat-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!chat.trim() || chatWorking || busy) return;
                      const text = chat;
                      void act(async () => {
                        await actions.start("chat", undefined, scope, {
                          message: text,
                        });
                        setChat("");
                      });
                    }}
                  >
                    <textarea
                      aria-label="Message production assistant"
                      placeholder={
                        editable ? "Ask or describe a change…" : "View only"
                      }
                      value={chat}
                      disabled={!editable}
                      onChange={(e) => setChat(e.target.value)}
                      rows={3}
                    />
                    <footer>
                      <span>Changes need your review.</span>
                      <button
                        className="send-button"
                        disabled={
                          !editable || !chat.trim() || busy > 0 || chatWorking
                        }
                        aria-label={
                          chatWorking ? "Assistant is working" : "Send message"
                        }
                        aria-busy={chatWorking || busy > 0}
                      >
                        {chatWorking || busy > 0 ? (
                          <LoaderCircle size={16} className="spin" />
                        ) : (
                          <ArrowUp size={16} />
                        )}
                      </button>
                    </footer>
                  </form>
                </>
              )}
              {panel === "changes" && (
                <div className="panel-scroll">
                  {!changes.length ? (
                    <div className="chat-empty">
                      <GitBranch size={24} />
                      <h3>No pending changes.</h3>
                      <p>
                        Edit a saved answer or production setting to preview its
                        impact.
                      </p>
                    </div>
                  ) : (
                    <>
                      <select
                        aria-label="Choose revision"
                        value={activeChange?._id ?? ""}
                        onChange={(e) => setChangeId(e.target.value)}
                      >
                        {changes.map((c) => (
                          <option key={c._id} value={c._id}>
                            {c.status} · {c.summary}
                          </option>
                        ))}
                      </select>
                      {activeChange && <ChangePanel change={activeChange} />}
                    </>
                  )}
                </div>
              )}
              {panel === "activity" && (
                <div className="panel-scroll">
                  {!snapshot.runs.length && (
                    <p className="muted">
                      Your workflow activity will appear here.
                    </p>
                  )}
                  {snapshot.runs.map((r) => (
                    <article className="activity-item" key={r._id}>
                      <span
                        className={`badge ${r.status === "failed" ? "clay-badge" : r.status === "complete" ? "moss-badge" : "brass-badge"}`}
                      >
                        {stateLabel[r.status]}
                      </span>
                      <RunState run={r} />
                      <small>
                        {r.kind} · {new Date(r.updatedAt).toLocaleTimeString()}
                      </small>
                      {r.error && <p className="error">{r.error}</p>}
                      {editable && (
                        <div className="actions">
                          {["queued", "running", "waiting"].includes(
                            r.status,
                          ) && (
                            <AsyncButton
                              pendingLabel="Cancelling…"
                              className="button tiny"
                              onClick={() => act(() => actions.cancel(r._id))}
                            >
                              Cancel
                            </AsyncButton>
                          )}
                          {["failed", "cancelled", "superseded"].includes(
                            r.status,
                          ) && (
                            <AsyncButton
                              pendingLabel="Retrying…"
                              className="button tiny"
                              onClick={() => act(() => actions.retry(r._id))}
                            >
                              Retry
                            </AsyncButton>
                          )}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </aside>
          )}
        </div>
        <Dialog.Root
          open={Boolean(drawer && entity)}
          onOpenChange={(open) => {
            if (!open) setDrawer(null);
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="drawer-overlay" />
            <Dialog.Content
              className="entity-drawer"
              aria-describedby={undefined}
            >
              <Dialog.Title className="sr-only">
                {drawer?.kind === "edit"
                  ? "Edit production decision"
                  : "Card details"}
              </Dialog.Title>
              <Dialog.Close
                className="drawer-close icon-button"
                aria-label="Close details"
              >
                <X size={18} />
              </Dialog.Close>
              {entity &&
                (drawer?.kind === "edit" ? (
                  <EditForm
                    key={`${entity._id}-${drawer.id}`}
                    entity={entity}
                    onSaved={(id) => {
                      setDrawer(null);
                      setChangeId(id);
                      setPanel("changes");
                    }}
                  />
                ) : (
                  <Inspector entity={entity} />
                ))}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <Dialog.Root
          open={modal !== null}
          onOpenChange={(open) => {
            if (!open) setModal(null);
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="modal-overlay" />
            <Dialog.Content
              className={`modal-content ${modal === "setup" || modal === "plans" ? "variant-modal" : ""}`}
              aria-describedby={undefined}
            >
              <Dialog.Title>
                {modal === "share"
                  ? "Bring your team to the board"
                  : modal === "upload"
                    ? "Start with your screenplay"
                    : modal === "search"
                      ? "Find a card"
                      : modal === "plans"
                        ? "Choose scenes and plan options"
                        : modal === "setup"
                          ? "Configure selected plans"
                          : modal === "scenes"
                            ? "Screenplay scenes"
                            : "Add a production note"}
              </Dialog.Title>
              <Dialog.Close
                className="modal-close icon-button"
                aria-label="Close dialog"
              >
                <X size={18} />
              </Dialog.Close>
              {modal === "plans" && (
                <PlanSelection
                  onDone={() => {
                    setModal(null);
                    setView("canvas");
                    setCanvasMode("overview");
                  }}
                />
              )}
              {modal === "setup" && (
                <VariantSetup
                  key={scenes.length ? "scenes" : "brief"}
                  onDone={() => {
                    setModal(null);
                    setView("canvas");
                    setCanvasMode("overview");
                  }}
                />
              )}
              {modal === "share" &&
                (previewMode ? (
                  <div className="chat-empty">
                    <Users size={30} />
                    <p>
                      Invite editors and viewers from your own private
                      workspace. Everyone sees the same production decisions.
                    </p>
                    <Link className="button primary" href="/workspaces">
                      Create workspace
                    </Link>
                  </div>
                ) : (
                  sharePanel
                ))}
              {modal === "upload" && (
                <>
                  <p className="muted">
                    Original screenplay stays attached. Scene generation follows
                    your clarification answers.
                  </p>
                  <input
                    ref={fileInput}
                    className="sr-only"
                    type="file"
                    accept="application/pdf,text/plain,.pdf,.txt"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadFile(f);
                    }}
                  />
                  <button
                    className="file-drop"
                    onClick={() => fileInput.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const f = e.dataTransfer.files[0];
                      if (f) void uploadFile(f);
                    }}
                  >
                    <Upload size={25} />
                    <strong>Drop your screenplay here</strong>
                    <span>
                      PDF with selectable text / text file · up to 50 MB
                    </span>
                  </button>
                  <div className="or-divider">or paste screenplay text</div>
                  <form
                    className="edit-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void uploadFile(
                        new File(
                          [paste],
                          scriptName.endsWith(".txt")
                            ? scriptName
                            : `${scriptName}.txt`,
                          { type: "text/plain" },
                        ),
                      );
                    }}
                  >
                    <input
                      aria-label="Screenplay filename"
                      value={scriptName}
                      onChange={(e) => setScriptName(e.target.value)}
                      required
                    />
                    <textarea
                      aria-label="Screenplay text"
                      placeholder="INT. A ROOM — DAY…"
                      rows={5}
                      value={paste}
                      onChange={(e) => setPaste(e.target.value)}
                      minLength={50}
                      required
                    />
                    <button
                      className="button primary"
                      disabled={paste.trim().length < 50}
                    >
                      Read screenplay <Sparkles size={14} />
                    </button>
                  </form>
                </>
              )}
              {modal === "note" && (
                <form
                  className="edit-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const pos = flow.screenToFlowPosition({
                      x: window.innerWidth / 2,
                      y: window.innerHeight / 2,
                    });
                    void act(async () => {
                      await actions.note(noteText, pos.x, pos.y);
                      setNoteText("");
                      setModal(null);
                    }, "Note added");
                  }}
                >
                  <textarea
                    autoFocus
                    aria-label="Production note"
                    rows={6}
                    maxLength={10000}
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    required
                  />
                  <button
                    className="button primary"
                    disabled={!noteText.trim() || busy > 0}
                    aria-busy={busy > 0}
                  >
                    {busy > 0 ? (
                      <>
                        <LoaderCircle size={14} className="spin" /> Adding note…
                      </>
                    ) : (
                      "Add note"
                    )}
                  </button>
                </form>
              )}
              {modal === "scenes" && (
                <SceneNavigator onNavigate={() => setModal(null)} />
              )}
              {modal === "search" && (
                <>
                  <div className="search-field">
                    <Search size={17} />
                    <input
                      autoFocus
                      aria-label="Search board"
                      placeholder="Search scenes, locations, decisions…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    <kbd>⌘ K</kbd>
                  </div>
                  <div className="search-results">
                    {snapshot.entities
                      .filter((e) =>
                        `${e.data.kind} ${titleFor(e)} ${JSON.stringify(e.data)}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                      )
                      .map((e) => (
                        <button
                          key={e._id}
                          onClick={() => {
                            focus(e._id);
                            setModal(null);
                          }}
                        >
                          <span className="badge">{e.data.kind}</span>
                          <span>{titleFor(e)}</span>
                          <ArrowUp size={13} />
                        </button>
                      ))}
                  </div>
                </>
              )}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </main>
    </BoardContext.Provider>
  );
}
