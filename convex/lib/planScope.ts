import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { EntityData, PlanData } from "../../src/domain/model";
import { effectivePlanSceneIds, scopedPlan } from "../../src/domain/scope";
import { affectedIds } from "../../src/domain/planning";
import { connect, updateEntity } from "./entities";
import { entitySchema } from "../../src/domain/model";

export async function validatePlanScenes(
  ctx: MutationCtx,
  boardId: Id<"boards">,
  plan: PlanData,
) {
  for (const id of plan.sceneScope?.sceneIds ?? []) {
    const normalized = ctx.db.normalizeId("entities", id);
    const scene = normalized ? await ctx.db.get(normalized) : null;
    if (!scene || scene.boardId !== boardId || scene.kind !== "scene")
      throw new ConvexError(
        "Every included scene must belong to this screenplay workspace.",
      );
  }
}

export function sceneInputKind(
  target: Doc<"entities">,
  proposed: EntityData,
  all: Doc<"entities">[],
) {
  const owner = all.find((entity) => entity._id === target.ownerId);
  const sceneId =
    target.kind === "scene"
      ? target._id
      : target.kind === "question" && target.scope.kind === "plan_scene"
        ? all.find(
            (entity) =>
              entity.kind === "scene" && entity._id === target.scope.sceneId,
          )?._id
        : target.kind === "question" && owner?.kind === "scene"
          ? owner._id
          : undefined;
  if (!sceneId) return;
  const timingFields = new Set(["durationMinutes", "durationBasis", "windows"]);
  const timingOnly =
    target.kind === "scene"
      ? Object.keys({ ...target.data, ...proposed })
          .filter(
            (field) =>
              JSON.stringify(target.data[field]) !==
              JSON.stringify((proposed as Record<string, unknown>)[field]),
          )
          .every((field) => timingFields.has(field))
      : target.data.blocks.every((kind: string) =>
          ["schedule", "packet"].includes(kind),
        );
  const planId =
    target.scope.kind === "plan_scene" ? target.scope.planId : undefined;
  return { sceneId, timingOnly, planId };
}

/** Scene decisions affect plans containing that scene; a shared location is a separate input. */
export function revisionImpact(
  target: Doc<"entities">,
  proposed: EntityData,
  all: Doc<"entities">[],
  dependencies: Pick<Doc<"dependencies">, "sourceId" | "targetId">[],
) {
  const reachable = new Set(affectedIds(target._id, dependencies));
  const local = sceneInputKind(target, proposed, all);
  if (!local)
    return {
      affected: all.filter((entity) => reachable.has(entity._id)),
      researchSceneId: undefined,
      researchPlanId: undefined,
      preserveResearch: false,
    };
  const plans = new Set(
    all
      .filter(
        (entity) =>
          entity.kind === "plan" &&
          (!target.scope.planId || entity._id === target.scope.planId) &&
          effectivePlanSceneIds(entity.data, all).includes(local.sceneId),
      )
      .map((entity) => entity._id),
  );
  if (local.planId && !plans.size)
    return {
      affected: [],
      researchSceneId: undefined,
      researchPlanId: undefined,
      preserveResearch: true,
    };
  return {
    affected: all.filter((entity) => {
      if (!reachable.has(entity._id)) return false;
      if (entity.kind === "plan") return plans.has(entity._id);
      if (entity.kind === "schedule" || entity.kind === "packet")
        return plans.has(entity.data.planId);
      if (local.planId && entity.kind === "scene") return false;
      if (["location", "cost", "requirement"].includes(entity.kind))
        return !local.timingOnly;
      return (
        entity._id === local.sceneId || entity.scope.sceneId === local.sceneId
      );
    }),
    researchSceneId:
      local.timingOnly || local.planId ? undefined : local.sceneId,
    researchPlanId:
      local.timingOnly || !local.planId || !plans.size
        ? undefined
        : local.planId,
    preserveResearch: true,
  };
}

/** Reconcile only incoming plan input relationships; saved excluded choices survive. */
export async function syncPlanDependencies(
  ctx: MutationCtx,
  plan: Doc<"entities">,
) {
  if (plan.kind !== "plan") return;
  const all = await ctx.db
    .query("entities")
    .withIndex("by_board", (q) => q.eq("boardId", plan.boardId))
    .collect();
  const choices = await ctx.db
    .query("choices")
    .withIndex("by_plan_scene", (q) => q.eq("planId", plan._id))
    .collect();
  const selected = scopedPlan(plan, all, choices);
  const planQuestions = all.filter(
    (entity) =>
      entity.kind === "question" &&
      entity.scope.kind === "plan_scene" &&
      entity.scope.planId === plan._id,
  );
  const needsResearch = selected.entities.some(
    (entity) =>
      entity.kind === "question" &&
      entity.scope.kind === "plan_scene" &&
      entity.scope.planId === plan._id &&
      entity.stale,
  );
  if (planQuestions.length && plan.stale !== needsResearch)
    await updateEntity(
      ctx,
      plan,
      entitySchema.parse(plan.data),
      plan.updatedBy,
      undefined,
      needsResearch,
    );
  const inputs = selected.entities.filter(
    (e) => !["plan", "schedule", "packet", "answer", "note"].includes(e.kind),
  );
  const wanted = new Set(inputs.map((e) => e._id));
  const edges = await ctx.db
    .query("edges")
    .withIndex("by_board", (q) => q.eq("boardId", plan.boardId))
    .collect();
  const dependencies = await ctx.db
    .query("dependencies")
    .withIndex("by_board", (q) => q.eq("boardId", plan.boardId))
    .collect();
  for (const edge of edges)
    if (edge.targetId === plan._id && !wanted.has(edge.sourceId))
      await ctx.db.delete(edge._id);
  for (const edge of dependencies)
    if (edge.targetId === plan._id && !wanted.has(edge.sourceId))
      await ctx.db.delete(edge._id);
  for (const input of inputs)
    await connect(
      ctx,
      plan.boardId,
      input._id,
      plan._id,
      input.kind === "location"
        ? "selected"
        : input.kind === "scene"
          ? "plan"
          : "production-input",
    );
}
