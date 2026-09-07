import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";

async function activeBreakdown(
  ctx: QueryCtx,
  runId: Id<"runs">,
  attempt: number,
) {
  const run = await ctx.db.get(runId);
  if (
    !run ||
    run.kind !== "scenes" ||
    run.status !== "running" ||
    run.attempt !== attempt
  )
    throw new ConvexError("Screenplay breakdown is not active.");
  const board = await ctx.db.get(run.boardId);
  const member = await ctx.db
    .query("members")
    .withIndex("by_board_user", (q) =>
      q.eq("boardId", run.boardId).eq("userId", run.createdBy),
    )
    .unique();
  if (!board || board.archived || !member || member.role === "viewer")
    throw new ConvexError("Screenplay access revoked.");
  for (const input of run.inputVersions) {
    const entity = await ctx.db.get(input.id);
    if (!entity || entity.revision !== input.revision)
      throw new ConvexError("Screenplay inputs changed.");
  }
  return run;
}
const reference = { runId: v.id("runs"), attempt: v.number(), key: v.string() };
const segment = v.object({
  number: v.number(),
  part: v.number(),
  setting: v.string(),
  timeOfDay: v.string(),
  interiorExterior: v.union(
    v.literal("INT"),
    v.literal("EXT"),
    v.literal("INT/EXT"),
    v.literal("UNKNOWN"),
  ),
  needs: v.array(v.string()),
});

export const batch = internalQuery({
  args: reference,
  handler: async (ctx, args) => {
    const run = await activeBreakdown(ctx, args.runId, args.attempt);
    const saved = await ctx.db
      .query("sceneBatches")
      .withIndex("by_board_key", (q) =>
        q.eq("boardId", run.boardId).eq("key", args.key),
      )
      .unique();
    return saved?.result ?? null;
  },
});

export const saveBatch = internalMutation({
  args: { ...reference, result: v.object({ segments: v.array(segment) }) },
  handler: async (ctx, args) => {
    const run = await activeBreakdown(ctx, args.runId, args.attempt);
    if (
      !/^[a-f0-9]{64}$/.test(args.key) ||
      !args.result.segments.length ||
      args.result.segments.length > 6 ||
      JSON.stringify(args.result).length > 64000
    )
      throw new ConvexError("Invalid screenplay batch.");
    const existing = await ctx.db
      .query("sceneBatches")
      .withIndex("by_board_key", (q) =>
        q.eq("boardId", run.boardId).eq("key", args.key),
      )
      .unique();
    if (!existing)
      await ctx.db.insert("sceneBatches", {
        boardId: run.boardId,
        key: args.key,
        result: args.result,
        createdAt: Date.now(),
      });
    return { saved: true };
  },
});
