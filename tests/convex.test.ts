import { beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.ts");
const setup = () => convexTest(schema, modules);

function identity(id: string, email: string) {
  return {
    tokenIdentifier: `https://clerk.test|${id}`,
    subject: id,
    name: id,
    email,
    emailVerified: true,
  };
}

describe("board authorization and optimistic concurrency", () => {
  let t: ReturnType<typeof setup>;

  beforeEach(() => {
    t = setup();
  });

  it("keeps viewers read-only and allows an editor to collaborate", async () => {
    const owner = t.withIdentity(identity("owner", "owner@example.com"));
    const editor = t.withIdentity(identity("editor", "editor@example.com"));
    const viewer = t.withIdentity(identity("viewer", "viewer@example.com"));
    const ownerId = await owner.mutation(api.boards.initialize);
    const editorId = await editor.mutation(api.boards.initialize);
    const viewerId = await viewer.mutation(api.boards.initialize);
    const boardId = await owner.mutation(api.boards.create, {
      name: "Shared shoot",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("members", {
        boardId,
        userId: editorId,
        role: "editor",
        createdAt: Date.now(),
      });
      await ctx.db.insert("members", {
        boardId,
        userId: viewerId,
        role: "viewer",
        createdAt: Date.now(),
      });
    });

    await editor.mutation(api.boards.addNote, {
      boardId,
      text: "Scout gate access",
      x: 20,
      y: 30,
    });
    const snapshot = await viewer.query(api.boards.snapshot, { boardId });
    expect(
      snapshot.entities.some(
        (entity) => entity.data.text === "Scout gate access",
      ),
    ).toBe(true);
    await expect(
      viewer.mutation(api.boards.addNote, {
        boardId,
        text: "should fail",
        x: 0,
        y: 0,
      }),
    ).rejects.toThrow("You do not have access");
    expect(snapshot.board.ownerId).toBe(ownerId);
  });

  it("rejects stale geometry writes without overwriting collaborator movement", async () => {
    const owner = t.withIdentity(identity("owner", "owner@example.com"));
    const editor = t.withIdentity(identity("editor", "editor@example.com"));
    await owner.mutation(api.boards.initialize);
    const editorId = await editor.mutation(api.boards.initialize);
    const boardId = await owner.mutation(api.boards.create, {
      name: "Concurrent board",
    });
    await t.run((ctx) =>
      ctx.db.insert("members", {
        boardId,
        userId: editorId,
        role: "editor",
        createdAt: Date.now(),
      }),
    );
    await owner.mutation(api.boards.addNote, {
      boardId,
      text: "Move me",
      x: 0,
      y: 0,
    });
    const initial = await owner.query(api.boards.snapshot, { boardId });
    const node = initial.nodes[0];

    await editor.mutation(api.boards.move, {
      boardId,
      moves: [
        {
          nodeId: node._id,
          x: 400,
          y: 250,
          expectedRevision: node.geometryRevision,
        },
      ],
      manual: true,
    });
    await expect(
      owner.mutation(api.boards.move, {
        boardId,
        moves: [
          {
            nodeId: node._id,
            x: 10,
            y: 10,
            expectedRevision: node.geometryRevision,
          },
        ],
        manual: true,
      }),
    ).rejects.toThrow("Someone changed this record");
    const latest = await owner.query(api.boards.snapshot, { boardId });
    expect(latest.nodes[0]).toMatchObject({
      x: 400,
      y: 250,
      geometryRevision: 2,
    });
  });

  it("preserves the second editor draft when record revision changed", async () => {
    const owner = t.withIdentity(identity("owner", "owner@example.com"));
    const editor = t.withIdentity(identity("editor", "editor@example.com"));
    await owner.mutation(api.boards.initialize);
    const editorId = await editor.mutation(api.boards.initialize);
    const boardId = await owner.mutation(api.boards.create, {
      name: "Revision board",
    });
    await t.run((ctx) =>
      ctx.db.insert("members", {
        boardId,
        userId: editorId,
        role: "editor",
        createdAt: Date.now(),
      }),
    );
    const entityId = await owner.mutation(api.boards.addNote, {
      boardId,
      text: "Original",
      x: 0,
      y: 0,
    });
    const first = await owner.mutation(api.changes.preview, {
      boardId,
      entityId,
      expectedRevision: 1,
      data: { kind: "note", text: "Owner edit" },
    });
    const second = await editor.mutation(api.changes.preview, {
      boardId,
      entityId,
      expectedRevision: 1,
      data: { kind: "note", text: "Editor draft" },
    });

    await owner.mutation(api.changes.commitInputs, { changeId: first });
    await expect(
      editor.mutation(api.changes.commitInputs, { changeId: second }),
    ).rejects.toThrow("draft is preserved");
    const proposals = await editor.query(api.changes.list, { boardId });
    expect(proposals.find((change) => change._id === second)?.proposed).toEqual(
      { kind: "note", text: "Editor draft" },
    );
  });

  it("undo removes a newly created answer chip and restores the question", async () => {
    const owner = t.withIdentity(identity("owner", "owner@example.com"));
    const ownerId = await owner.mutation(api.boards.initialize);
    const boardId = await owner.mutation(api.boards.create, {
      name: "Undo board",
    });
    const { questionId } = await t.run(async (ctx) => {
      const now = Date.now();
      const scriptId = await ctx.db.insert("entities", {
        boardId,
        kind: "script",
        data: {
          kind: "script",
          filename: "short.txt",
          pageCount: 1,
          summary: "Short",
          sceneCount: 0,
        },
        scope: { kind: "workspace" },
        logicalKey: "script",
        revision: 1,
        stale: false,
        createdAt: now,
        updatedAt: now,
        updatedBy: ownerId,
      });
      const questionId = await ctx.db.insert("entities", {
        boardId,
        kind: "question",
        data: {
          kind: "question",
          key: "area",
          prompt: "Where can the team travel?",
          reason: "Narrows research",
          suggestions: ["Los Angeles"],
          blocks: ["research"],
          answer: null,
          resolution: "open",
          rule: null,
        },
        scope: { kind: "workspace" },
        ownerId: scriptId,
        logicalKey: `${scriptId}:question:area`,
        revision: 1,
        stale: false,
        createdAt: now,
        updatedAt: now,
        updatedBy: ownerId,
      });
      await ctx.db.insert("nodes", {
        boardId,
        entityId: questionId,
        x: 0,
        y: 0,
        width: 340,
        height: 240,
        geometryRevision: 1,
        manual: false,
      });
      await ctx.db.insert("dependencies", {
        boardId,
        sourceId: questionId,
        targetId: scriptId,
      });
      return { questionId };
    });
    const changeId = await owner.mutation(api.changes.preview, {
      boardId,
      entityId: questionId,
      expectedRevision: 1,
      data: {
        kind: "question",
        key: "area",
        prompt: "Where can the team travel?",
        reason: "Narrows research",
        suggestions: ["Los Angeles"],
        blocks: ["research"],
        answer: "Los Angeles",
        resolution: "answered",
        rule: null,
      },
    });
    await owner.mutation(api.changes.commitInputs, { changeId });
    expect(
      (await owner.query(api.boards.snapshot, { boardId })).entities.some(
        (entity) => entity.kind === "answer",
      ),
    ).toBe(true);
    await owner.mutation(api.changes.undo, { changeId });
    const restored = await owner.query(api.boards.snapshot, { boardId });
    expect(restored.entities.some((entity) => entity.kind === "answer")).toBe(
      false,
    );
    expect(
      restored.entities.find((entity) => entity._id === questionId)?.data
        .answer,
    ).toBeNull();
  });

  it("fails a dispatched run that no worker claimed", async () => {
    const owner = t.withIdentity(identity("owner", "owner@example.com"));
    const ownerId = await owner.mutation(api.boards.initialize);
    const boardId = await owner.mutation(api.boards.create, {
      name: "Worker recovery board",
    });
    const runId = await t.run(async (ctx) => {
      const then = Date.now() - 6 * 60_000;
      const runId = await ctx.db.insert("runs", {
        boardId,
        kind: "chat",
        scope: { kind: "workspace" },
        status: "queued",
        activity: "Queued",
        createdBy: ownerId,
        createdAt: then,
        updatedAt: then,
        inputVersions: [],
        workKey: "worker-recovery",
        attempt: 1,
        eventSequence: 0,
      });
      await ctx.db.insert("outbox", {
        runId,
        attempt: 1,
        status: "sent",
        tries: 1,
        updatedAt: then,
      });
      return runId;
    });

    await t.mutation(internal.runs.reap, {});
    const run = await t.run((ctx) => ctx.db.get(runId));
    expect(run?.status).toBe("failed");
    expect(run?.activity).toBe("Agent worker did not start");
  });
});
