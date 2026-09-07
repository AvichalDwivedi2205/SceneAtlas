import fs from "node:fs";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { loadEnvFile } from "node:process";
import { clerk, clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { createHash } from "node:crypto";

loadEnvFile(".env.local");
const baseUrl = process.env.DEMO_URL ?? "https://sceneatlas-black.vercel.app";
if (!baseUrl) throw new Error("DEMO_URL is required");

const outDir = path.resolve(process.env.DEMO_OUTPUT_DIR ?? "artifacts/demo-video/raw");
const pauseScale = Number(process.env.DEMO_PAUSE_SCALE ?? "1");
const shouldRecord = process.env.DEMO_RECORD !== "0";
const storageState = process.env.DEMO_STORAGE_STATE;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms * pauseScale));
const privateDir = process.env.DEMO_PRIVATE_DIR ?? "/tmp/sceneatlas-demo-private";
fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
const pass = process.env.DEMO_PASS ?? "rehearsal";
const reportPath = path.resolve(outDir, `${pass}-evidence.json`);
const report = { pass, recording: shouldRecord, startedAt: new Date().toISOString(), url: baseUrl, segments: [], runs: [], boards: [], errors: [] };
const starts = new WeakMap();
const names = new WeakMap();
const writeReport = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
async function take(page, id, fn) {
  const segment = { id, page: names.get(page), start: (performance.now() - starts.get(page)) / 1000 };
  await fn();
  segment.end = (performance.now() - starts.get(page)) / 1000;
  report.segments.push(segment);
  writeReport();
  console.log(`Shot ready: ${id}`);
}
const titleFor = (entity) => {
  const d = entity.data;
  return ({ script: d.filename, scene: `Scene ${d.number} · ${d.setting}`, question: d.resolution === "answered" ? "Decision saved" : "A decision to make", plan: d.name, location: d.name, note: "Production note" })[d.kind];
};
async function closePanels(page) {
  for (const label of ["Close details", "Close dialog", "Close panel"]) {
    const button = page.getByRole("button", { name: label, exact: true });
    if (await button.isVisible()) {
      await click(page, button);
      await expect(button).not.toBeVisible();
    }
  }
}
async function focus(page, entity) {
  await closePanels(page);
  await click(page, page.getByRole("button", { name: "Find a card", exact: true }));
  await page.getByLabel("Search board", { exact: true }).fill(entity.kind === "question" ? entity.data.prompt : titleFor(entity));
  const result = page.locator(".search-results button").filter({ hasText: titleFor(entity) });
  await click(page, result.first());
  const card = page.locator(`.react-flow__node[data-id="${entity._id}"]`);
  await expect(card).toBeInViewport();
  await wait(650);
  return card;
}
async function inspect(page, entity) {
  const card = await focus(page, entity);
  await click(page, card.getByRole("button", { name: `Inspect ${titleFor(entity)}`, exact: true }));
  await expect(page.getByRole("dialog")).toBeVisible();
}
async function edit(page, entity, fill) {
  await inspect(page, entity);
  const label = entity.kind === "question" ? "Edit answer" : entity.kind === "plan" ? "Edit plan settings" : "Edit scene settings";
  await click(page, page.getByRole("button", { name: label, exact: true }));
  await fill(page.getByRole("dialog"));
  await click(page, page.getByRole("button", { name: "Review change", exact: true }));
  await expect(page.getByRole("button", { name: "Confirm input change", exact: true })).toBeVisible();
  await wait(750);
  await click(page, page.getByRole("button", { name: "Confirm input change", exact: true }));
  await expect(page.getByRole("button", { name: "Confirm input change", exact: true })).not.toBeVisible();
}

