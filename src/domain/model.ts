import { z } from "zod";

export const roleSchema = z.enum(["owner", "editor", "viewer"]);
export type Role = z.infer<typeof roleSchema>;
export const scopeSchema = z.object({
  kind: z.enum(["workspace", "scene", "plan", "plan_scene"]),
  sceneId: z.string().optional(),
  planId: z.string().optional(),
}).superRefine((scope, ctx) => {
  if ((scope.kind === "scene" || scope.kind === "plan_scene") && !scope.sceneId)
    ctx.addIssue({ code: "custom", message: "Scene scope requires a scene", path: ["sceneId"] });
  if ((scope.kind === "plan" || scope.kind === "plan_scene") && !scope.planId)
    ctx.addIssue({ code: "custom", message: "Plan scope requires a plan", path: ["planId"] });
});
export type Scope = z.infer<typeof scopeSchema>;
export const runStatusSchema = z.enum(["queued", "running", "waiting", "complete", "failed", "cancelled", "superseded"]);
export type RunStatus = z.infer<typeof runStatusSchema>;
export const taskKindSchema = z.enum(["ingest", "scenes", "research", "requirements", "schedule", "chat", "packet", "interpret"]);
export type TaskKind = z.infer<typeof taskKindSchema>;
export const sourceSchema = z.object({
  url: z.url().refine((s) => /^https?:\/\//.test(s), "Source must be an HTTP URL"),
  title: z.string().max(500),
  excerpt: z.string().max(4000),
  retrievedAt: z.number(),
  searchId: z.string().optional(),
  provider: z.enum(["parallel", "exa", "official", "user"]),
  fallbackReason: z.string().max(200).optional(),
  cached: z.boolean().default(false),
});
export type Source = z.infer<typeof sourceSchema>;
export const costSchema = z.object({
  id: z.string(), label: z.string(), amountMinor: z.number().int().nonnegative().nullable(),
  currency: z.string().length(3), unit: z.enum(["hour", "day", "application", "location", "flat"]),
  quantity: z.number().positive(), basis: z.enum(["published", "quote", "estimate", "unknown"]),
  coverageKey: z.string(), coverageReason: z.string(), source: sourceSchema.optional(),
  assumptions: z.string().default(""),
}).superRefine((cost, ctx) => {
  if ((cost.basis === "unknown") !== (cost.amountMinor === null))
    ctx.addIssue({ code: "custom", message: "Unknown costs must have no amount" });
  if ((cost.basis === "published" || cost.basis === "quote") && !cost.source)
    ctx.addIssue({ code: "custom", message: "Published costs and quotes require evidence" });
});
export type Cost = z.infer<typeof costSchema>;
export const requirementSchema = z.object({
  title: z.string(), detail: z.string(), authority: z.string(),
  status: z.enum(["sourced", "unresolved", "unsupported"]), sources: z.array(sourceSchema),
  leadTime: z.string().optional(), formUrl: z.url().optional(), attachments: z.array(z.string()),
  applicableFacts: z.array(z.string()), externalStatus: z.literal("unverified").default("unverified"),
}).superRefine((req, ctx) => {
  if (req.status === "sourced" && req.sources.length === 0)
    ctx.addIssue({ code: "custom", message: "Sourced requirements need evidence" });
});
export type Requirement = z.infer<typeof requirementSchema>;
export const windowSchema = z.object({ date: z.iso.date(), start: z.number().int().min(0).max(1439), end: z.number().int().min(1).max(1440) }).superRefine((window,ctx)=>{
  if(window.end<=window.start)ctx.addIssue({code:"custom",message:"Shooting window must end after it starts",path:["end"]});
});
export const ruleSchema = z.object({
  field: z.string(), value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
  strength: z.enum(["hard", "preference"]), origin: z.enum(["user", "script", "source", "estimate"]),
  explanation: z.string(),
});
export type Rule = z.infer<typeof ruleSchema>;
const scriptSchema = z.object({ kind: z.literal("script"), filename: z.string(), pageCount: z.number().int(),
  assetId: z.string().optional(), pageAssetId: z.string().optional(), summary: z.string(), sceneCount: z.number().int().default(0) });
const sceneSchema = z.object({ kind: z.literal("scene"), number: z.number().int().positive(), heading: z.string(),
  excerpt: z.string(), pageStart: z.number().int().positive(), pageEnd: z.number().int().positive(),
  setting: z.string(), interiorExterior: z.enum(["INT", "EXT", "INT/EXT", "UNKNOWN"]),
  timeOfDay: z.string(), needs: z.array(z.string()), durationMinutes: z.number().positive().nullable().default(null),
  durationBasis: z.enum(["confirmed", "estimate", "unknown"]).default("unknown"),
  candidateCount: z.number().int().min(1).max(5).default(3), ranking: z.enum(["creative", "cost", "moves"]).default("creative"),
  windows: z.array(windowSchema).default([]),
}).superRefine((scene,ctx)=>{
  if(scene.durationBasis==="unknown"&&scene.durationMinutes!==null)ctx.addIssue({code:"custom",message:"Unknown duration cannot have a numeric value",path:["durationMinutes"]});
  if(scene.durationBasis!=="unknown"&&scene.durationMinutes===null)ctx.addIssue({code:"custom",message:"Confirmed or estimated duration needs minutes",path:["durationMinutes"]});
  if(scene.pageEnd<scene.pageStart)ctx.addIssue({code:"custom",message:"Scene page range is invalid",path:["pageEnd"]});
});
const questionSchema = z.object({ kind: z.literal("question"), key: z.string(), prompt: z.string(), reason: z.string(),
  suggestions: z.array(z.string()).max(6), blocks: z.array(taskKindSchema),
  answer: z.string().nullable().default(null), resolution: z.enum(["open", "answered", "unknown"]).default("open"),
  rule: ruleSchema.nullable().default(null),
});
const answerSchema = z.object({ kind: z.literal("answer"), questionId: z.string(), question: z.string(), original: z.string(),
  rule: ruleSchema.nullable(), resolution: z.enum(["answered", "unknown"]) });
const locationSchema = z.object({ kind: z.literal("location"), name: z.string(), address: z.string(),
  description: z.string(), creativeFit: z.string(), restrictions: z.array(z.string()),
  availability: z.literal("unverified").default("unverified"), authority: z.string(),
  sources: z.array(sourceSchema).min(1), imageUrl: z.url().optional(), imageSourceUrl: z.url().optional(),
  costs: z.array(costSchema), requirements: z.array(requirementSchema), sceneIds: z.array(z.string()),
  rejected: z.boolean().default(false),
});
export const choiceSchema = z.object({ sceneId: z.string(), locationId: z.string(), locked: z.boolean() });
const planSchema = z.object({ kind: z.literal("plan"), name: z.string().min(1).max(80),
  budgetMode: z.enum(["fixed", "uncapped"]), budgetMinor: z.number().int().positive().nullable(), currency: z.string().length(3).default("USD"),
  priority: z.enum(["cost", "moves", "days", "creative"]), idealShoot: z.string().default(""),
  rules: z.array(ruleSchema).default([]), dates: z.array(z.string()).default([]), timezone: z.string().default("America/Los_Angeles"),
  dayStart: z.number().int().min(0).max(1439).default(480), dayEnd: z.number().int().min(1).max(1440).default(1080),
  moveMinutes: z.number().nonnegative().nullable().default(null), setupMinutes: z.number().nonnegative().nullable().default(null),
  timingBasis: z.enum(["confirmed", "estimate", "unknown"]).default("unknown"),
}).superRefine((plan,ctx)=>{
  if(plan.budgetMode==="uncapped"&&plan.budgetMinor!==null)ctx.addIssue({code:"custom",message:"Uncapped plan cannot carry a hidden budget",path:["budgetMinor"]});
  if(plan.dayEnd<=plan.dayStart)ctx.addIssue({code:"custom",message:"Shooting day must end after it starts",path:["dayEnd"]});
  const hasTiming=plan.moveMinutes!==null||plan.setupMinutes!==null;
  if(plan.timingBasis==="unknown"&&hasTiming)ctx.addIssue({code:"custom",message:"Numeric setup or move time needs a confirmed or estimate basis",path:["timingBasis"]});
  if(plan.timingBasis!=="unknown"&&(plan.moveMinutes===null||plan.setupMinutes===null))ctx.addIssue({code:"custom",message:"Timing basis needs both setup and move minutes",path:["timingBasis"]});
  for(const [i,date] of plan.dates.entries())if(!z.iso.date().safeParse(date).success)ctx.addIssue({code:"custom",message:"Use YYYY-MM-DD shooting dates",path:["dates",i]});
});
export const scheduleEntrySchema = z.object({ sceneId: z.string(), sceneNumber: z.number(), locationId: z.string(),
  locationName: z.string(), date: z.string(), start: z.number(), end: z.number(), durationBasis: z.string(), reason: z.string() });
const scheduleSchema = z.object({ kind: z.literal("schedule"), planId: z.string(), entries: z.array(scheduleEntrySchema),
  conflicts: z.array(z.string()), provisional: z.boolean(), moves: z.number(), days: z.number(), explanation: z.string() });
const requirementDataSchema = requirementSchema.safeExtend({ kind: z.literal("requirement"), locationId: z.string() });
const costDataSchema = z.object({ kind: z.literal("cost"), locationId: z.string(), items: z.array(costSchema) });
const packetSchema = z.object({ kind: z.literal("packet"), planId: z.string(), assetId: z.string(),
  filename: z.string(), manifestAssetId: z.string().optional(), builtAt: z.number(), unresolved: z.array(z.string()),
  documentStatus: z.literal("draft"), externalStatus: z.literal("not_submitted") });
const noteSchema = z.object({ kind: z.literal("note"), text: z.string().max(10000) });
export const entitySchema = z.discriminatedUnion("kind", [scriptSchema, sceneSchema, questionSchema, answerSchema,
  locationSchema, planSchema, scheduleSchema, requirementDataSchema, costDataSchema, packetSchema, noteSchema]);
export type EntityData = z.infer<typeof entitySchema>;
export type EntityKind = EntityData["kind"];
export type SceneData = z.infer<typeof sceneSchema>;
export type PlanData = z.infer<typeof planSchema>;
export type LocationData = z.infer<typeof locationSchema>;
export type QuestionData = z.infer<typeof questionSchema>;
export type ScheduleData = z.infer<typeof scheduleSchema>;
export type Choice = z.infer<typeof choiceSchema>;
export type Entity = { _id: string; boardId: string; data: EntityData; scope: Scope; ownerId?: string;
  revision: number; stale: boolean; createdAt: number; updatedAt: number; updatedBy: string; logicalKey: string };
export type CanvasNode = { _id: string; entityId: string; x: number; y: number; width: number; height: number;
  geometryRevision: number; manual: boolean; parentId?: string };
export type CanvasEdge = { _id: string; sourceId: string; targetId: string; relation: string };
export type BoardRun = { _id: string; kind: TaskKind; status: RunStatus; activity: string; error?: string;
  scope: Scope; targetId?: string; createdAt: number; updatedAt: number };
export type BoardSnapshot = { board: { _id: string; name: string; ownerId: string; archived: boolean };
  role: Role; entities: Entity[]; nodes: CanvasNode[]; edges: CanvasEdge[]; choices: (Choice & {planId:string;revision:number})[];
  runs: BoardRun[]; me: { _id: string; name: string; avatar?: string } };
export const stateLabel = { queued: "Queued", running: "Working", waiting: "Needs your answer", complete: "Complete",
  failed: "Failed", cancelled: "Cancelled", superseded: "Needs refresh" } satisfies Record<RunStatus,string>;
