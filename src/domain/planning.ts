import type { Cost, Entity, PlanData, SceneData, ScheduleData } from "./model";

export function summarizeCosts(items: Cost[], currency: string, cap: number | null) {
  const unique = new Map<string, Cost>();
  const conflicts: string[] = [];
  for (const item of items) {
    const previous = unique.get(item.coverageKey);
    if (previous && JSON.stringify([previous.amountMinor, previous.quantity, previous.currency, previous.unit, previous.basis]) !==
      JSON.stringify([item.amountMinor, item.quantity, item.currency, item.unit, item.basis])) {
      conflicts.push(`Conflicting cost evidence for ${item.label}`);
    }
    if (!previous) unique.set(item.coverageKey, item);
  }
  let known = 0, estimated = 0;
  const unknown: string[] = [], otherCurrencies: string[] = [];
  for (const cost of unique.values()) {
    if (cost.currency !== currency) { otherCurrencies.push(`${cost.label} (${cost.currency})`); continue; }
    if (cost.amountMinor === null) { unknown.push(cost.label); continue; }
    const amount = Math.round(cost.amountMinor * cost.quantity);
    if (cost.basis === "estimate") estimated += amount;
    else known += amount;
  }
  const partial = known + estimated;
  const completeness = unknown.length === 0 && otherCurrencies.length === 0 && conflicts.length === 0;
  const budgetStatus = cap === null ? "uncapped" : partial > cap ? "over" : !completeness ? "unconfirmed" : estimated > 0 ? "estimated_within" : "within";
  return { known, estimated, partial, unknown, otherCurrencies, conflicts, budgetStatus, items: [...unique.values()] };
}

export function affectedIds(input: string, dependencies: { sourceId: string; targetId: string }[]) {
  const result = new Set<string>(); const queue = [input];
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of dependencies) if (edge.sourceId === current && edge.targetId !== input && !result.has(edge.targetId)) {
      result.add(edge.targetId); queue.push(edge.targetId);
    }
  }
  return [...result];
}

export type ScheduleInput = { id: string; data: SceneData; locationId: string; locationName: string; locationWindowsVerified?: boolean };
export function proposeSchedule(planId: string, plan: PlanData, scenes: ScheduleInput[]): ScheduleData {
  const conflicts: string[] = [];
  const supportedHardRules = new Set(["shootingDates", "dates", "dayStart", "dayEnd", "maxMoves"]);
  for (const rule of plan.rules) if (rule.strength === "hard" && !supportedHardRules.has(rule.field))
    conflicts.push(`Hard constraint “${rule.field}” is not represented by the scheduler. Resolve it before planning.`);
  if (!scenes.length) conflicts.push("Select a location for every scene before planning.");
  if (!plan.dates.length) conflicts.push("Confirm shooting dates.");
  if (plan.dayEnd <= plan.dayStart) conflicts.push("Shooting hours must end after they start. Split overnight work across dates.");
  if (plan.moveMinutes === null) conflicts.push("Supply or approve estimated location-move time.");
  if (plan.setupMinutes === null) conflicts.push("Supply or approve estimated setup time.");
  for (const scene of scenes) {
    if (scene.data.durationMinutes === null) conflicts.push(`Scene ${scene.data.number}: supply or approve a duration.`);
    if (!scene.data.windows.length) conflicts.push(`Scene ${scene.data.number}: confirm an allowed time window, including day/night needs.`);
  }
  const base: ScheduleData = { kind: "schedule", planId, entries: [], conflicts, provisional: true, moves: 0, days: 0,
    explanation: "Proposed order. Location availability and permission remain unverified." };
  if (conflicts.length) return base;
  const ordered = [...scenes].sort((a,b) => {
    const width = (s: ScheduleInput) => Math.min(...s.data.windows.map(w=>w.end-w.start));
    return width(a)-width(b) || a.locationId.localeCompare(b.locationId) || a.data.number-b.data.number;
  });
  const remaining = new Map(ordered.map(s=>[s.id,s]));
  for (const date of [...new Set(plan.dates)].sort()) {
    let cursor = plan.dayStart; let previousLocation = "";
    while (remaining.size) {
      const options = [...remaining.values()].flatMap(scene => {
        const move = previousLocation && previousLocation !== scene.locationId ? plan.moveMinutes! : 0;
        const setup = previousLocation === scene.locationId ? 0 : plan.setupMinutes!;
        return scene.data.windows.filter(w=>w.date===date).map(w=>({scene,start:Math.max(cursor+move+setup,w.start),limit:Math.min(w.end,plan.dayEnd),move}));
      }).filter(o=>o.start+o.scene.data.durationMinutes!<=o.limit);
      options.sort((a,b) => {
        const grouping = (plan.priority === "moves" || plan.priority === "cost") ? Number(a.scene.locationId!==previousLocation)-Number(b.scene.locationId!==previousLocation) : 0;
        return grouping || a.limit-b.limit || a.start-b.start || a.scene.data.number-b.scene.data.number;
      });
      const next=options[0]; if(!next) break;
      const end=next.start+next.scene.data.durationMinutes!;
      base.entries.push({sceneId:next.scene.id,sceneNumber:next.scene.data.number,locationId:next.scene.locationId,
        locationName:next.scene.locationName,date,start:next.start,end,durationBasis:next.scene.data.durationBasis,
        reason:previousLocation===next.scene.locationId?"Shares selected location; avoids another move.":"Fits the confirmed scene window and shooting hours."});
      if(previousLocation && previousLocation!==next.scene.locationId) base.moves++;
      previousLocation=next.scene.locationId; cursor=end; remaining.delete(next.scene.id);
    }
  }
  for(const scene of remaining.values()) base.conflicts.push(`Scene ${scene.data.number} does not fit. Add dates, revise a time window, or review durations.`);
  base.days=new Set(base.entries.map(e=>e.date)).size;
  const maxMoves=plan.rules.find(r=>r.strength==="hard"&&r.field==="maxMoves"&&typeof r.value==="number");
  const maxMoveValue=maxMoves?.value;
  if(typeof maxMoveValue==="number"&&base.moves>maxMoveValue)base.conflicts.push(`Proposed order requires ${base.moves} moves; hard limit is ${maxMoveValue}.`);
  return base;
}

export function collectFacts(entities: Entity[], sceneId?: string, planId?: string) {
  const questions = entities.filter(e=>e.data.kind==="question" && e.data.resolution!=="open" && !e.stale);
  const relevant = questions.filter(e=>e.scope.kind==="workspace" ||
    (e.scope.kind==="scene" && e.scope.sceneId===sceneId) || (e.scope.kind==="plan" && e.scope.planId===planId) ||
    (e.scope.kind==="plan_scene" && e.scope.sceneId===sceneId && e.scope.planId===planId));
  return relevant.sort((a,b)=>Number(a.scope.kind!=="workspace")-Number(b.scope.kind!=="workspace"));
}
export function formatMoney(minor: number, currency="USD") {
  return new Intl.NumberFormat("en-US",{style:"currency",currency}).format(minor/100);
}
export function formatTime(minutes:number) { return `${String(Math.floor(minutes/60)).padStart(2,"0")}:${String(minutes%60).padStart(2,"0")}`; }
