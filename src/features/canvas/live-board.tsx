"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useConvexConnectionState } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type {
  BoardSnapshot,
  Scope,
  TaskKind,
  Entity,
  EntityData,
} from "../../domain/model";
import { BoardView } from "./board-view";
import { SharePanel } from "../workspaces/share-panel";
import type { BoardActions, Move } from "./board-context";
import { LoadingState } from "../../components/loading-state";
export function LiveBoard({
  boardId,
  initialView = "canvas",
}: {
  boardId: string;
  initialView?: "canvas" | "schedule" | "packet";
}) {
  const id = boardId as Id<"boards">;
  const connection = useConvexConnectionState();
  const snapshot = useQuery(api.boards.snapshot, { boardId: id }) as unknown as
    BoardSnapshot | undefined;
  const changes = useQuery(api.changes.list, { boardId: id });
  const messages = useQuery(api.changes.messages, { boardId: id });
  const people = useQuery(api.presence.list, { boardId: id });
  const start = useMutation(api.runs.start),
    preview = useMutation(api.changes.preview),
    move = useMutation(api.boards.move),
    choose = useMutation(api.planning.select),
    startPlans = useMutation(api.planning.startReadyPlans),
    note = useMutation(api.boards.addNote);
  const requestUpload = useMutation(api.assets.requestUpload),
    finish = useMutation(api.assets.finishUpload),
    cancel = useMutation(api.runs.cancel),
    retry = useMutation(api.runs.retry);
  const commit = useMutation(api.changes.commitInputs),
    regenerate = useMutation(api.changes.regenerate),
    apply = useMutation(api.changes.apply),
    undo = useMutation(api.changes.undo),
    discard = useMutation(api.changes.discard);
  const heartbeat = useMutation(api.presence.heartbeat),
    signal = useMutation(api.presence.signal),
    leave = useMutation(api.presence.leave);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const session = useRef("");
  const lastSignal = useRef(0);
  useEffect(() => {
    session.current = crypto.randomUUID();
    let token = "";
    let alive = true;
    const beat = () =>
      heartbeat({ boardId: id, sessionId: session.current })
        .then((r) => {
          if (alive) token = r.sessionToken;
        })
        .catch(() => {});
    void beat();
    const interval = setInterval(beat, 15000);
    return () => {
      alive = false;
      clearInterval(interval);
      if (token) void leave({ sessionToken: token });
    };
  }, [heartbeat, id, leave]);
  const upload = useCallback(
    async (file: File) => {
      const mime =
        file.type ||
        (file.name.endsWith(".pdf") ? "application/pdf" : "text/plain");
      setUploadProgress(0);
      try {
        const grant = await requestUpload({
          boardId: id,
          filename: file.name,
          mime,
          size: file.size,
        });
        const storageId = await new Promise<Id<"_storage">>(
          (resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", grant.url);
            xhr.setRequestHeader("Content-Type", mime);
            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable)
                setUploadProgress(Math.round((e.loaded / e.total) * 100));
            };
            xhr.onerror = () =>
              reject(new Error("Upload connection failed. Retry your file."));
            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                try {
                  resolve(JSON.parse(xhr.responseText).storageId);
                } catch {
                  reject(new Error("Upload returned an invalid response."));
                }
              } else reject(new Error("Upload failed. Retry your file."));
            };
            xhr.send(file);
          },
        );
        const assetId = await finish({ ticketId: grant.ticketId, storageId });
        await start({
          boardId: id,
          kind: "ingest",
          scope: { kind: "workspace" },
          request: { assetId },
        });
      } finally {
        setUploadProgress(null);
      }
    },
    [finish, id, requestUpload, start],
  );
  const actions: BoardActions = useMemo(
    () => ({
      upload,
      startPlans: async (planIds: string[]) => {
        const outcomes = await startPlans({
          boardId: id,
          planIds: planIds as Id<"entities">[],
        });
        const blocked = outcomes.filter((o) => o.blockers.length);
        if (blocked.length)
          throw new Error(blocked.flatMap((o) => o.blockers).join(" "));
      },
      start: async (
        kind: TaskKind,
        targetId?: string,
        scope?: Scope,
        request?: unknown,
      ) => {
        await start({
          boardId: id,
          kind,
          targetId: targetId as Id<"entities"> | undefined,
          scope: scope ?? { kind: "workspace" },
          request,
        });
      },
      preview: async (entity: Entity, data: EntityData) =>
        await preview({
          boardId: id,
          entityId: entity._id as Id<"entities">,
          expectedRevision: entity.revision,
          data,
        }),
      move: async (moves: Move[], manual: boolean) => {
        await move({
          boardId: id,
          moves: moves.map((m) => ({ ...m, nodeId: m.nodeId as Id<"nodes"> })),
          manual,
        });
      },
      choose: async (planId, sceneId, locationId, locked, expectedRevision) => {
        await choose({
          boardId: id,
          planId: planId as Id<"entities">,
          sceneId: sceneId as Id<"entities">,
          locationId: locationId as Id<"entities">,
          locked,
          expectedRevision,
        });
      },
      note: async (text, x, y) => {
        await note({ boardId: id, text, x, y });
      },
      cancel: async (runId) => {
        await cancel({ runId: runId as Id<"runs"> });
      },
      retry: async (runId) => {
        await retry({ runId: runId as Id<"runs"> });
      },
      signal: (value) => {
        if (Date.now() - lastSignal.current < 200) return;
        lastSignal.current = Date.now();
        void signal({
          boardId: id,
          sessionId: session.current,
          ...value,
        }).catch(() => {});
      },
      change: async (action, changeId) => {
        const fn = { commitInputs: commit, regenerate, apply, undo, discard }[
          action
        ];
        await fn({ changeId: changeId as Id<"changes"> });
      },
    }),
    [
      upload,
      start,
      id,
      preview,
      move,
      choose,
      startPlans,
      note,
      cancel,
      retry,
      signal,
      commit,
      regenerate,
      apply,
      undo,
      discard,
    ],
  );
  if (!snapshot)
    return (
      <LoadingState
        title="Opening production board…"
        detail="Loading saved cards, decisions, and collaborators."
        canvas
      />
    );
  return (
    <BoardView
      snapshot={snapshot}
      actions={actions}
      changes={changes ?? []}
      messages={messages ?? []}
      people={people ?? []}
      initialView={initialView}
      uploadProgress={uploadProgress}
      connected={connection.isWebSocketConnected}
      sharePanel={<SharePanel boardId={id} />}
    />
  );
}
