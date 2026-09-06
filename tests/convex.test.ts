import { beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { putEntity } from "../convex/lib/entities";
import { entitySchema } from "../src/domain/model";

const modules = import.meta.glob("../convex/**/*.ts");
const setup = () => convexTest(schema, modules);

it("refreshes the selected location even when its leading evidence URL changes", async () => {
  const t = setup();
  const owner = t.withIdentity(identity("owner", "owner@example.com"));
  await owner.mutation(api.boards.initialize);
  const boardId = await owner.mutation(api.boards.create, {
    name: "Requirement refresh",
  });
  const fixture = await t.run(async (ctx) => {
    const sceneId = await putEntity(ctx, {
      boardId,
      actor: "test",
      logicalKey: "scene:1",
      scope: { kind: "workspace" },
      data: entitySchema.parse({
        kind: "scene",
        number: 1,
        heading: "EXT. BEACH - DAY",
        excerpt: "Test beach scene",
        pageStart: 1,
        pageEnd: 1,
        setting: "Beach",
        interiorExterior: "EXT",
        timeOfDay: "DAY",
        needs: [],
      }),
    });
    const scope = { kind: "scene" as const, sceneId };
    await ctx.db.patch(sceneId, { scope });
    const data = entitySchema.parse({
      kind: "location",
      name: "Test state beach",
      address: "California",
      description: "Test location",
      creativeFit: "Beach",
      restrictions: [],
      authority: "State Parks",
      sources: [
        {
          url: "https://example.com/beach",
          title: "Original discovery",
          excerpt: "Beach",
          provider: "parallel",
          retrievedAt: 1,
        },
      ],
      costs: [],
      requirements: [],
      sceneIds: [sceneId],
    });
    const locationId = await putEntity(ctx, {
      boardId,
      actor: "test",
      logicalKey: "location:test-state-beach:example.com",
      scope,
      ownerId: sceneId,
      data,
    });
    return { scope, locationId, data };
  });
  const runId = await owner.mutation(api.runs.start, {
    boardId,
    kind: "requirements",
    targetId: fixture.locationId,
    scope: fixture.scope,
  });
  await t.mutation(internal.runs.claim, { runId, attempt: 1 });
  await t.mutation(internal.runs.event, {
    runId,
    attempt: 1,
    sequence: 1,
    status: "complete",
    activity: "Complete",
    result: {
      locations: [
        {
          ...fixture.data,
          sources: [
            {
              url: "https://film.ca.gov/state-permits/",
              title: "Current official guidance",
              excerpt: "Official source",
              provider: "parallel",
              retrievedAt: 2,
            },
          ],
        },
      ],
    },
  });
  const { entities } = await owner.query(api.boards.snapshot, { boardId });
  expect(entities.filter((e) => e.kind === "location")).toHaveLength(1);
  expect(entities.find((e) => e._id === fixture.locationId)!.revision).toBe(2);
});

it("places new cards without overlapping or moving an existing manual card", async () => {
  const t = setup();
  const owner = t.withIdentity(identity("owner", "owner@example.com"));
  await owner.mutation(api.boards.initialize);
  const boardId = await owner.mutation(api.boards.create, {
    name: "Initial placement",
  });
  await t.run(async (ctx) => {
    for (let index = 0; index < 3; index++) {
      const entityId = await putEntity(ctx, {
        boardId,
        data: { kind: "note", text: `New card ${index}` },
        scope: { kind: "workspace" },
        logicalKey: `placement:${index}`,
        actor: "test",
        x: 100,
        y: 100,
      });
      if (index === 0) {
        const node = await ctx.db
          .query("nodes")
          .withIndex("by_entity", (q) => q.eq("entityId", entityId))
          .unique();
        await ctx.db.patch(node!._id, { manual: true });
      }
    }
  });
  const { nodes } = await owner.query(api.boards.snapshot, { boardId });
  expect(nodes[0]).toMatchObject({
    x: 100,
    y: 100,
    manual: true,
    geometryRevision: 1,
  });
  for (const [index, node] of nodes.entries()) {
    for (const other of nodes.slice(index + 1)) {
      const overlaps =
        node.x < other.x + other.width &&
        node.x + node.width > other.x &&
        node.y < other.y + other.height &&
        node.y + node.height > other.y;
      expect(overlaps).toBe(false);
    }
  }
});

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

describe("question checkpoint recovery", () => {
  it.each([
    { staged: false, conflict: false },
    { staged: true, conflict: false },
    { staged: true, conflict: true },
  ])(
    "waits for every blocking answer and resumes only the related scene (staged=$staged, conflict=$conflict)",
    async ({ staged, conflict }) => {
      const t = setup();
      const owner = t.withIdentity(identity("owner", "owner@example.com"));
      const userId = await owner.mutation(api.boards.initialize);
      const boardId = await owner.mutation(api.boards.create, {
        name: "Paused research",
      });
      const fixture = await t.run(async (ctx) => {
        const now = Date.now();
        const base = {
          boardId,
          revision: 1,
          stale: false,
          createdAt: now,
          updatedAt: now,
          updatedBy: userId,
        };
        const sceneIds = [];
        for (const number of [1, 2]) {
          const id = await ctx.db.insert("entities", {
            ...base,
            kind: "scene",
            logicalKey: `scene:${number}`,
            scope: { kind: "workspace" },
            data: {
              kind: "scene",
              number,
              heading: "EXT. BEACH - DAY",
              excerpt: "Mara walks on sand.",
              pageStart: 1,
              pageEnd: 1,
              setting: "Beach",
              interiorExterior: "EXT",
              timeOfDay: "DAY",
              needs: [],
              durationMinutes: null,
              durationBasis: "unknown",
              candidateCount: 3,
              ranking: "creative",
              windows: [],
            },
          });
          await ctx.db.patch(id, { scope: { kind: "scene", sceneId: id } });
          sceneIds.push(id);
        }
        const questionIds = [];
        for (const key of ["area", "access"]) {
          questionIds.push(
            await ctx.db.insert("entities", {
              ...base,
              kind: "question",
              logicalKey: key,
              ownerId: sceneIds[0],
              scope: { kind: "scene", sceneId: sceneIds[0] },
              data: {
                kind: "question",
                key,
                prompt: key,
                reason: "Required for research",
                suggestions: [],
                blocks: ["research"],
                answer: null,
                resolution: "open",
                rule: null,
              },
            }),
          );
        }
        const origin = await ctx.db.get(sceneIds[0]);
        const revisionId = staged
          ? await ctx.db.insert("changes", {
              boardId,
              targetId: sceneIds[0],
              baseRevision: 1,
              before: origin!.data,
              proposed: origin!.data,
              affectedIds: [],
              readVersions: [{ id: sceneIds[0], revision: 1 }],
              status: "regenerating",
              createdBy: userId,
              createdAt: now,
              summary: "Test staged research",
              runIds: [],
            })
          : undefined;
        const runs = [];
        for (const sceneId of sceneIds)
          runs.push(
            await ctx.db.insert("runs", {
              boardId,
              kind: "research",
              targetId: sceneId,
              scope: { kind: "scene", sceneId },
              status: "waiting",
              activity: "Needs your answer",
              createdBy: userId,
              createdAt: now,
              updatedAt: now,
              inputVersions: [],
              workKey: `paused:${sceneId}`,
              attempt: 1,
              eventSequence: 1,
              changeId: sceneId === sceneIds[0] ? revisionId : undefined,
            }),
          );
        if (revisionId) await ctx.db.patch(revisionId, { runIds: [runs[0]] });
        return { questionIds, runs, sceneIds, revisionId };
      });
      if (conflict)
        await t.run(async (ctx) => {
          const scene = await ctx.db.get(fixture.sceneIds[0]);
          await ctx.db.patch(scene!._id, {
            revision: scene!.revision + 1,
            data: {
              ...scene!.data,
              needs: ["Collaborator changed this input"],
            },
          });
        });
      for (const [index, entityId] of fixture.questionIds.entries()) {
        const question = await t.run((ctx) => ctx.db.get(entityId));
        const changeId = await owner.mutation(api.changes.preview, {
          boardId,
          entityId,
          expectedRevision: question!.revision,
          data: {
            ...question!.data,
            answer: "Confirmed test input",
            resolution: "answered",
          },
        });
        await owner.mutation(api.changes.commitInputs, { changeId });
        const snapshot = await owner.query(api.boards.snapshot, { boardId });
        expect(
          snapshot.runs.find((r) => r._id === fixture.runs[1])?.status,
        ).toBe("waiting");
        expect(
          snapshot.runs.find((r) => r._id === fixture.runs[0])?.status,
        ).toBe(index === 0 ? "waiting" : "superseded");
        expect(snapshot.runs.filter((r) => r.status === "queued")).toHaveLength(
          index,
        );
      }
      if (fixture.revisionId) {
        const snapshot = await owner.query(api.boards.snapshot, { boardId });
        const resumed = snapshot.runs.find((r) => r.status === "queued")!;
        const revision = await t.run((ctx) => ctx.db.get(fixture.revisionId!));
        expect(revision!.runIds).toEqual([resumed._id]);
        await t.mutation(internal.runs.claim, {
          runId: resumed._id,
          attempt: 1,
        });
        await t.mutation(internal.runs.event, {
          runId: resumed._id,
          attempt: 1,
          sequence: 1,
          status: "complete",
          activity: "Revised results ready",
          result: { locations: [], questions: [] },
        });
        await t.mutation(internal.changes.advance, {
          changeId: fixture.revisionId,
        });
        if (conflict) {
          await expect(
            owner.mutation(api.changes.apply, { changeId: fixture.revisionId }),
          ).rejects.toThrow(/changed|updated|revision/i);
          return;
        }
        await owner.mutation(api.changes.apply, {
          changeId: fixture.revisionId,
        });
        expect(
          (await t.run((ctx) => ctx.db.get(fixture.revisionId!)))!.status,
        ).toBe("applied");
      }
    },
  );
});