let backend, client, actors, tokenTime = 0;
async function refresh() {
  if (Date.now() - tokenTime > 40_000) {
    client.setAuth((await backend.sessions.getToken(actors.sessionId, "convex")).jwt);
    tokenTime = Date.now();
  }
}
async function snapshot(boardId) {
  await refresh();
  const value = await client.query(api.boards.snapshot, { boardId });
  fs.writeFileSync(path.join(privateDir, `${boardId}.json`), JSON.stringify(value), { mode: 0o600 });
  return value;
}
async function createBoard(page, name) {
  await gotoAndSettle(page, `${baseUrl}/workspaces`);
  await click(page, page.getByRole("button", { name: "New workspace", exact: true }));
  await page.getByLabel("Production name", { exact: true }).fill(name);
  await click(page, page.getByRole("button", { name: "Create and open", exact: true }));
  await expect(page.getByRole("heading", { name: "Bring your story to the board." })).toBeVisible();
  const id = new URL(page.url()).pathname.split("/").at(-1);
  report.boards.push(id);
  actors.boards ??= [];
  actors.boards.push(id);
  fs.writeFileSync(path.join(privateDir, "actors.json"), JSON.stringify(actors), { mode: 0o600 });
  return id;
}
async function newestRun(boardId, kind, after = 0, targetId) {
  let result;
  await expect.poll(async () => {
    result = (await snapshot(boardId)).runs.find(r => r.kind === kind && r.createdAt >= after && (!targetId || r.targetId === targetId));
    return Boolean(result);
  }, { timeout: 45_000 }).toBe(true);
  return result;
}
function checkpointAnswer(q) {
  const { key, prompt } = q.data;
  if (key === "clarify_rock_formation_flexibility") return "For this illustrative scene, prioritize sourced rock formations. Return fewer candidates if needed. Unverified features remain unverified.";
  if (key === "monitor_required") return "Monitor assignment remains unknown; the authority must confirm it. For this illustrative draft, budget one monitor's published minimum as a producer-approved contingency estimate. Do not assume a monitor is required or waived.";
  if (/availability|permission/i.test(key)) return "Proceed with a provisional preparation draft for our requested date. Location availability and external permission remain unverified. We have not secured access or approval; do not state otherwise. Confirmation is required before booking or filming.";
  if (/budget.*monitor|monitor.*budget/i.test(prompt)) return "For this illustrative production, budget one monitor's published minimum as a producer-approved contingency estimate. Actual monitoring requirements remain unverified; no waiver or approval assumed.";
  if (key.startsWith("permit_lead_time_conflict_")) return "Use ten business days as our internal planning buffer. Preserve both official source statements; this is not a determination of the authority's deadline or an approval.";
  if (key.startsWith("fire_requirements_confirmation_")) return "Confirmed for this illustrative production: no open flames, pyrotechnics, fire effects, special effects, generators or special lighting.";
  if (/reservation.*fee/i.test(key) && /unknown|not published|unpublished/i.test(prompt)) return "Proceed with this preparation draft with reservation fee unknown and unquoted. Do not invent an amount. Obtain an actual quote before booking.";
  throw new Error(`Unplanned producer question ${key}: ${prompt}`);
}
async function waitRun(page, boardId, initial, { answerQuestions = true } = {}) {
  let runId = initial._id, activity = "", checkpoints = 0;
  const began = Date.now();
  for (;;) {
    const state = await snapshot(boardId);
    const run = state.runs.find(r => r._id === runId);
    if (!run) throw new Error(`Missing run ${runId}`);
    if (run.activity !== activity) {
      console.log(`${names.get(page)} ${run.kind}: ${run.activity}`);
      activity = run.activity;
    }
    if (run.status === "complete") {
      await refresh();
      const events = await client.query(api.runs.events, { runId });
      report.runs.push({ id: runId, kind: run.kind, boardId, elapsedSeconds: (Date.now() - initial.createdAt) / 1000, events: events.map(e => ({ activity: e.activity, providerId: e.providerId })) });
      writeReport();
      return state;
    }
    if (run.status === "waiting" && answerQuestions && checkpoints < 6) {
      const questions = state.entities.filter(e => e.kind === "question" && e.data.resolution === "open" && e.data.blocks.includes(run.kind));
      if (!questions.length) throw new Error("Waiting without a visible question");
      for (const question of questions) {
        const answer = checkpointAnswer(question);
        await edit(page, question, async dialog => dialog.getByLabel("Your answer", { exact: true }).fill(answer));
      }
      await closePanels(page);
      runId = (await newestRun(boardId, run.kind, run.createdAt + 1, run.targetId))._id;
      checkpoints++;
      continue;
    }
    if (["failed", "cancelled", "superseded", "waiting"].includes(run.status)) throw new Error(`${run.kind}: ${run.status}: ${run.error ?? run.activity}`);
    if (Date.now() - began > 1_300_000) throw new Error(`Timed out ${run.kind}`);
    await page.waitForTimeout(3000);
  }
}
async function question(page, boardId, key, answer) {
  const q = (await snapshot(boardId)).entities.find(e => e.kind === "question" && e.data.key === key);
  if (!q) throw new Error(`No ${key} question`);
  await edit(page, q, async dialog => dialog.getByLabel("Your answer", { exact: true }).fill(answer));
  await expect.poll(async () => (await snapshot(boardId)).entities.find(e => e._id === q._id).data.answer).toBe(answer);
  await closePanels(page);
}
async function startOnCard(page, boardId, entity, button, kind) {
  const card = await focus(page, entity);
  const after = Date.now() - 1000;
  await click(page, card.getByRole("button", { name: button, exact: true }));
  return newestRun(boardId, kind, after, entity._id);
}

