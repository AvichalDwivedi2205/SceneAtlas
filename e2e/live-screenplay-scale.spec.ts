import { loadEnvFile } from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

test.use({ trace: "off", screenshot: "off", video: "off" });

// Private input PDFs stay outside the repository. Opt-in runs real billed models.
test("full PDF reaches a complete source-verified board shared by two people", async ({
  page,
  browser,
}) => {
  test.skip(
    process.env.SCENEATLAS_SCALE_TEST !== "1",
    "Opt in with a PDF and independently reviewed expected scene inventory.",
  );
  test.setTimeout(1_800_000);
  loadEnvFile(".env.local");
  const pdfPath = process.env.SCENEATLAS_SCALE_PDF;
  const expectedPath = process.env.SCENEATLAS_SCALE_EXPECTED;
  if (
    !pdfPath ||
    !expectedPath ||
    !process.env.CLERK_SECRET_KEY?.startsWith("sk_test_")
  )
    throw new Error(
      "Provide SCENEATLAS_SCALE_PDF, SCENEATLAS_SCALE_EXPECTED, and development Clerk credentials.",
    );
  const expected = JSON.parse(await readFile(expectedPath, "utf8")) as {
    pages: number;
    sceneCount: number;
    batchCount: number;
    scenes: {
      number: number;
      heading: string;
      pageStart: number;
      pageEnd: number;
      excerpt: string;
    }[];
  };
  const artifactPrefix = `/tmp/sceneatlas-scale-${expected.pages}`;
  await clerkSetup({ dotenv: false });
  const auth = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  const base = process.env.SCENEATLAS_E2E_URL ?? "http://localhost:3010";
  const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  const users = [];
  const editorContext = await browser.newContext();
  const editor = await editorContext.newPage();
  const browserErrors: string[] = [];
  for (const surface of [page, editor])
    surface.on("pageerror", (error) => browserErrors.push(error.message));
  let sessionId = "";
  let boardId: Id<"boards"> | undefined;
  let tokenTime = 0;
  const refresh = async () => {
    if (Date.now() - tokenTime > 40_000) {
      client.setAuth((await auth.sessions.getToken(sessionId, "convex")).jwt);
      tokenTime = Date.now();
    }
  };
  const snapshot = async () => {
    await refresh();
    const state = await client.query(api.boards.snapshot, {
      boardId: boardId!,
    });
    await writeFile(`${artifactPrefix}-snapshot.json`, JSON.stringify(state));
    return state;
  };
  const metrics: Record<string, unknown> = {
    pages: expected.pages,
    expectedScenes: expected.sceneCount,
    startedAt: new Date().toISOString(),
  };
  const waitForRun = async (runId: Id<"runs">) => {
    let previousActivity = "";
    const start = Date.now();
    while (Date.now() - start < 1_550_000) {
      const state = await snapshot();
      const run = state.runs.find((r) => r._id === runId)!;
      if (run.activity !== previousActivity) {
        console.log(`${run.kind}: ${run.activity}`);
        previousActivity = run.activity;
      }
      if (run.status === "complete") return state;
      if (["failed", "cancelled", "superseded", "waiting"].includes(run.status))
        throw new Error(
          `${run.kind}: ${run.status}: ${run.error ?? run.activity}`,
        );
      await page.waitForTimeout(3000);
    }
    throw new Error("Screenplay acceptance timed out; inspect saved snapshot.");
  };
  try {
    for (const role of ["owner", "editor"]) {
      const email = `sceneatlas-scale-${role}-${Date.now()}+clerk_test@example.com`;
      users.push(
        await auth.users.createUser({
          emailAddress: [email],
          skipPasswordRequirement: true,
        }),
      );
      const surface = role === "owner" ? page : editor;
      await surface.goto(base);
      await clerk.signIn({ page: surface, emailAddress: email });
    }
    sessionId = (await auth.sessions.createSession({ userId: users[0].id })).id;
    await page.goto(`${base}/workspaces`);
    await page
      .getByRole("button", { name: "New workspace", exact: true })
      .click();
    await page
      .getByLabel("Production name", { exact: true })
      .fill(`${expected.pages}-page scale acceptance ${Date.now()}`);
    await page
      .getByRole("button", { name: "Create and open", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Bring your story to the board." }),
    ).toBeVisible();
    boardId = new URL(page.url()).pathname.split("/").at(-1) as Id<"boards">;
    metrics.boardId = boardId;
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Email address", { exact: true })
      .fill(users[1].emailAddresses[0].emailAddress);
    await dialog
      .getByRole("combobox", { name: "Access", exact: true })
      .selectOption("editor");
    await dialog
      .getByRole("button", { name: "Create invite link", exact: true })
      .click();
    const invite = dialog.getByLabel("Invitation link", { exact: true });
    await expect(invite).toBeVisible();
    await editor.goto(await invite.inputValue());
    await editor
      .getByRole("button", { name: "Accept invitation", exact: true })
      .click();
    await expect(
      editor.getByRole("heading", { name: "Bring your story to the board." }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();

    const uploadStarted = Date.now();
    await page
      .getByRole("button", { name: "Add your screenplay", exact: true })
      .click();
    await page.locator('input[type="file"]').setInputFiles(pdfPath);
    await expect(page.locator(".board-progress")).toContainText(
      /Uploading|received|queued|Reading/,
    );
    let state = await snapshot();
    await expect
      .poll(async () => {
        state = await snapshot();
        return state.runs.find((r) => r.kind === "ingest")?._id;
      })
      .toBeTruthy();
    const ingest = state.runs.find((r) => r.kind === "ingest")!;
    state = await waitForRun(ingest._id);
    metrics.ingestSeconds = (Date.now() - uploadStarted) / 1000;
    const script = state.entities.find((e) => e.kind === "script")!;
    expect(script.data.pageCount).toBe(expected.pages);
    expect(script.data.sceneCount).toBe(expected.sceneCount);
    const scope = state.entities.find(
      (e) => e.kind === "question" && e.data.key === "scene_scope",
    )!;
    await refresh();
    const changeId = await client.mutation(api.changes.preview, {
      boardId,
      entityId: scope._id,
      expectedRevision: scope.revision,
      data: {
        ...scope.data,
        answer: "Entire screenplay",
        resolution: "answered",
      },
    });
    await client.mutation(api.changes.commitInputs, { changeId });
    const started = Date.now();
    let runId = await client.mutation(api.runs.start, {
      boardId,
      kind: "scenes",
      targetId: script._id,
      scope: { kind: "workspace" },
    });
    const interruptedRunId = runId;
    if (process.env.SCENEATLAS_SCALE_INTERRUPT === "1") {
      await expect
        .poll(
          async () => {
            await refresh();
            return (await client.query(api.runs.events, { runId })).some((e) =>
              e.activity.startsWith("Saved batch"),
            );
          },
          { timeout: 180_000, intervals: [1000, 2000] },
        )
        .toBe(true);
      await client.mutation(api.runs.cancel, { runId });
      expect(
        (await snapshot()).entities.filter((e) => e.kind === "scene"),
      ).toHaveLength(0);
      runId = await client.mutation(api.runs.retry, { runId });
      metrics.interruptedRunId = interruptedRunId;
    }
    await expect(editor.locator(".board-progress")).toContainText(
      /queued|Generating scene groups/,
    );
    await page.reload();
    await expect(page.locator(".board-progress")).toContainText(
      /queued|Generating scene groups/,
    );
    await page.screenshot({ path: `${artifactPrefix}-processing.png` });
    state = await waitForRun(runId);
    metrics.breakdownSeconds = (Date.now() - started) / 1000;
    metrics.runId = runId;
    const actual = state.entities
      .filter((e) => e.kind === "scene")
      .sort((a, b) => a.data.number - b.data.number);
    expect(actual).toHaveLength(expected.sceneCount);
    for (const [index, scene] of actual.entries()) {
      expect(scene.data).toMatchObject(expected.scenes[index]);
      expect(scene.data.durationMinutes).toBeNull();
      expect(scene.data.durationBasis).toBe("unknown");
    }
    expect(state.entities.filter((e) => e.kind === "plan")).toHaveLength(2);
    expect(state.edges.filter((e) => e.relation === "scene")).toHaveLength(
      expected.sceneCount,
    );
    expect(new Set(actual.map((e) => e._id)).size).toBe(expected.sceneCount);
    await refresh();
    const events = await client.query(api.runs.events, { runId });
    metrics.batchEvents = events
      .filter((e) => /Saved batch|Resumed saved batch/.test(e.activity))
      .map((e) => e.activity);
    if (process.env.SCENEATLAS_SCALE_INTERRUPT === "1")
      expect(
        events.some((e) => e.activity.startsWith("Resumed saved batch")),
      ).toBe(true);

    const reloadStart = Date.now();
    await page.reload();
    await expect(page.locator(".flow-surface")).toHaveAttribute(
      "data-node-count",
      String(state.nodes.length),
    );
    metrics.reloadSeconds = (Date.now() - reloadStart) / 1000;
    await expect(editor.locator(".flow-surface")).toHaveAttribute(
      "data-node-count",
      String(state.nodes.length),
    );
    await expect(page.locator(".people-stack .avatar")).toHaveCount(2);
    const findStart = Date.now();
    await page
      .getByRole("button", { name: "Find a card", exact: true })
      .click();
    await page
      .getByLabel("Search board", { exact: true })
      .fill(`Scene ${expected.sceneCount} ·`);
    await page.locator(".search-results button").first().click();
    const lastCard = page.locator(
      `.react-flow__node[data-id="${actual.at(-1)!._id}"]`,
    );
    await expect(lastCard).toBeInViewport();
    await expect
      .poll(async () =>
        page
          .locator(".react-flow__viewport")
          .evaluate((el) =>
            Math.abs(new DOMMatrix(getComputedStyle(el).transform).a - 0.9),
          ),
      )
      .toBeLessThan(0.01);
    metrics.findLastSceneSeconds = (Date.now() - findStart) / 1000;
    await page.screenshot({ path: `${artifactPrefix}-complete.png` });
    await editor
      .getByRole("button", { name: "Add production note", exact: true })
      .click();
    await editor
      .getByLabel("Production note", { exact: true })
      .fill("Second editor verified the complete screenplay board.");
    await editor.getByRole("button", { name: "Add note", exact: true }).click();
    await expect
      .poll(async () =>
        (await snapshot()).entities.some(
          (e) =>
            e.kind === "note" &&
            e.data.text ===
              "Second editor verified the complete screenplay board.",
        ),
      )
      .toBe(true);
    await expect(page.locator(".flow-surface")).toHaveAttribute(
      "data-node-count",
      String(state.nodes.length + 1),
    );
    expect(browserErrors).toEqual([]);
    metrics.verifiedScenes = actual.length;
    metrics.snapshotBytes = Buffer.byteLength(JSON.stringify(state));
    metrics.renderedCards = await page.locator(".react-flow__node").count();
    metrics.status = "passed";
    console.log(JSON.stringify(metrics));
  } finally {
    metrics.finishedAt = new Date().toISOString();
    await writeFile(
      `${artifactPrefix}-report.json`,
      JSON.stringify(metrics, null, 2),
    );
    if (boardId && sessionId) {
      await refresh();
      const state = await snapshot();
      for (const run of state.runs.filter((r) =>
        ["queued", "running", "waiting"].includes(r.status),
      ))
        await client.mutation(api.runs.cancel, { runId: run._id });
      await client.mutation(api.boards.archive, { boardId, archived: true });
    }
    await editorContext.close();
    await Promise.all(users.map((user) => auth.users.deleteUser(user.id)));
  }
});
