import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export const scope = v.object({
  kind: v.union(
    v.literal("workspace"),
    v.literal("scene"),
    v.literal("plan"),
    v.literal("plan_scene"),
  ),
  sceneId: v.optional(v.string()),
  planId: v.optional(v.string()),
});
export const role = v.union(
  v.literal("owner"),
  v.literal("editor"),
  v.literal("viewer"),
);
export const runStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("waiting"),
  v.literal("complete"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("superseded"),
);
export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.string(),
    subject: v.string(),
    name: v.string(),
    email: v.optional(v.string()),
    emailVerified: v.boolean(),
    avatar: v.optional(v.string()),
  }).index("by_identity", ["tokenIdentifier"]),
  boards: defineTable({
    name: v.string(),
    ownerId: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
    archived: v.boolean(),
  }).index("by_owner", ["ownerId"]),
  members: defineTable({
    boardId: v.id("boards"),
    userId: v.id("users"),
    role,
    createdAt: v.number(),
  })
    .index("by_board_user", ["boardId", "userId"])
    .index("by_user", ["userId"]),
  invites: defineTable({
    boardId: v.id("boards"),
    email: v.string(),
    role: v.union(v.literal("editor"), v.literal("viewer")),
    tokenHash: v.string(),
    expiresAt: v.number(),
    createdBy: v.id("users"),
    acceptedBy: v.optional(v.id("users")),
    revoked: v.boolean(),
  })
    .index("by_hash", ["tokenHash"])
    .index("by_board", ["boardId"]),
  entities: defineTable({
    boardId: v.id("boards"),
    kind: v.string(),
    data: v.any(),
    scope,
    ownerId: v.optional(v.id("entities")),
    logicalKey: v.string(),
    revision: v.number(),
    stale: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
    updatedBy: v.string(),
  })
    .index("by_board", ["boardId"])
    .index("by_board_key", ["boardId", "logicalKey"])
    .index("by_board_kind", ["boardId", "kind"]),
  versions: defineTable({
    boardId: v.id("boards"),
    entityId: v.id("entities"),
    revision: v.number(),
    data: v.any(),
    stale: v.boolean(),
    createdAt: v.number(),
    createdBy: v.string(),
    changeId: v.optional(v.id("changes")),
  }).index("by_entity_revision", ["entityId", "revision"]),
  nodes: defineTable({
    boardId: v.id("boards"),
    entityId: v.id("entities"),
    x: v.number(),
    y: v.number(),
    width: v.number(),
    height: v.number(),
    geometryRevision: v.number(),
    manual: v.boolean(),
    parentId: v.optional(v.string()),
  })
    .index("by_board", ["boardId"])
    .index("by_entity", ["entityId"]),
  edges: defineTable({
    boardId: v.id("boards"),
    sourceId: v.id("entities"),
    targetId: v.id("entities"),
    relation: v.string(),
  }).index("by_board", ["boardId"]),
  dependencies: defineTable({
    boardId: v.id("boards"),
    sourceId: v.id("entities"),
    targetId: v.id("entities"),
  }).index("by_board", ["boardId"]),
  choices: defineTable({
    boardId: v.id("boards"),
    planId: v.id("entities"),
    sceneId: v.id("entities"),
    locationId: v.id("entities"),
    locked: v.boolean(),
    revision: v.number(),
  })
    .index("by_board", ["boardId"])
    .index("by_plan_scene", ["planId", "sceneId"]),
  runs: defineTable({
    boardId: v.id("boards"),
    kind: v.string(),
    scope,
    targetId: v.optional(v.id("entities")),
    status: runStatus,
    activity: v.string(),
    error: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
    inputVersions: v.array(
      v.object({ id: v.id("entities"), revision: v.number() }),
    ),
    workKey: v.string(),
    attempt: v.number(),
    eventSequence: v.number(),
    sessionId: v.optional(v.string()),
    output: v.optional(v.any()),
    request: v.optional(v.any()),
    changeId: v.optional(v.id("changes")),
  })
    .index("by_board", ["boardId"])
    .index("by_work_key", ["workKey"])
    .index("by_status_updated", ["status", "updatedAt"]),
  events: defineTable({
    boardId: v.id("boards"),
    runId: v.id("runs"),
    sequence: v.number(),
    attempt: v.number(),
    activity: v.string(),
    createdAt: v.number(),
    detail: v.optional(v.string()),
    providerId: v.optional(v.string()),
  }).index("by_run", ["runId"]),
  outbox: defineTable({
    runId: v.id("runs"),
    attempt: v.number(),
    status: v.string(),
    tries: v.number(),
    updatedAt: v.number(),
    error: v.optional(v.string()),
  })
    .index("by_run", ["runId"])
    .index("by_status", ["status"]),
  changes: defineTable({
    boardId: v.id("boards"),
    targetId: v.optional(v.id("entities")),
    baseRevision: v.optional(v.number()),
    proposed: v.optional(v.any()),
    before: v.optional(v.any()),
    affectedIds: v.array(v.id("entities")),
    readVersions: v.array(
      v.object({ id: v.id("entities"), revision: v.number() }),
    ),
    status: v.union(
      v.literal("preview"),
      v.literal("regenerating"),
      v.literal("ready"),
      v.literal("applied"),
      v.literal("undone"),
      v.literal("discarded"),
    ),
    createdBy: v.id("users"),
    createdAt: v.number(),
    summary: v.string(),
    runIds: v.array(v.id("runs")),
    appliedVersions: v.optional(
      v.array(
        v.object({
          id: v.id("entities"),
          revision: v.number(),
          before: v.any(),
          stale: v.boolean(),
        }),
      ),
    ),
    createdVersions: v.optional(
      v.array(v.object({ id: v.id("entities"), revision: v.number() })),
    ),
    createdAssets: v.optional(
      v.array(
        v.object({ assetId: v.id("assets"), storageId: v.id("_storage") }),
      ),
    ),
  }).index("by_board", ["boardId"]),
  assets: defineTable({
    boardId: v.id("boards"),
    storageId: v.id("_storage"),
    filename: v.string(),
    mime: v.string(),
    size: v.number(),
    createdBy: v.string(),
    createdAt: v.number(),
  })
    .index("by_board", ["boardId"])
    .index("by_storage", ["storageId"]),
  uploadTickets: defineTable({
    boardId: v.id("boards"),
    userId: v.id("users"),
    filename: v.string(),
    size: v.number(),
    mime: v.string(),
    createdAt: v.number(),
    used: v.boolean(),
  }),
  signals: defineTable({
    boardId: v.id("boards"),
    userId: v.id("users"),
    sessionId: v.string(),
    cursor: v.union(v.null(), v.object({ x: v.number(), y: v.number() })),
    selectedIds: v.array(v.string()),
    editingId: v.union(v.null(), v.string()),
    drag: v.union(
      v.null(),
      v.object({ entityId: v.string(), x: v.number(), y: v.number() }),
    ),
    updatedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_board", ["boardId"])
    .index("by_session", ["boardId", "sessionId"])
    .index("by_expiry", ["expiresAt"]),
  messages: defineTable({
    boardId: v.id("boards"),
    scope,
    role: v.union(v.literal("user"), v.literal("assistant")),
    text: v.string(),
    createdAt: v.number(),
    userId: v.optional(v.id("users")),
    runId: v.optional(v.id("runs")),
    sources: v.optional(v.any()),
    changeId: v.optional(v.id("changes")),
  }).index("by_board", ["boardId"]),
});