async function ensureCursor(page) {
  await page.evaluate(() => {
    let cursor = document.querySelector("[data-demo-cursor]");
    if (cursor) return;
    cursor = document.createElement("div");
    cursor.dataset.demoCursor = "true";
    Object.assign(cursor.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "26px",
      height: "26px",
      borderRadius: "50%",
      border: "2px solid rgba(255,255,255,.96)",
      background: "rgba(244,186,66,.35)",
      boxShadow: "0 0 0 5px rgba(244,186,66,.18),0 12px 28px rgba(0,0,0,.45)",
      transform: "translate(100px,100px)",
      transition: "transform 360ms cubic-bezier(.2,.8,.2,1),box-shadow 160ms ease",
      zIndex: "2147483647",
      pointerEvents: "none",
    });
    document.body.appendChild(cursor);
  });
}

async function moveCursor(page, x, y) {
  await ensureCursor(page);
  await page.evaluate(({ x, y }) => {
    const cursor = document.querySelector("[data-demo-cursor]");
    if (cursor) cursor.style.transform = `translate(${x - 13}px,${y - 13}px)`;
  }, { x, y });
  await page.mouse.move(x, y, { steps: 18 });
  await wait(260);
}

async function pulse(page) {
  await page.evaluate(() => {
    const cursor = document.querySelector("[data-demo-cursor]");
    if (!cursor) return;
    const original = cursor.style.boxShadow;
    cursor.style.boxShadow = "0 0 0 11px rgba(244,186,66,.18),0 12px 28px rgba(0,0,0,.45)";
    setTimeout(() => { cursor.style.boxShadow = original; }, 220);
  });
}

async function pointAt(page, locator, options = {}) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`No box for ${options.label ?? "required locator"}`);
  const x = box.x + box.width * (options.xRatio ?? 0.5);
  const y = box.y + box.height * (options.yRatio ?? 0.5);
  await moveCursor(page, x, y);
  await pulse(page);
  await wait(options.after ?? 700);
  return { x, y };
}

async function click(page, locator, options = {}) {
  await pointAt(page, locator, { ...options, after: 250 });
  // Resolve again after the cursor moves: canvas focus and modal transitions
  // can change the element's position during a fast rehearsal.
  await locator.click();
  await pulse(page);
  await wait(options.afterClick ?? 1000);
}

