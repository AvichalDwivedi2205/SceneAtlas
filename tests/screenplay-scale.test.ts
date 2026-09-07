import { expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { boardPlacements, connect, putEntity } from "../convex/lib/entities";
import { entitySchema } from "../src/domain/model";

const modules = import.meta.glob("../convex/**/*.ts");

it("isolates saved batches, resumes retries, and rejects changed or cancelled inputs", async () => {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity({
    subject: "batch-owner",
    tokenIdentifier: "https://clerk.test|batch-owner",
    name: "Batch owner",
  });
  await owner.mutation(api.boards.initialize);
  const fixtures: {
    boardId: Id<"boards">;
    scriptId: Id<"entities">;
    runId: Id<"runs">;
  }[] = [];
  for (let i = 0; i < 2; i++) {
    const boardId = await owner.mutation(api.boards.create, {
      name: `Batch board ${i}`,
    });
    const scriptId = await t.run(async (ctx) =>
      putEntity(ctx, {
        boardId,
        actor: "fixture",
        logicalKey: "script",
        scope: { kind: "workspace" },
        data: entitySchema.parse({
          kind: "script",
          filename: "feature.pdf",
          pageCount: 100,
          sceneCount: 100,
          summary: "Fixture",
        }),
      }),
    );
    const runId = await owner.mutation(api.runs.start, {
      boardId,
      kind: "scenes",
      targetId: scriptId,
      scope: { kind: "workspace" },
    });
    await t.mutation(internal.runs.claim, { runId, attempt: 1 });
    fixtures.push({ boardId, scriptId, runId });
  }
  const key = "a".repeat(64);
  const result = {
    segments: [
      {
        number: 1,
        part: 1,
        setting: "Room",
        interiorExterior: "INT" as const,
        timeOfDay: "DAY",
        needs: ["Maps"],
      },
    ],
  };
  const ref = { runId: fixtures[0].runId, attempt: 1, key };
  await t.mutation(internal.screenplay.saveBatch, { ...ref, result });
  await t.mutation(internal.screenplay.saveBatch, { ...ref, result });
  expect(await t.query(internal.screenplay.batch, ref)).toEqual(result);
  expect(
    await t.query(internal.screenplay.batch, {
      ...ref,
      runId: fixtures[1].runId,
    }),
  ).toBeNull();
  await owner.mutation(api.runs.cancel, { runId: fixtures[0].runId });
  await expect(t.query(internal.screenplay.batch, ref)).rejects.toThrow(
    "not active",
  );
  const retry = await owner.mutation(api.runs.retry, {
    runId: fixtures[0].runId,
  });
  await t.mutation(internal.runs.claim, { runId: retry, attempt: 1 });
  expect(
    await t.query(internal.screenplay.batch, { ...ref, runId: retry }),
  ).toEqual(result);
  await t.run(async (ctx) => {
    expect(await ctx.db.query("sceneBatches").collect()).toHaveLength(1);
    await ctx.db.patch(fixtures[0].scriptId, { revision: 2 });
  });
  await expect(
    t.mutation(internal.screenplay.saveBatch, { ...ref, runId: retry, result }),
  ).rejects.toThrow("inputs changed");
});

it.each([100, 202])(
  "publishes %i scenes atomically with unique dependencies and preserved placements",
  async (count) => {
    const t = convexTest(schema, modules);
    const owner = t.withIdentity({
      subject: "scale-owner",
      tokenIdentifier: "https://clerk.test|scale-owner",
      name: "Scale owner",
    });
    await owner.mutation(api.boards.initialize);
    const boardId = await owner.mutation(api.boards.create, {
      name: "100-scene acceptance",
    });
    const scriptId = await t.run(async (ctx) =>
      putEntity(ctx, {
        boardId,
        actor: "fixture",
        logicalKey: "script",
        scope: { kind: "workspace" },
        data: entitySchema.parse({
          kind: "script",
          filename: "feature.pdf",
          pageCount: 100,
          sceneCount: 100,
          summary: "Scale fixture",
        }),
        x: 100,
        y: 100,
      }),
    );
    const before = await owner.query(api.boards.snapshot, { boardId });
    const runId = await owner.mutation(api.runs.start, {
      boardId,
      kind: "scenes",
      targetId: scriptId,
      scope: { kind: "workspace" },
    });
    await t.mutation(internal.runs.claim, { runId, attempt: 1 });
    const scenes = Array.from({ length: count }, (_, i) =>
      entitySchema.parse({
        kind: "scene",
        number: i + 1,
        heading: `INT. ARCHIVE ${i + 1} - DAY`,
        excerpt: `Mara opens evidence folder ${i + 1}.`,
        pageStart: i + 1,
        pageEnd: i + 1,
        setting: `Archive ${i + 1}`,
        interiorExterior: "INT",
        timeOfDay: "DAY",
        needs: [],
      }),
    );
    await t.mutation(internal.runs.event, {
      runId,
      attempt: 1,
      sequence: 1,
      activity: "Complete",
      status: "complete",
      result: { scenes },
    });
    const result = await owner.query(api.boards.snapshot, { boardId });
    expect(result.runs[0].status).toBe("complete");
    expect(result.entities.filter((e) => e.kind === "scene")).toHaveLength(
      count,
    );
    expect(result.entities.filter((e) => e.kind === "plan")).toHaveLength(2);
    expect(result.nodes).toHaveLength(count + 3);
    expect(result.edges).toHaveLength(count * 3);
    expect(result.nodes.find((n) => n.entityId === scriptId)).toEqual(
      before.nodes[0],
    );
    await t.run(async (ctx) => {
      const scene = result.entities.find((e) => e.kind === "scene")!;
      await connect(ctx, boardId, scriptId, scene._id, "scene");
      expect(
        await ctx.db
          .query("dependencies")
          .withIndex("by_board", (q) => q.eq("boardId", boardId))
          .collect(),
      ).toHaveLength(count * 3);
      const placements = await boardPlacements(ctx, boardId);
      expect(placements).toHaveLength(count + 3);
    });
    expect(
      (await owner.query(api.boards.snapshot, { boardId })).edges,
    ).toHaveLength(count * 3);
  },
);
