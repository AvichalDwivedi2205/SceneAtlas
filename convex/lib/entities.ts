import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  entitySchema,
  scopeSchema,
  type EntityData,
  type Scope,
} from "../../src/domain/model";
type Placement = Pick<Doc<"nodes">, "x" | "y" | "width" | "height">;
export async function boardPlacements(
  ctx: MutationCtx,
  boardId: Id<"boards">,
): Promise<Placement[]> {
  return await ctx.db
    .query("nodes")
    .withIndex("by_board", (q) => q.eq("boardId", boardId))
    .collect();
}
export async function validateScope(
  ctx: MutationCtx,
  boardId: Id<"boards">,
  input: Scope,
) {
  const scope = scopeSchema.parse(input);
  for (const [id, kind] of [
    [scope.sceneId, "scene"],
    [scope.planId, "plan"],
  ] as const)
    if (id) {
      const normalized = ctx.db.normalizeId("entities", id);
      const e = normalized ? await ctx.db.get(normalized) : null;
      if (!e || e.boardId !== boardId || e.kind !== kind)
        throw new ConvexError("Invalid scope.");
    }
  return scope;
}
export async function putEntity(
  ctx: MutationCtx,
  args: {
    boardId: Id<"boards">;
    data: EntityData;
    scope: Scope;
    logicalKey: string;
    ownerId?: Id<"entities">;
    actor: string;
    x?: number;
    y?: number;
    placements?: Placement[];
  },
) {
  const data = entitySchema.parse(args.data);
  await validateScope(ctx, args.boardId, args.scope);
  const existing = await ctx.db
    .query("entities")
    .withIndex("by_board_key", (q) =>
      q.eq("boardId", args.boardId).eq("logicalKey", args.logicalKey),
    )
    .unique();
  if (existing) {
    await updateEntity(ctx, existing, data, args.actor);
    return existing._id;
  }
  const now = Date.now();
  const id = await ctx.db.insert("entities", {
    boardId: args.boardId,
    kind: data.kind,
    data,
    scope: args.scope,
    ownerId: args.ownerId,
    logicalKey: args.logicalKey,
    revision: 1,
    stale: false,
    createdAt: now,
    updatedAt: now,
    updatedBy: args.actor,
  });
  await ctx.db.insert("versions", {
    boardId: args.boardId,
    entityId: id,
    revision: 1,
    data,
    stale: false,
    createdAt: now,
    createdBy: args.actor,
  });
  // Reserve space only for a new card. Existing collaborator placements stay put.
  const width = data.kind === "answer" ? 270 : 340;
  const height = 480;
  const occupied =
    args.placements ?? (await boardPlacements(ctx, args.boardId));
  const x = args.x ?? 0;
  let y = args.y ?? 0;
  for (let attempt = 0; attempt <= occupied.length; attempt++) {
    const collisions = occupied.filter(
      (node) =>
        x < node.x + node.width + 60 &&
        x + width + 60 > node.x &&
        y < node.y + Math.max(node.height, height) + 60 &&
        y + height + 60 > node.y,
    );
    if (!collisions.length) break;
    y = Math.max(
      ...collisions.map((node) => node.y + Math.max(node.height, height) + 60),
    );
  }
  await ctx.db.insert("nodes", {
    boardId: args.boardId,
    entityId: id,
    x,
    y,
    width,
    height,
    geometryRevision: 1,
    manual: false,
  });
  occupied.push({ x, y, width, height });
  return id;
}
export async function updateEntity(
  ctx: MutationCtx,
  entity: Doc<"entities">,
  raw: EntityData,
  actor: string,
  changeId?: Id<"changes">,
  stale = false,
) {
  const data = entitySchema.parse(raw);
  if (data.kind !== entity.kind)
    throw new ConvexError("Record type cannot change.");
  const revision = entity.revision + 1;
  const now = Date.now();
  await ctx.db.patch(entity._id, {
    data,
    revision,
    stale,
    updatedAt: now,
    updatedBy: actor,
  });
  await ctx.db.insert("versions", {
    boardId: entity.boardId,
    entityId: entity._id,
    revision,
    data,
    stale,
    createdAt: now,
    createdBy: actor,
    changeId,
  });
  return revision;
}
export async function connect(
  ctx: MutationCtx,
  boardId: Id<"boards">,
  sourceId: Id<"entities">,
  targetId: Id<"entities">,
  relation: string,
  dependent = true,
) {
  if (sourceId === targetId) return;
  const edges = await ctx.db
    .query("edges")
    .withIndex("by_source_target", (q) =>
      q.eq("sourceId", sourceId).eq("targetId", targetId),
    )
    .collect();
  if (
    !edges.some(
      (e) =>
        e.sourceId === sourceId &&
        e.targetId === targetId &&
        e.relation === relation,
    )
  )
    await ctx.db.insert("edges", { boardId, sourceId, targetId, relation });
  if (dependent) {
    const deps = await ctx.db
      .query("dependencies")
      .withIndex("by_source_target", (q) =>
        q.eq("sourceId", sourceId).eq("targetId", targetId),
      )
      .collect();
    if (!deps.some((e) => e.sourceId === sourceId && e.targetId === targetId))
      await ctx.db.insert("dependencies", { boardId, sourceId, targetId });
  }
}
