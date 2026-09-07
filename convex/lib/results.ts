import { z } from "zod";
import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { entitySchema, type EntityData } from "../../src/domain/model";
import { boardPlacements, connect, putEntity, updateEntity } from "./entities";
export const resultSchema = z.object({
  script: entitySchema.optional(),
  scenes: z.array(entitySchema).default([]),
  locations: z.array(entitySchema).default([]),
  questions: z
    .array(
      z.object({
        ownerId: z.string().optional(),
        sceneNumber: z.number().optional(),
        data: entitySchema,
      }),
    )
    .default([]),
  schedule: entitySchema.optional(),
  packet: entitySchema.optional(),
  message: z.string().default(""),
  proposals: z
    .array(
      z.object({
        targetId: z.string(),
        data: entitySchema,
        summary: z.string(),
      }),
    )
    .default([]),
  lockConflicts: z.array(z.string()).default([]),
});
export type AgentResult = z.infer<typeof resultSchema>;
export function locationKey(data: Extract<EntityData, { kind: "location" }>) {
  return `location:${data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:${new URL(data.sources[0].url).hostname}`;
}
export async function publishResult(
  ctx: MutationCtx,
  run: Doc<"runs">,
  result: AgentResult,
) {
  const actor = `agent:${run._id}`;
  const boardId = run.boardId;
  const placements = await boardPlacements(ctx, boardId);
  let scriptId: Id<"entities"> | undefined;
  if (result.script) {
    if (run.kind !== "ingest" || result.script.kind !== "script")
      throw new ConvexError("Invalid script result.");
    scriptId = await putEntity(ctx, {
      placements,
      boardId,
      data: result.script,
      scope: { kind: "workspace" },
      logicalKey: "script",
      actor,
      x: 100,
      y: 100,
    });
  }
  if (!scriptId)
    scriptId = (
      await ctx.db
        .query("entities")
        .withIndex("by_board_key", (q) =>
          q.eq("boardId", boardId).eq("logicalKey", "script"),
        )
        .unique()
    )?._id;
  const sceneIds = new Map<number, Id<"entities">>();
  const sceneColumns =
    result.scenes.length > 12
      ? Math.ceil(Math.sqrt(result.scenes.length))
      : Math.max(1, result.scenes.length);
  if (result.scenes.length && run.kind !== "scenes")
    throw new ConvexError("Unexpected scene generation.");
  for (const [index, data] of result.scenes.entries()) {
    if (data.kind !== "scene" || !scriptId)
      throw new ConvexError("Invalid scene result.");
    const id = await putEntity(ctx, {
      placements,
      boardId,
      data,
      scope: { kind: "workspace" },
      ownerId: scriptId,
      logicalKey: `scene:${data.number}`,
      actor,
      x: (index % sceneColumns) * 780,
      y: 650 + Math.floor(index / sceneColumns) * 900,
    });
    await ctx.db.patch(id, { scope: { kind: "scene", sceneId: id } });
    sceneIds.set(data.number, id);
    await connect(ctx, boardId, scriptId, id, "scene");
  }
  if (result.scenes.length) {
    const allScenes = await ctx.db
      .query("entities")
      .withIndex("by_board_kind", (q) =>
        q.eq("boardId", boardId).eq("kind", "scene"),
      )
      .collect();
    for (const [i, p] of [
      {
        name: "Budget plan",
        budgetMode: "fixed",
        budgetMinor: null,
        priority: "cost",
      },
      {
        name: "Creative plan",
        budgetMode: "uncapped",
        budgetMinor: null,
        priority: "creative",
      },
    ].entries()) {
      const data = entitySchema.parse({ kind: "plan", ...p });
      const id = await putEntity(ctx, {
        placements,
        boardId,
        data,
        scope: { kind: "workspace" },
        logicalKey: `plan:${i}`,
        actor,
        x: i * 780,
        y:
          result.scenes.length > 12
            ? 850 + Math.ceil(result.scenes.length / sceneColumns) * 900
            : 1750,
      });
      await ctx.db.patch(id, { scope: { kind: "plan", planId: id } });
      for (const scene of allScenes)
        await connect(ctx, boardId, scene._id, id, "plan", true);
    }
  }
  for (const q of result.questions) {
    if (q.data.kind !== "question")
      throw new ConvexError("Invalid clarification result.");
    const ownerId = q.sceneNumber
      ? sceneIds.get(q.sceneNumber)
      : q.ownerId
        ? ctx.db.normalizeId("entities", q.ownerId)
        : run.targetId || scriptId;
    const owner = ownerId ? await ctx.db.get(ownerId) : null;
    if (!owner || owner.boardId !== boardId)
      throw new ConvexError("Question owner is invalid.");
    if (run.scope.kind === "scene" && owner._id !== run.targetId)
      throw new ConvexError("Question exceeds this scene's scope.");
    const key = `${ownerId}:question:${q.data.key}`;
    const old = await ctx.db
      .query("entities")
      .withIndex("by_board_key", (i) =>
        i.eq("boardId", boardId).eq("logicalKey", key),
      )
      .unique();
    if (old) continue;
    const node = await ctx.db
      .query("nodes")
      .withIndex("by_entity", (i) => i.eq("entityId", owner._id))
      .unique();
    const questions = await ctx.db
      .query("entities")
      .withIndex("by_board_kind", (i) =>
        i.eq("boardId", boardId).eq("kind", "question"),
      )
      .collect();
    const siblingCount = questions.filter(
      (question) => question.ownerId === owner._id,
    ).length;
    const id = await putEntity(ctx, {
      placements,
      boardId,
      data: q.data,
      scope: owner.scope,
      ownerId: owner._id,
      logicalKey: key,
      actor,
      x: (node?.x ?? 0) + 400 * (siblingCount + 1),
      y: node?.y ?? 0,
    });
    await connect(ctx, boardId, id, owner._id, "question");
    await updateEntity(
      ctx,
      owner,
      entitySchema.parse(owner.data),
      actor,
      run.changeId,
      owner.stale,
    );
  }
  if (
    result.locations.length &&
    !["research", "requirements"].includes(run.kind)
  )
    throw new ConvexError("Unexpected research result.");
  const refreshTarget =
    run.kind === "requirements" && run.targetId
      ? await ctx.db.get(run.targetId)
      : null;
  if (
    run.kind === "requirements" &&
    result.locations.length &&
    (result.locations.length !== 1 ||
      refreshTarget?.boardId !== boardId ||
      refreshTarget.kind !== "location")
  )
    throw new ConvexError("Requirements must refresh the selected location.");
  for (const [index, raw] of result.locations.entries()) {
    if (raw.kind !== "location") throw new ConvexError("Invalid candidate.");
    const data = refreshTarget
      ? {
          ...raw,
          ...refreshTarget.data,
          costs: raw.costs,
          requirements: raw.requirements,
          sources: raw.sources,
          authority: raw.authority,
        }
      : { ...raw };
    if (run.scope.sceneId) data.sceneIds = [run.scope.sceneId];
    const key = refreshTarget?.logicalKey ?? locationKey(data);
    const previous = await ctx.db
      .query("entities")
      .withIndex("by_board_key", (q) =>
        q.eq("boardId", boardId).eq("logicalKey", key),
      )
      .unique();
    if (previous)
      data.sceneIds = [
        ...new Set([...(previous.data.sceneIds as string[]), ...data.sceneIds]),
      ];
    const ownerId = ctx.db.normalizeId("entities", data.sceneIds[0]);
    const owner = ownerId ? await ctx.db.get(ownerId) : null;
    if (!owner || owner.boardId !== boardId || owner.kind !== "scene")
      throw new ConvexError("Candidate needs a scene on this board.");
    const ownerNode = await ctx.db
      .query("nodes")
      .withIndex("by_entity", (q) => q.eq("entityId", owner._id))
      .unique();
    const id = await putEntity(ctx, {
      placements,
      boardId,
      data,
      scope: owner.scope,
      ownerId: owner._id,
      logicalKey: key,
      actor,
      x: (ownerNode?.x ?? 0) + index * 370,
      y: (ownerNode?.y ?? 0) + 520,
    });
    for (const scene of data.sceneIds) {
      const sid = ctx.db.normalizeId("entities", scene);
      const entity = sid ? await ctx.db.get(sid) : null;
      if (entity?.boardId === boardId)
        await connect(ctx, boardId, entity._id, id, "candidate");
    }
    const costId = await putEntity(ctx, {
      placements,
      boardId,
      data: { kind: "cost", locationId: id, items: data.costs },
      scope: owner.scope,
      ownerId: id,
      logicalKey: `${id}:cost`,
      actor,
      x: (ownerNode?.x ?? 0) + index * 370,
      y: (ownerNode?.y ?? 0) + 920,
    });
    await connect(ctx, boardId, id, costId, "cost");
    for (const [i, req] of data.requirements.entries()) {
      const reqId = await putEntity(ctx, {
        placements,
        boardId,
        data: { ...req, kind: "requirement", locationId: id },
        scope: owner.scope,
        ownerId: id,
        logicalKey: `${id}:requirement:${i}`,
        actor,
        x: (ownerNode?.x ?? 0) + index * 370,
        y: (ownerNode?.y ?? 0) + 1240 + i * 220,
      });
      await connect(ctx, boardId, id, reqId, "requirement");
    }
  }
  if (result.schedule) {
    if (
      run.kind !== "schedule" ||
      result.schedule.kind !== "schedule" ||
      result.schedule.planId !== run.targetId
    )
      throw new ConvexError("Invalid schedule result.");
    const id = await putEntity(ctx, {
      placements,
      boardId,
      data: result.schedule,
      scope: run.scope,
      ownerId: run.targetId,
      logicalKey: `${run.targetId}:schedule`,
      actor,
      x: run.scope.planId?.endsWith("0") ? 0 : 780,
      y: 2350,
    });
    await connect(ctx, boardId, run.targetId!, id, "schedule");
  }
  if (result.packet) {
    if (
      run.kind !== "packet" ||
      result.packet.kind !== "packet" ||
      result.packet.planId !== run.targetId
    )
      throw new ConvexError("Invalid packet result.");
    const assetId = ctx.db.normalizeId("assets", result.packet.assetId);
    const asset = assetId ? await ctx.db.get(assetId) : null;
    if (!asset || asset.boardId !== boardId || asset.createdBy !== actor)
      throw new ConvexError("Packet file is invalid.");
    const id = await putEntity(ctx, {
      placements,
      boardId,
      data: result.packet,
      scope: run.scope,
      ownerId: run.targetId,
      logicalKey: `${run.targetId}:packet`,
      actor,
      y: 2800,
    });
    const schedule = await ctx.db
      .query("entities")
      .withIndex("by_board_key", (q) =>
        q.eq("boardId", boardId).eq("logicalKey", `${run.targetId}:schedule`),
      )
      .unique();
    await connect(ctx, boardId, schedule?._id || run.targetId!, id, "packet");
  }
  let lastChangeId: Id<"changes"> | undefined;
  for (const proposal of result.proposals) {
    const id = ctx.db.normalizeId("entities", proposal.targetId);
    const target = id ? await ctx.db.get(id) : null;
    if (
      !target ||
      target.boardId !== boardId ||
      !["scene", "question", "plan", "note"].includes(target.kind) ||
      target.kind !== proposal.data.kind
    )
      throw new ConvexError("Invalid proposed change.");
    if (
      run.scope.kind !== "workspace" &&
      JSON.stringify(run.scope) !== JSON.stringify(target.scope) &&
      target._id !== run.targetId
    )
      throw new ConvexError(
        "Choose a broader scope before changing this record.",
      );
    lastChangeId = await ctx.db.insert("changes", {
      boardId,
      targetId: target._id,
      baseRevision: target.revision,
      proposed: proposal.data,
      before: target.data,
      affectedIds: [],
      readVersions: [{ id: target._id, revision: target.revision }],
      status: "preview",
      createdBy: run.createdBy,
      createdAt: Date.now(),
      summary: proposal.summary,
      runIds: [],
    });
  }
  if (result.message)
    await ctx.db.insert("messages", {
      boardId,
      scope: run.scope,
      role: "assistant",
      text: result.message.slice(0, 30000),
      createdAt: Date.now(),
      runId: run._id,
      changeId: lastChangeId,
    });
  await ctx.db.patch(boardId, { updatedAt: Date.now() });
}
