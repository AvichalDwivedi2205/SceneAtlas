"use client";

import { useEffect, useState, type ComponentProps } from "react";
import {
  AlertCircle,
  Check,
  CircleHelp,
  Clock3,
  LoaderCircle,
} from "lucide-react";
import { AsyncButton } from "../../components/async-button";
import { type BoardRun, type TaskKind } from "../../domain/model";
import { useBoard } from "./board-context";

const tasks: Record<
  TaskKind,
  { label: string; working: string; complete: string }
> = {
  ingest: {
    label: "Read screenplay",
    working: "Reading your screenplay…",
    complete: "Screenplay ready to review",
  },
  scenes: {
    label: "Scene breakdown",
    working: "Generating scene groups…",
    complete: "Scene groups ready",
  },
  research: {
    label: "Location search",
    working: "Searching locations…",
    complete: "Location research ready",
  },
  requirements: {
    label: "Requirements",
    working: "Checking official requirements…",
    complete: "Requirements ready to review",
  },
  schedule: {
    label: "Schedule",
    working: "Planning your shooting order…",
    complete: "Proposed schedule ready",
  },
  packet: {
    label: "Preparation packet",
    working: "Preparing your packet…",
    complete: "Preparation packet ready",
  },
  chat: {
    label: "Production assistant",
    working: "Thinking through your request…",
    complete: "Your response is ready",
  },
  interpret: {
    label: "Production change",
    working: "Reviewing your change…",
    complete: "Change ready to review",
  },
};

export function latestRun(
  runs: BoardRun[],
  kind?: TaskKind,
  targetId?: string,
) {
  return runs
    .filter((r) => (!kind || r.kind === kind) && r.targetId === targetId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}
export function isPending(run?: BoardRun) {
  return !!run && ["queued", "running", "waiting"].includes(run.status);
}
export function currentRuns(runs: BoardRun[]) {
  return [...runs]
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter(
      (run, index, all) =>
        !all
          .slice(0, index)
          .some(
            (other) =>
              other.kind === run.kind &&
              other.targetId === run.targetId &&
              other.scope.kind === run.scope.kind &&
              other.scope.sceneId === run.scope.sceneId &&
              other.scope.planId === run.scope.planId,
          ),
    );
}
export function runHeadline(run: BoardRun) {
  if (run.status === "queued") return `${tasks[run.kind].label} queued`;
  if (run.status === "waiting") return "Needs your answer";
  if (run.status === "failed") return `${tasks[run.kind].label} interrupted`;
  if (run.status === "complete") return tasks[run.kind].complete;
  if (run.status === "cancelled") return `${tasks[run.kind].label} cancelled`;
  if (run.status === "superseded") return "Inputs changed · refresh needed";
  return tasks[run.kind].working;
}

export function TaskButton({
  kind,
  targetId,
  ...props
}: Omit<ComponentProps<typeof AsyncButton>, "pending" | "pendingLabel"> & {
  kind: TaskKind;
  targetId?: string;
}) {
  const { snapshot } = useBoard();
  const run = latestRun(snapshot.runs, kind, targetId);
  return (
    <AsyncButton
      {...props}
      pending={isPending(run)}
      pendingIcon={
        run?.status === "waiting" ? <CircleHelp size={14} /> : undefined
      }
      pendingLabel={
        run && isPending(run)
          ? runHeadline(run)
          : `Starting ${tasks[kind].label.toLowerCase()}…`
      }
    />
  );
}

export function RunState({
  run,
  compact = false,
}: {
  run: BoardRun;
  compact?: boolean;
}) {
  const [elapsed, setElapsed] = useState(0);
  const working = run.status === "running" || run.status === "queued";
  useEffect(() => {
    if (!working) return;
    const tick = () =>
      setElapsed(Math.max(0, Math.floor((Date.now() - run.updatedAt) / 1000)));
    tick();
    const timer = setInterval(tick, 5000);
    return () => clearInterval(timer);
  }, [run.updatedAt, working]);
  const Icon =
    run.status === "running"
      ? LoaderCircle
      : run.status === "queued"
        ? Clock3
        : run.status === "waiting"
          ? CircleHelp
          : run.status === "failed"
            ? AlertCircle
            : Check;
  return (
    <div
      className={`workflow-state workflow-${run.status} ${compact ? "compact" : ""}`}
      role="status"
    >
      <Icon
        size={compact ? 14 : 19}
        className={run.status === "running" ? "spin" : ""}
        aria-hidden="true"
      />
      <div>
        <strong>{runHeadline(run)}</strong>
        {!compact && (
          <>
            <p>
              {run.status === "failed"
                ? "Your saved work is safe. Open activity for details and retry."
                : run.status === "waiting"
                  ? "Answer the highlighted production questions to continue."
                  : run.status === "queued"
                    ? "Your task is saved and waiting to start."
                    : run.activity === "Starting managed agent"
                      ? "Starting your production assistant…"
                      : run.activity}
            </p>
            {working && elapsed >= 45 && (
              <small>Still working. You can keep exploring this board.</small>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function BoardProgress({
  runs,
  uploadProgress,
  onActivity,
}: {
  runs: BoardRun[];
  uploadProgress: number | null;
  onActivity: () => void;
}) {
  // A completed retry replaces an older failure for the same task and target.
  const latest = currentRuns(runs);
  const active = latest.filter((r) => isPending(r) || r.status === "failed");
  const run = active.find((r) => r.status === "running") ?? active[0];
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const completed = latest.find(
    (r) => r.status === "complete" && now - r.updatedAt < 12000,
  );
  if (uploadProgress === null && !run && !completed) return null;
  return (
    <div className="board-progress">
      {uploadProgress !== null ? (
        <div className="upload-state" role="status">
          <LoaderCircle size={19} className="spin brass" />
          <div>
            <strong>
              {uploadProgress === 100
                ? "Screenplay received · starting first read…"
                : "Uploading your screenplay…"}
            </strong>
            <div
              className="upload-progress"
              role="progressbar"
              aria-label="Screenplay upload"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={uploadProgress}
            >
              <span style={{ width: `${uploadProgress}%` }} />
            </div>
            <small>{uploadProgress}% transferred</small>
          </div>
        </div>
      ) : (
        <RunState run={run ?? completed!} />
      )}
      <button className="button tiny quiet" onClick={onActivity}>
        {active.length > 1
          ? `${active.length} tasks · View activity`
          : "View activity"}
      </button>
    </div>
  );
}
