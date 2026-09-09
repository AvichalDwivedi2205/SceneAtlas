import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { requireMember, boardEntity, assertRevision } from "./lib/auth";
import { updateEntity } from "./lib/entities";
import { affectedIds, summarizeCosts } from "../src/domain/planning";
import { entitySchema } from "../src/domain/model";
import { effectivePlanSceneIds, scopedPlan } from "../src/domain/scope";
import { syncPlanDependencies } from "./lib/planScope";
import { enqueue } from "./lib/jobs";
import { planReadiness, planCostItems } from "../src/domain/plan-readiness";

export const startReadyPlans = mutation({
  args: { boardId: v.id("boards"), planIds: v.array(v.id("entities")) },
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.boardId, "editor");
    if (
      !args.planIds.length ||
      args.planIds.length > 8 ||
      new Set(args.planIds).size !== args.planIds.length
    )
      throw new ConvexError("Choose one to eight distinct plans to generate.");
    const plans = await Promise.all(
      args.planIds.map((id) => boardEntity(ctx, args.boardId, id)),
    );
    if (plans.some((p) => p.kind !== "plan"))
      throw new ConvexError("Choose plan records.");
    const all = await ctx.db
      .query("entities")
      .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
      .collect();
    const choices = await ctx.db
      .query("choices")
      .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
      .collect();
    const outcomes: {
      planId: Id<"entities">;
      runId?: Id<"runs">;
      blockers: string[];
    }[] = [];
    for (const plan of plans) {
      const ready = planReadiness(plan, all, choices);
      if (ready.blockers.length) {
        outcomes.push({ planId: plan._id, blockers: ready.blockers });
        continue;
      }
      try {
        const runId = await enqueue(ctx, {
          boardId: args.boardId,
          userId: user._id,
          kind: "schedule",
          targetId: plan._id,
          scope: { kind: "plan", planId: plan._id },
        });
        outcomes.push({ planId: plan._id, runId, blockers: [] });
      } catch (error) {
        outcomes.push({
          planId: plan._id,
          blockers: [
            error instanceof Error
              ? error.message
              : "Could not queue this plan. Retry it independently.",
          ],
        });
      }
    }
    return outcomes;
  },
});
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
    if (!effectivePlanSceneIds(plan.data, [scene]).includes(scene._id))
      throw new ConvexError(
        "Include this scene in the plan before selecting or locking a location.",
      );
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
    await updateEntity(ctx, plan, entitySchema.parse(plan.data), user._id);
    await syncPlanDependencies(ctx, (await ctx.db.get(plan._id))!);
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
    const all = await ctx.db
      .query("entities")
      .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
      .collect();
    const active = scopedPlan(p, all, choices);
    const locations = await Promise.all(
      [...new Set(active.choices.map((c) => c.locationId))].map((id) =>
        ctx.db.get(id),
      ),
    );
    return summarizeCosts(
      planCostItems(
        locations.filter((l) => l !== null),
        p.data.currency,
      ),
      p.data.currency,
      p.data.budgetMode === "fixed" ? p.data.budgetMinor : null,
    );
  },
});
