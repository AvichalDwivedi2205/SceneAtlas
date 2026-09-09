import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { connect, putEntity } from "../convex/lib/entities";
import { locationKey } from "../convex/lib/results";
import { syncPlanDependencies } from "../convex/lib/planScope";
import { entitySchema, type LocationData } from "../src/domain/model";

const modules = import.meta.glob("../convex/**/*.ts");
const parkSource = {
  url: "https://www.parks.ca.gov/leocarrillo",
  title: "Leo Carrillo State Park - California State Parks",
  excerpt: "Observed park information.",
  provider: "parallel" as const,
  cached: false,
  retrievedAt: 1,
};
const discoverySource = {
  ...parkSource,
  url: "https://www.tripadvisor.com/leo-carrillo",
  title: "Leo Carrillo State Park and Beach",
};

async function fixture(
  options: { duplicate?: boolean; oldSources?: LocationData["sources"] } = {},
) {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity({
    tokenIdentifier: "https://clerk.test|park-owner",
    subject: "park-owner",
    name: "Producer",
  });
  const actor = await owner.mutation(api.boards.initialize);
  const boardId = await owner.mutation(api.boards.create, {
    name: "Park identity",
  });
  const otherBoardId = await owner.mutation(api.boards.create, {
    name: "Independent park board",
  });
  const records = await t.run(async (ctx) => {
    const scenes = [];
    for (const [index, id] of [boardId, boardId, otherBoardId].entries()) {
      const sceneId = await putEntity(ctx, {
        boardId: id,
        actor,
        logicalKey: `scene:${index + 1}`,
        scope: { kind: "workspace" },
        data: entitySchema.parse({
          kind: "scene",
          number: index + 1,
          heading: "EXT. COAST - DAY",
          setting: "Coast",
          excerpt: "A rehearsal.",
          pageStart: index + 1,
          pageEnd: index + 1,
          interiorExterior: "EXT",
          timeOfDay: "DAY",
          needs: [],
        }),
      });
      await ctx.db.patch(sceneId, { scope: { kind: "scene", sceneId } });
      scenes.push(sceneId);
    }
    const oldData = entitySchema.parse({
      kind: "location",
      name: "Leo Carrillo State Park",
      address: "35000 Pacific Coast Hwy, Malibu, CA 90265",
      description: "Observed coast",
      creativeFit: "Open sand",
      authority: "California State Parks",
      restrictions: [],
      sources: options.oldSources ?? [discoverySource, parkSource],
      costs: [],
      requirements: [],
      sceneIds: [scenes[0]],
    }) as LocationData;
    const oldKey = locationKey(oldData);
    const locationId = await putEntity(ctx, {
      boardId,
      actor,
      logicalKey: oldKey,
      ownerId: scenes[0],
      scope: { kind: "scene", sceneId: scenes[0] },
      data: oldData,
    });
    await connect(ctx, boardId, scenes[0], locationId, "candidate");
    const otherLocationId = await putEntity(ctx, {
      boardId: otherBoardId,
      actor,
      logicalKey: oldKey,
      ownerId: scenes[2],
      scope: { kind: "scene", sceneId: scenes[2] },
      data: { ...oldData, sceneIds: [scenes[2]] },
    });
    const duplicateId = options.duplicate
      ? await putEntity(ctx, {
          boardId,
          actor,
          logicalKey: `${oldKey}:historical-duplicate`,
          ownerId: scenes[0],
          scope: { kind: "scene", sceneId: scenes[0] },
          data: oldData,
        })
      : undefined;
    const planId = await putEntity(ctx, {
      boardId,
      actor,
      logicalKey: "plan",
      scope: { kind: "workspace" },
      data: entitySchema.parse({
        kind: "plan",
        name: "Locked original plan",
        priority: "cost",
        budgetMode: "uncapped",
        budgetMinor: null,
        sceneScope: { mode: "selected", sceneIds: [scenes[0]] },
      }),
    });
    await ctx.db.patch(planId, { scope: { kind: "plan", planId } });
    const choiceId = await ctx.db.insert("choices", {
      boardId,
      planId,
      sceneId: scenes[0],
      locationId,
      locked: true,
      revision: 1,
    });
    const scheduleId = await putEntity(ctx, {
      boardId,
      actor,
      logicalKey: `${planId}:schedule`,
      scope: { kind: "plan", planId },
      ownerId: planId,
      data: entitySchema.parse({
        kind: "schedule",
        planId,
        entries: [],
        conflicts: [],
        provisional: true,
        moves: 0,
        days: 0,
        explanation: "Saved previous schedule",
      }),
    });
    await connect(ctx, boardId, planId, scheduleId, "schedule");
    await syncPlanDependencies(ctx, (await ctx.db.get(planId))!);
    return {
      scenes,
      oldData,
      oldKey,
      locationId,
      otherLocationId,
      duplicateId,
      choiceId,
      scheduleId,
    };
  });
  return { t, owner, actor, boardId, ...records };
}

