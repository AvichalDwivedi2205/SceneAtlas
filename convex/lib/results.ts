import { z } from "zod";
import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { entitySchema, type EntityData } from "../../src/domain/model";
import { boardPlacements, connect, putEntity, updateEntity } from "./entities";
import { scopedPlan, effectivePlanSceneIds } from "../../src/domain/scope";
import { affectedIds } from "../../src/domain/planning";
import { syncPlanDependencies } from "./planScope";
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
type LocationData = Extract<EntityData, { kind: "location" }>;
const normalizedIdentity = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** A park's own named page can establish identity; statewide filming guidance cannot. */
function parkIdentitySources(data: LocationData) {
  const name = normalizedIdentity(data.name);
  if (!name || /^(california )?(state )?parks?$/.test(name))
    return new Set<string>();
  return new Set(
    data.sources.flatMap((source) => {
      const title = normalizedIdentity(source.title)
        .replace(/\bsp\b/g, "state park")
        .replace(/\bsb\b/g, "state beach");
      if (title !== name && !title.startsWith(`${name} `)) return [];
      try {
        const url = new URL(source.url);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.port ||
          !(
            url.hostname === "parks.ca.gov" ||
            url.hostname.endsWith(".parks.ca.gov")
          )
        )
          return [];
        if (
          /^\/(?:state-permits|film(?:ing)?(?:-permits?)?)(?:\/|$)/i.test(
            url.pathname,
          )
        )
          return [];
        if (
          url.pathname === "/" &&
          !/^\d+$/.test(url.searchParams.get("page_id") ?? "")
        )
          return [];
        // Compare official URL aliases without rewriting the saved evidence URLs.
        url.protocol = "https:";
        if (url.hostname === "www.parks.ca.gov") url.hostname = "parks.ca.gov";
        url.hash = "";
        return [url.href];
      } catch {
        return [];
      }
    }),
  );
}

