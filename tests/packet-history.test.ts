import { expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { putEntity, updateEntity } from "../convex/lib/entities";
import { entitySchema } from "../src/domain/model";

const modules = import.meta.glob("../convex/**/*.ts");
const identity = (name: string) => ({
  tokenIdentifier: `https://clerk.test|${name}`,
  subject: name,
  name,
  email: `${name}@example.com`,
  emailVerified: true,
});

async function fixture() {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity(identity("packet-owner"));
  const viewer = t.withIdentity(identity("packet-viewer"));
  const outsider = t.withIdentity(identity("packet-outsider"));
  const ownerId = await owner.mutation(api.boards.initialize);
  const viewerId = await viewer.mutation(api.boards.initialize);
  await outsider.mutation(api.boards.initialize);
  const boardId = await owner.mutation(api.boards.create, {
    name: "Packet versions",
  });
  const otherBoardId = await owner.mutation(api.boards.create, {
    name: "Other files",
  });
  const records = await t.run(async (ctx) => {
    await ctx.db.insert("members", {
      boardId,
      userId: viewerId,
      role: "viewer",
      createdAt: 1,
    });
    const planId = await putEntity(ctx, {
      boardId,
      actor: ownerId,
      logicalKey: "plan:0",
      scope: { kind: "workspace" },
      data: entitySchema.parse({
        kind: "plan",
        name: "Budget",
        priority: "cost",
        budgetMode: "uncapped",
        budgetMinor: null,
      }),
    });
    await ctx.db.patch(planId, { scope: { kind: "plan", planId } });
    const assetIds = [];
    for (let index = 0; index < 3; index++) {
      const storageId = await ctx.storage.store(
        new Blob([`packet ${index}`], { type: "application/pdf" }),
      );
      assetIds.push(
        await ctx.db.insert("assets", {
          boardId: index === 2 ? otherBoardId : boardId,
          storageId,
          filename: `packet-${index}.pdf`,
          mime: "application/pdf",
          size: 8,
          createdBy: ownerId,
          createdAt: index + 1,
        }),
      );
    }
    const first = entitySchema.parse({
      kind: "packet",
      planId,
      assetId: assetIds[0],
      filename: "packet-0.pdf",
      builtAt: 1000,
      unresolved: [],
      sourceVersion: "old-inputs",
      sourcePlanRevision: 1,
      sourceScheduleRevision: 1,
      includedSceneIds: ["scene-1"],
      documentStatus: "draft",
      externalStatus: "not_submitted",
    });
    const packetId = await putEntity(ctx, {
      boardId,
      actor: ownerId,
      logicalKey: `${planId}:packet`,
      scope: { kind: "plan", planId },
      ownerId: planId,
      data: first,
    });
    await updateEntity(
      ctx,
      (await ctx.db.get(packetId))!,
      first,
      ownerId,
      undefined,
      true,
    );
    const latest = entitySchema.parse({
      ...first,
      assetId: assetIds[1],
      filename: "packet-1.pdf",
      builtAt: 2000,
      sourceVersion: "new-inputs",
      sourcePlanRevision: 2,
      sourceScheduleRevision: 2,
      includedSceneIds: ["scene-1", "scene-2"],
    });
    await updateEntity(ctx, (await ctx.db.get(packetId))!, latest, ownerId);
    await updateEntity(
      ctx,
      (await ctx.db.get(packetId))!,
      latest,
      ownerId,
      undefined,
      true,
    );
    for (const [index, data] of [
      { kind: "packet", malformed: true },
      { ...latest, assetId: assetIds[2] },
      { ...latest, planId: "different-plan" },
    ].entries())
      await ctx.db.insert("versions", {
        boardId,
        entityId: packetId,
        revision: index + 5,
        data,
        stale: false,
        createdAt: 3000 + index,
        createdBy: ownerId,
      });
    return { planId, packetId, assetIds, latest };
  });
  return { t, owner, viewer, outsider, ownerId, boardId, ...records };
}

it("shows each saved PDF once with its original scope and rejects malformed or unrelated versions", async () => {
  const f = await fixture();
  const history = await f.viewer.query(api.packets.history, {
    packetId: f.packetId,
    paginationOpts: { numItems: 50, cursor: null },
  });
  expect(history.isDone).toBe(true);
  expect(history.page.map((item) => item.data.assetId)).toEqual([
    f.assetIds[1],
    f.assetIds[0],
  ]);
  expect(history.page[0]).toMatchObject({
    revision: 4,
    data: {
      builtAt: 2000,
      sourcePlanRevision: 2,
      sourceScheduleRevision: 2,
      sourceVersion: "new-inputs",
      includedSceneIds: ["scene-1", "scene-2"],
    },
  });
  expect(history.page[1]).toMatchObject({
    revision: 2,
    data: {
      builtAt: 1000,
      sourcePlanRevision: 1,
      sourceVersion: "old-inputs",
      includedSceneIds: ["scene-1"],
    },
  });
});

it("requires board membership and a packet entity even for read-only document history", async () => {
  const f = await fixture();
  const args = {
    packetId: f.packetId,
    paginationOpts: { numItems: 20, cursor: null },
  };
  await expect(f.t.query(api.packets.history, args)).rejects.toThrow("Sign in");
  await expect(f.outsider.query(api.packets.history, args)).rejects.toThrow(
    "do not have access",
  );
  await expect(
    f.viewer.query(api.packets.history, { ...args, packetId: f.planId }),
  ).rejects.toThrow("Choose a packet");
});

it("bounds each read while allowing older packet versions to be paged", async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    for (let index = 0; index < 55; index++)
      await ctx.db.insert("versions", {
        boardId: f.boardId,
        entityId: f.packetId,
        revision: 100 + index,
        data: f.latest,
        stale: true,
        createdAt: 4000 + index,
        createdBy: f.ownerId,
      });
  });
  const first = await f.viewer.query(api.packets.history, {
    packetId: f.packetId,
    paginationOpts: { numItems: 1000, cursor: null },
  });
  expect(first.isDone).toBe(false);
  expect(first.page).toHaveLength(1);
  const older = await f.viewer.query(api.packets.history, {
    packetId: f.packetId,
    paginationOpts: { numItems: 50, cursor: first.continueCursor },
  });
  expect(older.isDone).toBe(true);
  expect(older.page.map((item) => item.data.assetId)).toContain(f.assetIds[0]);
});