async function publish(
  f: Awaited<ReturnType<typeof fixture>>,
  patch: Partial<LocationData> = {},
) {
  const runId = await f.owner.mutation(api.runs.start, {
    boardId: f.boardId,
    kind: "research",
    targetId: f.scenes[1],
    scope: { kind: "scene", sceneId: f.scenes[1] },
  });
  expect(await f.t.mutation(internal.runs.claim, { runId, attempt: 1 })).toBe(
    true,
  );
  await f.t.mutation(internal.runs.event, {
    runId,
    attempt: 1,
    sequence: 1,
    status: "complete",
    activity: "Observed candidate returned",
    result: {
      locations: [
        {
          ...f.oldData,
          address: "35000 West Pacific Coast Highway, Malibu, CA 90265",
          sources: [parkSource],
          sceneIds: [f.scenes[1]],
          ...patch,
        },
      ],
    },
  });
  return f.owner.query(api.boards.snapshot, { boardId: f.boardId });
}

describe("official park evidence resolves a new research candidate's identity", () => {
  it.each([
    ["http://www.parks.ca.gov/leocarrillo", "https://parks.ca.gov/leocarrillo"],
    ["https://parks.ca.gov/leocarrillo", "http://www.parks.ca.gov/leocarrillo"],
    [
      "https://www.parks.ca.gov/leocarrillo",
      "https://parks.ca.gov/leocarrillo",
    ],
  ])(
    "compares official aliases %s and %s without rewriting provenance",
    async (originalUrl, returnedUrl) => {
      const f = await fixture({
        oldSources: [discoverySource, { ...parkSource, url: originalUrl }],
      });
      const returnedSource = { ...parkSource, url: returnedUrl };
      const result = await publish(f, { sources: [returnedSource] });
      const locations = result.entities.filter(
        (entity) => entity.kind === "location",
      );
      expect(locations).toHaveLength(1);
      expect(locations[0]).toMatchObject({
        _id: f.locationId,
        logicalKey: f.oldKey,
        data: { sources: [returnedSource], sceneIds: f.scenes.slice(0, 2) },
      });
      const originalVersion = await f.t.run((ctx) =>
        ctx.db
          .query("versions")
          .withIndex("by_entity_revision", (q) =>
            q.eq("entityId", f.locationId).eq("revision", 1),
          )
          .unique(),
      );
      expect(originalVersion!.data.sources[1].url).toBe(originalUrl);
      expect(locationKey({ ...f.oldData, sources: [returnedSource] })).toBe(
        `location:leo-carrillo-state-park:${new URL(returnedUrl).hostname}`,
      );
    },
  );

  it("reuses a unique park ID across address formatting and leading source hosts, preserving locks and invalidation", async () => {
    const f = await fixture();
    const beforeChoice = await f.t.run((ctx) => ctx.db.get(f.choiceId));
    const result = await publish(f);
    const locations = result.entities.filter((e) => e.kind === "location");
    expect(locations).toHaveLength(1);
    expect(locations[0]).toMatchObject({
      _id: f.locationId,
      logicalKey: f.oldKey,
      revision: 2,
      ownerId: f.scenes[0],
      data: {
        address: "35000 West Pacific Coast Highway, Malibu, CA 90265",
        sceneIds: f.scenes.slice(0, 2),
      },
    });
    expect(await f.t.run((ctx) => ctx.db.get(f.choiceId))).toEqual(
      beforeChoice,
    );
    expect(result.entities.find((e) => e._id === f.scheduleId)!.stale).toBe(
      true,
    );
    expect(await f.t.run((ctx) => ctx.db.get(f.otherLocationId))).toMatchObject(
      { revision: 1, data: { sceneIds: [f.scenes[2]] } },
    );
  });

  it.each([
    {
      label: "generic parks guidance",
      sources: [
        {
          ...parkSource,
          url: "https://www.parks.ca.gov/?page_id=24674",
          title: "Beach and Ocean Motion Picture Locations",
        },
      ],
    },
    {
      label: "CFC guidance even with the park name in its title",
      sources: [
        {
          ...parkSource,
          url: "https://film.ca.gov/state-permits/",
          title: "Leo Carrillo State Park",
        },
      ],
    },
    {
      label: "generic filming URL even with the park name in its title",
      sources: [
        {
          ...parkSource,
          url: "https://www.parks.ca.gov/filming",
          title: "Leo Carrillo State Park",
        },
      ],
    },
  ])("does not establish identity from $label", async ({ sources }) => {
    const f = await fixture({ oldSources: [discoverySource, ...sources] });
    const result = await publish(f, { sources });
    expect(result.entities.filter((e) => e.kind === "location")).toHaveLength(
      2,
    );
    expect(result.entities.find((e) => e._id === f.locationId)!.revision).toBe(
      1,
    );
  });

  it.each([
    {
      label: "different named subsite",
      patch: { name: "Leo Carrillo State Park North Beach" },
    },
    {
      label: "different official subsite",
      patch: {
        sources: [
          { ...parkSource, url: "https://www.parks.ca.gov/another-park" },
        ],
      },
    },
    {
      label: "different named authority",
      patch: { authority: "City of Malibu" },
    },
    {
      label: "a shared page that identifies another park",
      patch: {
        sources: [{ ...parkSource, title: "Malibu Lagoon State Beach" }],
      },
    },
  ])("keeps a $label separate", async ({ patch }) => {
    const f = await fixture();
    const result = await publish(f, patch);
    expect(result.entities.filter((e) => e.kind === "location")).toHaveLength(
      2,
    );
    expect(result.entities.find((e) => e._id === f.locationId)!.revision).toBe(
      1,
    );
  });

  it("leaves ambiguous historical duplicates and their locked choices untouched", async () => {
    const f = await fixture({ duplicate: true });
    const choice = await f.t.run((ctx) => ctx.db.get(f.choiceId));
    const result = await publish(f);
    expect(result.entities.filter((e) => e.kind === "location")).toHaveLength(
      3,
    );
    for (const id of [f.locationId, f.duplicateId])
      expect(result.entities.find((e) => e._id === id)).toMatchObject({
        revision: 1,
        data: { sceneIds: [f.scenes[0]] },
      });
    expect(await f.t.run((ctx) => ctx.db.get(f.choiceId))).toEqual(choice);
  });

  it("preserves the existing exact-key lookup before the fallback", async () => {
    const genericSource = {
      ...discoverySource,
      title: "Regional visitor guidance",
    };
    const f = await fixture({ oldSources: [genericSource] });
    const result = await publish(f, { sources: [genericSource] });
    expect(result.entities.filter((e) => e.kind === "location")).toHaveLength(
      1,
    );
    expect(result.entities.find((e) => e._id === f.locationId)).toMatchObject({
      logicalKey: f.oldKey,
      revision: 2,
      data: { sceneIds: f.scenes.slice(0, 2) },
    });
  });
});