async function gotoAndSettle(page, url) {
  await page.goto(url, { waitUntil: "load", timeout: 45000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await ensureCursor(page);
}

async function runScale(page) {
  const pdf = process.env.DEMO_PDF ?? "/tmp/sceneatlas-big-fish.pdf";
  const expected = JSON.parse(fs.readFileSync(process.env.DEMO_EXPECTED ?? "/tmp/sceneatlas-big-fish-expected.json", "utf8"));
  const boardId = await createBoard(page, "Feature screenplay · scale demonstration");
  let ingest;
  await take(page, "scale-upload", async () => {
    await wait(2000);
    await click(page, page.getByRole("button", { name: "Add your screenplay", exact: true }));
    await wait(1800);
    await pointAt(page, page.getByRole("button", { name: /Drop your screenplay here/ }), { after: 1000 });
    await page.locator('input[type="file"]').setInputFiles(pdf);
    await expect(page.locator(".board-progress")).toContainText(/Uploading|received|queued|Reading/);
    ingest = await newestRun(boardId, "ingest");
    await wait(3000);
  });
  let state = await waitRun(page, boardId, ingest, { answerQuestions: false });
  const script = state.entities.find(e => e.kind === "script");
  expect(script.data.pageCount).toBe(expected.pages);
  expect(script.data.sceneCount).toBe(expected.sceneCount);
  await take(page, "scale-confirm-scope", async () => {
    await question(page, boardId, "scene_scope", "Entire screenplay");
    await wait(2000);
  });
  let breakdown;
  await take(page, "scale-breakdown-start", async () => {
    breakdown = await startOnCard(page, boardId, script, "Generate scenes", "scenes");
    await expect(page.locator(".board-progress")).toContainText(/queued|Generating scene groups/);
    await wait(4000);
  });
  state = await waitRun(page, boardId, breakdown, { answerQuestions: false });
  const scenes = state.entities.filter(e => e.kind === "scene").sort((a, b) => a.data.number - b.data.number);
  expect(scenes).toHaveLength(expected.sceneCount);
  for (const [i, scene] of scenes.entries()) expect(scene.data).toMatchObject(expected.scenes[i]);
  expect(scenes.at(-1).data.pageEnd).toBe(expected.pages);
  report.scale = { boardId, pages: expected.pages, scenes: scenes.length, verifiedSourceInventory: true };
  await take(page, "scale-wide", async () => {
    await closePanels(page);
    await click(page, page.getByRole("button", { name: "Fit board", exact: true }));
    await wait(9000);
  });
  await take(page, "scale-count", async () => {
    const card = await focus(page, script);
    await expect(card).toContainText(`${expected.pages} pages · ${expected.sceneCount} scenes`);
    await wait(5500);
  });
  await take(page, "scale-last-scene", async () => {
    const button = page.getByRole("navigation", { name: "Scene navigation" }).getByRole("button", { name: String(expected.sceneCount), exact: true });
    await click(page, button);
    await expect(page.locator(`.react-flow__node[data-id="${scenes.at(-1)._id}"]`)).toBeInViewport();
    await wait(5000);
  });
  await page.screenshot({ path: path.join(outDir, `${pass}-scale.png`) });
}

const originalScene = `COASTAL REHEARSAL\nOriginal demonstration screenplay by SceneAtlas.\n\nEXT. CALIFORNIA BEACH - DAY\nMARA stands on open sand, studying a folded trail map. The ocean rolls gently behind her.\nShe turns toward a low rock formation. No other people are present.\nMARA\nThe path must start here.\nShe walks to the rocks and sits.\nFADE OUT.`;

async function runDemo(page, editor) {
  const boardId = await createBoard(page, "Coastal Rehearsal · production planning");
  await click(page, page.getByRole("button", { name: "Add your screenplay", exact: true }));
  await page.getByLabel("Screenplay filename").fill("coastal-rehearsal.txt");
  await page.getByLabel("Screenplay text").fill(originalScene);
  await click(page, page.getByRole("button", { name: "Read screenplay", exact: true }));
  let state = await waitRun(page, boardId, await newestRun(boardId, "ingest"));
  await question(page, boardId, "search_area", "Los Angeles County, California, within 60 miles of Los Angeles. California state beaches preferred. Open sand, ocean and low rocks.");
  await take(page, "producer-input", async () => {
    await question(page, boardId, "production_activities", "Four people including cast, one handheld camera. No drones, stunts, vehicles, closures, generators or special lighting.");
    await wait(1500);
  });
  await question(page, boardId, "scene_scope", "Entire screenplay");
  const script = (await snapshot(boardId)).entities.find(e => e.kind === "script");
  state = await waitRun(page, boardId, await startOnCard(page, boardId, script, "Generate scenes", "scenes"));
  expect(state.entities.filter(e => e.kind === "scene")).toHaveLength(1);
  let scene = state.entities.find(e => e.kind === "scene");
  let plan = state.entities.find(e => e.kind === "plan" && e.data.name === "Budget plan");
  await edit(page, scene, async dialog => {
    await dialog.getByLabel("Shooting duration, minutes", { exact: true }).fill("60");
    await dialog.getByLabel("Duration basis").selectOption("estimate");
    await dialog.getByRole("button", { name: "Add window", exact: true }).click();
    await dialog.getByLabel("Window 1 date", { exact: true }).fill("2026-11-16");
    await dialog.getByLabel("Window 1 start", { exact: true }).fill("08:00");
    await dialog.getByLabel("Window 1 end", { exact: true }).fill("18:00");
  });
  await edit(page, plan, async dialog => {
    await dialog.getByLabel("Whole-plan budget", { exact: true }).fill("2000");
    await dialog.getByLabel("Shooting dates, comma-separated", { exact: true }).fill("2026-11-16");
    await dialog.getByLabel("Move time, minutes", { exact: true }).fill("30");
    await dialog.getByLabel("Setup time, minutes", { exact: true }).fill("15");
    await dialog.getByLabel("Move/setup basis").selectOption("estimate");
    await dialog.getByLabel("Describe your ideal shoot", { exact: true }).fill("Illustrative production: create a provisional preparation draft using the producer-approved timing estimates. Location availability, fees and external permissions remain unverified. Proceed with provisional scheduling; no booking or filming authorization is claimed.");
  });
  state = await snapshot(boardId);
  scene = state.entities.find(e => e._id === scene._id);
  let research;
  await take(page, "research-start", async () => {
    research = await startOnCard(page, boardId, scene, "Find locations", "research");
    await expect(page.locator(".board-progress")).toContainText(/queued|Searching locations/);
    await wait(5000);
  });
  state = await waitRun(page, boardId, research);
  const locations = state.entities.filter(e => e.kind === "location");
  expect(locations.length).toBeGreaterThan(0);
  expect(locations.length).toBeLessThanOrEqual(3);
  let location = locations.find(e => /leo carrillo/i.test(e.data.name)) ?? locations[0];
  expect(location.data.sources.length).toBeGreaterThan(0);
  expect(location.data.availability).toBe("unverified");
  await take(page, "location-result", async () => {
    await focus(page, location);
    await wait(7000);
  });
  await take(page, "location-evidence", async () => {
    await inspect(page, location);
    await wait(2000);
    await pointAt(page, page.getByRole("heading", { name: "Where this came from", exact: true }), { after: 6500 });
  });
  await closePanels(page);
  await page.getByLabel("Active plan", { exact: true }).selectOption(plan._id);
  await take(page, "location-lock", async () => {
    const card = await focus(page, location);
    await click(page, card.getByRole("button", { name: /^Scene 1\s*Select$/ }));
    await click(page, card.getByRole("button", { name: /^Scene 1\s*Selected · lock$/ }));
    await expect(card.getByRole("button", { name: /^Scene 1\s*Locked$/ })).toBeVisible();
    await wait(3500);
  });
  // Location research already includes its sourced requirements and unknowns.
  let after;
  state = await snapshot(boardId);
  location = state.entities.find(e => e._id === location._id);
  plan = state.entities.find(e => e._id === plan._id);
  state = await waitRun(page, boardId, await startOnCard(page, boardId, plan, "Plan schedule", "schedule"));
  const before = state.entities.find(e => e.kind === "schedule" && e.data.planId === plan._id);
  expect(before.data.entries).toHaveLength(1);
  expect(before.data.provisional).toBe(true);
  await take(page, "schedule-before", async () => {
    await closePanels(page);
    await click(page, page.getByRole("button", { name: "Schedule", exact: true }));
    await wait(7000);
  });
  await click(page, page.getByRole("button", { name: "Canvas", exact: true }));
  plan = (await snapshot(boardId)).entities.find(e => e._id === plan._id);
  await take(page, "revision-input", async () => {
    await edit(page, plan, async dialog => {
      const input = dialog.getByLabel("Day starts", { exact: true });
      await pointAt(page, input);
      await input.fill("09:00");
      await wait(1800);
    });
    await expect(page.getByRole("button", { name: "Regenerate affected outputs", exact: true })).toBeVisible();
    await wait(2500);
  });
  after = Date.now() - 1000;
  await take(page, "revision-regenerate", async () => {
    await click(page, page.getByRole("button", { name: "Regenerate affected outputs", exact: true }));
    await wait(3000);
  });
  await waitRun(page, boardId, await newestRun(boardId, "schedule", after, plan._id));
  await take(page, "revision-apply", async () => {
    await expect(page.getByRole("button", { name: "Apply revised results", exact: true })).toBeVisible({ timeout: 45_000 });
    await click(page, page.getByRole("button", { name: "Apply revised results", exact: true }));
    await wait(1500);
    await closePanels(page);
    await click(page, page.getByRole("button", { name: "Schedule", exact: true }));
    await wait(6500);
  });
  state = await snapshot(boardId);
  const revised = state.entities.find(e => e._id === before._id);
  expect(revised.revision).toBeGreaterThan(before.revision);
  expect(revised.data.entries[0].start).toBeGreaterThanOrEqual(540);
  expect(revised.data.entries[0].start).toBeGreaterThan(before.data.entries[0].start);
  expect(state.choices.find(c => c.planId === plan._id)).toMatchObject({ locationId: location._id, locked: true });
  expect(state.entities.find(e => e.kind === "question" && e.data.key === "production_activities").data.answer).toContain("Four people");
  report.revision = { changed: "Budget plan starts at 09:00", before: before.data.entries, after: revised.data.entries, lockedChoicePreserved: true, answerPreserved: true };
  await click(page, page.getByRole("button", { name: "Canvas", exact: true }));
  // Prepare the second person's access before the collaboration clip.
  await click(page, page.getByRole("button", { name: "Share", exact: true }));
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email address", { exact: true }).fill(actors.editor.email);
  await dialog.getByLabel("Access").selectOption("editor");
  await click(page, dialog.getByRole("button", { name: "Create invite link", exact: true }));
  await editor.goto(await dialog.getByLabel("Invitation link", { exact: true }).inputValue());
  await click(editor, editor.getByRole("button", { name: "Accept invitation", exact: true }));
  await closePanels(page);
  await expect(page.locator(".people-stack .avatar")).toHaveCount(2);
  const stageNote = "Location scout: keep the selected beach. Confirm access with the authority before filming.";
  await click(editor, editor.getByRole("button", { name: "Add production note", exact: true }));
  await editor.getByLabel("Production note", { exact: true }).fill(stageNote);
  await click(editor, editor.getByRole("button", { name: "Add note", exact: true }));
  let note;
  await expect.poll(async () => {
    note = (await snapshot(boardId)).entities.find(e => e.kind === "note" && e.data.text === stageNote);
    return Boolean(note);
  }).toBe(true);
  await focus(page, note);
  await focus(editor, note);
  // Pan the editor's canvas so their next note lands below the first one.
  await editor.mouse.move(1200, 800);
  await editor.mouse.down({ button: "middle" });
  await editor.mouse.move(1200, 560, { steps: 18 });
  await editor.mouse.up({ button: "middle" });
  await take(page, "collaboration", async () => {
    await click(editor, editor.getByRole("button", { name: "Add production note", exact: true }));
    await editor.getByLabel("Production note", { exact: true }).fill("Producer update: 09:00 start confirmed for this demonstration. Ready to review the preparation packet.");
    await click(editor, editor.getByRole("button", { name: "Add note", exact: true }));
    await expect.poll(async () => (await snapshot(boardId)).entities.filter(e => e.kind === "note").length).toBe(2);
    await expect(page.locator(".flow-surface")).toHaveAttribute("data-node-count", String((await snapshot(boardId)).nodes.length));
    await expect(page.locator(".production-card.type-note").filter({ hasText: "Producer update: 09:00 start confirmed" })).toBeInViewport();
    await wait(9000);
  });
  await take(page, "packet-start", async () => {
    await click(page, page.getByRole("button", { name: "Preparation packet", exact: true }));
    after = Date.now() - 1000;
    await click(page, page.getByRole("button", { name: "Prepare packet", exact: true }));
    await wait(3500);
  });
  state = await waitRun(page, boardId, await newestRun(boardId, "packet", after, plan._id));
  const packet = state.entities.find(e => e.kind === "packet" && e.data.planId === plan._id);
  expect(packet.data.externalStatus).toBe("not_submitted");
  await closePanels(page);
  await click(page, page.getByRole("button", { name: "Preparation packet", exact: true }));
  await take(page, "packet-download", async () => {
    await wait(4000);
    const downloadPending = page.waitForEvent("download");
    await click(page, page.getByRole("button", { name: "Download PDF", exact: true }));
    const download = await downloadPending;
    expect(await download.failure()).toBeNull();
    await download.saveAs(path.join(outDir, `${pass}-preparation-packet.pdf`));
    await wait(6000);
  });
  await page.screenshot({ path: path.join(outDir, `${pass}-packet.png`) });
  report.focus = { boardId, sceneId: scene._id, locationId: location._id, packetId: packet._id, sources: location.data.sources.map(s => ({ title: s.title, url: s.url, provider: s.provider, searchId: s.searchId })), twoPeople: true };
  await closePanels(page);
  await click(page, page.getByRole("button", { name: "Canvas", exact: true }));
  await take(page, "focused-canvas", async () => {
    await click(page, page.getByRole("button", { name: "Fit board", exact: true }));
    await wait(7500);
  });
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  if (!process.env.CLERK_SECRET_KEY?.startsWith("sk_test_")) throw new Error("Demo actors require Clerk development credentials.");
  backend = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL);
  await clerkSetup({ dotenv: false });
  const actorPath = path.join(privateDir, "actors.json");
  if (fs.existsSync(actorPath)) actors = JSON.parse(fs.readFileSync(actorPath, "utf8"));
  else {
    actors = { boards: [] };
    for (const role of ["owner", "editor"]) {
      const email = `sceneatlas-demo-${role}-${Date.now()}+clerk_test@example.com`;
      const user = await backend.users.createUser({ emailAddress: [email], firstName: role === "owner" ? "Demo Producer" : "Location Scout", skipPasswordRequirement: true });
      actors[role] = { id: user.id, email };
    }
    actors.sessionId = (await backend.sessions.createSession({ userId: actors.owner.id })).id;
    fs.writeFileSync(actorPath, JSON.stringify(actors), { mode: 0o600 });
  }
  if (process.argv.includes("--cleanup")) {
    for (const boardId of actors.boards) {
      const state = await snapshot(boardId);
      for (const run of state.runs.filter(r => ["queued", "running", "waiting"].includes(r.status))) await client.mutation(api.runs.cancel, { runId: run._id });
      await client.mutation(api.boards.archive, { boardId, archived: true });
    }
    await backend.users.deleteUser(actors.owner.id);
    await backend.users.deleteUser(actors.editor.id);
    fs.rmSync(actorPath);
    console.log("Demo boards archived; disposable actors removed.");
    return;
  }
  const fullPass = process.env.DEMO_SCALE !== "0" && process.env.DEMO_FOCUS !== "0";
  const fingerprint = createHash("sha256").update(fs.readFileSync(new URL(import.meta.url))).update(fs.readFileSync(process.env.DEMO_PDF ?? "/tmp/sceneatlas-big-fish.pdf")).digest("hex");
  const rehearsalPath = path.join(privateDir, "rehearsals.json");
  let rehearsals = fs.existsSync(rehearsalPath) ? JSON.parse(fs.readFileSync(rehearsalPath, "utf8")) : { fingerprint, passes: [] };
  if (rehearsals.fingerprint !== fingerprint) rehearsals = { fingerprint, passes: [] };
  if (shouldRecord && (!fullPass || rehearsals.passes.length < 2)) throw new Error("Complete two full successful dry passes of this recorder before capture.");
  const browser = await chromium.launch({ headless: true });
  const contexts = [], pages = [];
  try {
    for (const role of ["owner", "editor"]) {
      const authContext = await browser.newContext();
      const authPage = await authContext.newPage();
      await authPage.goto(baseUrl);
      await clerk.signIn({ page: authPage, emailAddress: actors[role].email });
      await authPage.goto(`${baseUrl}/workspaces`);
      await expect(authPage.getByRole("button", { name: "New workspace", exact: true })).toBeVisible();
      await authPage.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      await authContext.storageState({ path: path.join(privateDir, `${role}.json`) });
      fs.chmodSync(path.join(privateDir, `${role}.json`), 0o600);
      await authContext.close();
    }
    async function surface(name, role) {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, storageState: role === "owner" && storageState ? storageState : path.join(privateDir, `${role}.json`), ...(shouldRecord ? { recordVideo: { dir: outDir, size: { width: 1920, height: 1080 } } } : {}) });
      await setupClerkTestingToken({ context });
      contexts.push(context);
      const page = await context.newPage();
      starts.set(page, performance.now());
      names.set(page, name);
      pages.push(page);
      page.setDefaultTimeout(30_000);
      page.on("pageerror", e => report.errors.push(e.message));
      return page;
    }
    const work = [];
    async function observed(page, task) {
      try { return await task; }
      catch (error) {
        console.error(`${names.get(page)} path failed: ${error.message.split("\n")[0]}`);
        await page.screenshot({ path: path.join(outDir, `${pass}-${names.get(page)}-failure.png`) }).catch(() => {});
        throw error;
      }
    }
    if (process.env.DEMO_SCALE !== "0") {
      const page = await surface("scale", "owner");
      work.push(observed(page, runScale(page)));
    }
    if (process.env.DEMO_FOCUS !== "0") {
      const editor = await surface("editor", "editor");
      const page = await surface("focus", "owner");
      work.push(observed(page, runDemo(page, editor)));
    }
    const results = await Promise.allSettled(work);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    expect(report.errors).toEqual([]);
    report.status = "passed";
    if (!shouldRecord && fullPass) {
      rehearsals.passes.push({ pass, completedAt: new Date().toISOString() });
      fs.writeFileSync(rehearsalPath, JSON.stringify(rehearsals, null, 2), { mode: 0o600 });
    }
    console.log(`Full recording path passed: ${pass}`);
  } catch (error) {
    report.status = "failed";
    report.failure = error.message;
    for (const page of pages) if (!page.isClosed()) await page.screenshot({ path: path.join(outDir, `${pass}-${names.get(page)}-failure.png`) }).catch(() => {});
    if (!shouldRecord) fs.writeFileSync(rehearsalPath, JSON.stringify({ fingerprint, passes: [] }), { mode: 0o600 });
    throw error;
  } finally {
    for (const context of contexts) await context.close();
    if (shouldRecord) report.videos = await Promise.all(pages.map(async page => ({ page: names.get(page), path: await page.video().path() })));
    report.finishedAt = new Date().toISOString();
    writeReport();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
