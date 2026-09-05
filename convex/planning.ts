import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireMember, boardEntity, assertRevision } from "./lib/auth";
import { connect, updateEntity } from "./lib/entities";
import { affectedIds, summarizeCosts } from "../src/domain/planning";
import { entitySchema } from "../src/domain/model";
export const select = mutation({
  args: {
    boardId: v.id("boards"),
    planId: v.id("entities"),
    sceneId: v.id("entities"),
    locationId: v.id("entities"),
    locked: v.boolean(),
    expectedRevision: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.boardId, "editor");
    const plan = await boardEntity(ctx, args.boardId, args.planId);
    const scene = await boardEntity(ctx, args.boardId, args.sceneId);
    const location = await boardEntity(ctx, args.boardId, args.locationId);
    if (
      plan.kind !== "plan" ||
      scene.kind !== "scene" ||
      location.kind !== "location" ||
      !location.data.sceneIds.includes(scene._id)
    )
      throw new ConvexError("Choose a candidate belonging to this scene.");
    const old = await ctx.db
      .query("choices")
      .withIndex("by_plan_scene", (q) =>
        q.eq("planId", args.planId).eq("sceneId", args.sceneId),
      )
      .unique();
    assertRevision(old?.revision ?? 0, args.expectedRevision);
    if (old?.locked && old.locationId !== args.locationId)
      throw new ConvexError("Unlock the current choice before replacing it.");
    const values = {
      boardId: args.boardId,
      planId: args.planId,
      sceneId: args.sceneId,
      locationId: args.locationId,
      locked: args.locked,
      revision: (old?.revision ?? 0) + 1,
    };
    if (old) await ctx.db.patch(old._id, values);
    else await ctx.db.insert("choices", values);
    if (old && old.locationId !== args.locationId) {
      const planChoices = await ctx.db
        .query("choices")
        .withIndex("by_plan_scene", (q) => q.eq("planId", args.planId))
        .collect();
      if (!planChoices.some((choice) => choice.locationId === old.locationId)) {
        const oldEdges = await ctx.db
          .query("edges")
          .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
          .collect();
        for (const edge of oldEdges)
          if (
            edge.sourceId === old.locationId &&
            edge.targetId === args.planId &&
            edge.relation === "selected"
          )
            await ctx.db.delete(edge._id);
        const oldDependencies = await ctx.db
          .query("dependencies")
          .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
          .collect();
        for (const dependency of oldDependencies)
          if (
            dependency.sourceId === old.locationId &&
            dependency.targetId === args.planId
          )
            await ctx.db.delete(dependency._id);
      }
    }
    await updateEntity(ctx, plan, entitySchema.parse(plan.data), user._id);
    await connect(ctx, args.boardId, args.locationId, args.planId, "selected");
    const deps = await ctx.db
      .query("dependencies")
      .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
      .collect();
    for (const id of affectedIds(args.planId, deps)) {
      const normalized = ctx.db.normalizeId("entities", id);
      const entity = normalized ? await ctx.db.get(normalized) : null;
      if (entity && !entity.stale)
        await updateEntity(
          ctx,
          entity,
          entitySchema.parse(entity.data),
          user._id,
          undefined,
          true,
        );
    }
    return null;
  },
});
export const summary = query({
  args: { boardId: v.id("boards"), planId: v.id("entities") },
  handler: async (ctx, args) => {
    await requireMember(ctx, args.boardId);
    const p = await boardEntity(ctx, args.boardId, args.planId);
    if (p.kind !== "plan") throw new ConvexError("Plan not found.");
    const choices = await ctx.db
      .query("choices")
      .withIndex("by_plan_scene", (q) => q.eq("planId", args.planId))
      .collect();
    const locations = await Promise.all(
      [...new Set(choices.map((c) => c.locationId))].map((id) =>
        ctx.db.get(id),
      ),
    );
    return summarizeCosts(
      locations.flatMap((l) => l?.data.costs ?? []),
      p.data.currency,
      p.data.budgetMode === "fixed" ? p.data.budgetMinor : null,
    );
  },
});