function sameParkIdentity(
  candidate: LocationData,
  existing: LocationData,
  sources: Set<string>,
) {
  if (
    normalizedIdentity(candidate.name) !== normalizedIdentity(existing.name) ||
    existing.rejected
  )
    return false;
  const authority = normalizedIdentity(candidate.authority);
  const previousAuthority = normalizedIdentity(existing.authority);
  if (authority && previousAuthority && authority !== previousAuthority)
    return false;
  return [...parkIdentitySources(existing)].some((url) => sources.has(url));
}
export async function publishResult(
  ctx: MutationCtx,
  run: Doc<"runs">,
  result: AgentResult,
) {
  const actor = `agent:${run._id}`;
  const boardId = run.boardId;
  const placements = await boardPlacements(ctx, boardId);
  const changedLocations: Id<"entities">[] = [];
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
  for (const q of result.questions) {
    if (q.data.kind !== "question")
      throw new ConvexError("Invalid clarification result.");
    const ownerId = q.sceneNumber
      ? sceneIds.get(q.sceneNumber)
      : q.ownerId
        ? ctx.db.normalizeId("entities", q.ownerId)
        : run.targetId ||
          (run.scope.kind === "plan_scene"
            ? ctx.db.normalizeId("entities", run.scope.sceneId!)
            : scriptId);
    const owner = ownerId ? await ctx.db.get(ownerId) : null;
    if (!owner || owner.boardId !== boardId)
      throw new ConvexError("Question owner is invalid.");
    if (run.scope.kind === "scene" && owner._id !== run.targetId)
      throw new ConvexError("Question exceeds this scene's scope.");
    let scopedQuestionPlan: Doc<"entities"> | undefined;
    if (run.scope.planId) {
      const all = await ctx.db
        .query("entities")
        .withIndex("by_board", (q) => q.eq("boardId", boardId))
        .collect();
      const choices = await ctx.db
        .query("choices")
        .withIndex("by_board", (q) => q.eq("boardId", boardId))
        .collect();
      const plan = all.find((e) => e._id === run.scope.planId);
      if (
        !plan ||
        !scopedPlan(plan, all, choices, true).entities.some(
          (e) => e._id === owner._id,
        )
      )
        throw new ConvexError("Question exceeds the included plan scenes.");
      if (run.scope.kind === "plan_scene") {
        if (
          owner._id !== run.scope.sceneId &&
          !(
            owner._id === run.targetId &&
            owner.kind === "location" &&
            owner.data.sceneIds.includes(run.scope.sceneId)
          )
        )
          throw new ConvexError(
            "Question exceeds this plan's selected scene scope.",
          );
        scopedQuestionPlan = plan;
      }
    }
    const key = scopedQuestionPlan
      ? `${ownerId}:plan:${scopedQuestionPlan._id}:scene:${run.scope.sceneId}:question:${q.data.key}`
      : `${ownerId}:question:${q.data.key}`;
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
      scope: scopedQuestionPlan ? run.scope : owner.scope,
      ownerId: owner._id,
      logicalKey: key,
      actor,
      x: (node?.x ?? 0) + 400 * (siblingCount + 1),
      y: node?.y ?? 0,
    });
    const inputOwner = scopedQuestionPlan ?? owner;
    await connect(ctx, boardId, id, inputOwner._id, "question");
    const scopedResearchQuestion =
      !!scopedQuestionPlan &&
      q.data.blocks.some((kind) => ["research", "requirements"].includes(kind));
    if (scopedResearchQuestion) {
      const question = (await ctx.db.get(id))!;
      await updateEntity(
        ctx,
        question,
        entitySchema.parse(question.data),
        actor,
        run.changeId,
        true,
      );
    }
    const ownerRevision = await updateEntity(
      ctx,
      inputOwner,
      entitySchema.parse(inputOwner.data),
      actor,
      run.changeId,
      inputOwner.stale || scopedResearchQuestion,
    );
    if (scopedQuestionPlan && run.changeId) {
      const change = await ctx.db.get(run.changeId);
      if (change?.status === "regenerating") {
        const question = (await ctx.db.get(id))!;
        await ctx.db.patch(change._id, {
          readVersions: change.readVersions.map((version) =>
            version.id === inputOwner._id &&
            version.revision === inputOwner.revision
              ? { ...version, revision: ownerRevision }
              : version,
          ),
          appliedVersions: change.appliedVersions?.map((version) =>
            version.id === inputOwner._id &&
            version.revision === inputOwner.revision
              ? { ...version, revision: ownerRevision }
              : version,
          ),
          createdVersions: [
            ...(change.createdVersions ?? []),
            { id, revision: question.revision },
          ],
        });
      }
    }
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
    let key = refreshTarget?.logicalKey ?? locationKey(data);
    let previous = await ctx.db
      .query("entities")
      .withIndex("by_board_key", (q) =>
        q.eq("boardId", boardId).eq("logicalKey", key),
      )
      .unique();
    if (!previous && run.kind === "research") {
      const identitySources = parkIdentitySources(data);
      if (identitySources.size) {
        const locations = await ctx.db
          .query("entities")
          .withIndex("by_board_kind", (q) =>
            q.eq("boardId", boardId).eq("kind", "location"),
          )
          .collect();
        const matches = locations.filter((location) =>
          sameParkIdentity(data, location.data, identitySources),
        );
        // Historical duplicates stay separate. Only an unambiguous match can reuse its existing key and ID.
        if (matches.length === 1) {
          previous = matches[0];
          key = previous.logicalKey;
        }
      }
    }
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
    if (previous) changedLocations.push(id);
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
    const all = await ctx.db
      .query("entities")
      .withIndex("by_board", (q) => q.eq("boardId", boardId))
      .collect();
    const plan = all.find((e) => e._id === run.targetId);
    const allowed = new Set(
      plan?.kind === "plan" ? effectivePlanSceneIds(plan.data, all) : [],
    );
    const entries = result.schedule.entries;
    const choices = await ctx.db
      .query("choices")
      .withIndex("by_board", (q) => q.eq("boardId", boardId))
      .collect();
    if (
      entries.some(
        (row) =>
          !allowed.has(row.sceneId) ||
          !choices.some(
            (c) =>
              c.planId === run.targetId &&
              c.sceneId === row.sceneId &&
              c.locationId === row.locationId,
          ),
      ) ||
      new Set(entries.map((row) => row.sceneId)).size !== entries.length ||
      (!result.schedule.conflicts.length && entries.length !== allowed.size)
    )
      throw new ConvexError(
        "Schedule must match the included scenes and confirmed location choices.",
      );
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
  if (run.kind === "research" && run.targetId && result.locations.length) {
    if (run.scope.kind === "plan_scene") {
      const questions = await ctx.db
        .query("entities")
        .withIndex("by_board_kind", (q) =>
          q.eq("boardId", boardId).eq("kind", "question"),
        )
        .collect();
      for (const question of questions)
        if (
          question.stale &&
          question.scope.kind === "plan_scene" &&
          question.scope.planId === run.scope.planId &&
          question.scope.sceneId === run.targetId
        )
          await updateEntity(
            ctx,
            question,
            entitySchema.parse(question.data),
            actor,
            run.changeId,
            false,
          );
      // syncPlanDependencies below clears the plan marker only when no included question still needs research.
    } else {
      const scene = await ctx.db.get(run.targetId);
      if (scene?.kind === "scene" && scene.stale)
        await updateEntity(
          ctx,
          scene,
          entitySchema.parse(scene.data),
          actor,
          run.changeId,
          false,
        );
    }
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
      proposal.data.kind === "plan" &&
      JSON.stringify(
        proposal.data.sceneScope ?? { mode: "all", sceneIds: [] },
      ) !==
        JSON.stringify(target.data.sceneScope ?? { mode: "all", sceneIds: [] })
    )
      throw new ConvexError(
        "Choose included scenes directly. Agent proposals cannot change plan membership.",
      );
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
  const all = await ctx.db
    .query("entities")
    .withIndex("by_board", (q) => q.eq("boardId", boardId))
    .collect();
  for (const plan of all.filter((e) => e.kind === "plan"))
    await syncPlanDependencies(ctx, plan);
  if (changedLocations.length) {
    const dependencies = await ctx.db
      .query("dependencies")
      .withIndex("by_board", (q) => q.eq("boardId", boardId))
      .collect();
    const affected = new Set(
      changedLocations.flatMap((id) => affectedIds(id, dependencies)),
    );
    for (const entity of all)
      if (
        affected.has(entity._id) &&
        ["schedule", "packet"].includes(entity.kind) &&
        !entity.stale
      )
        await updateEntity(
          ctx,
          entity,
          entitySchema.parse(entity.data),
          actor,
          run.changeId,
          true,
        );
  }
  await ctx.db.patch(boardId, { updatedAt: Date.now() });
}
