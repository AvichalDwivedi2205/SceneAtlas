import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { requireMember } from "./lib/auth";
import { entitySchema, type EntityData } from "../src/domain/model";

/** Packet rebuilds retain their immutable file references in entity versions. */
export const history = query({
  args: { packetId: v.id("entities"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { packetId, paginationOpts }) => {
    const packet = await ctx.db.get(packetId);
    if (!packet) throw new ConvexError("Packet not found.");
    await requireMember(ctx, packet.boardId);
    if (packet.kind !== "packet")
      throw new ConvexError("Choose a packet document.");
    const versions = await ctx.db
      .query("versions")
      .withIndex("by_entity_revision", (q) => q.eq("entityId", packetId))
      .order("desc")
      .paginate({
        ...paginationOpts,
        numItems: Math.min(50, paginationOpts.numItems),
      });
    const seen = new Set<string>();
    const page: {
      revision: number;
      savedAt: number;
      data: Extract<EntityData, { kind: "packet" }>;
    }[] = [];
    for (const version of versions.page) {
      const parsed = entitySchema.safeParse(version.data);
      if (
        version.boardId !== packet.boardId ||
        !parsed.success ||
        parsed.data.kind !== "packet" ||
        parsed.data.planId !== packet.data.planId
      )
        continue;
      const data = parsed.data;
      if (seen.has(data.assetId)) continue;
      const assetId = ctx.db.normalizeId("assets", data.assetId);
      const asset = assetId ? await ctx.db.get(assetId) : null;
      if (
        !asset ||
        asset.boardId !== packet.boardId ||
        asset.mime !== "application/pdf"
      )
        continue;
      seen.add(data.assetId);
      page.push({
        revision: version.revision,
        savedAt: version.createdAt,
        data,
      });
    }
    return { ...versions, page };
  },
});
