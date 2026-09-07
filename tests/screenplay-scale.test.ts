import { expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { boardPlacements, connect, putEntity } from "../convex/lib/entities";
import { entitySchema } from "../src/domain/model";

const modules = import.meta.glob("../convex/**/*.ts");

it("publishes a 100-scene graph atomically with unique dependencies and preserved placements", async () => {
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
  const scenes = Array.from({ length: 100 }, (_, i) =>
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
  expect(result.entities.filter((e) => e.kind === "scene")).toHaveLength(100);
  expect(result.entities.filter((e) => e.kind === "plan")).toHaveLength(2);
  expect(result.nodes).toHaveLength(103);
  expect(result.edges).toHaveLength(300);
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
    ).toHaveLength(300);
    const placements = await boardPlacements(ctx, boardId);
    expect(placements).toHaveLength(103);
  });
  expect(
    (await owner.query(api.boards.snapshot, { boardId })).edges,
  ).toHaveLength(300);
});
