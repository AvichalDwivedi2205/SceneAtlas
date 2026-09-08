import { loadEnvFile } from "node:process";
import { writeFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

test.use({ trace: "off", screenshot: "off", video: "off" });

// Explicit opt-in: exercises billed Gemini/Parallel calls on development services.
test("live screenplay becomes a sourced plan and downloadable draft packet", async ({
  page,
}) => {
  test.skip(
    process.env.SCENEATLAS_LIVE_WORKFLOW !== "1",
    "Set SCENEATLAS_LIVE_WORKFLOW=1 to run real cloud providers.",
  );
  test.setTimeout(900_000);
  loadEnvFile(".env.local");
  if (!process.env.CLERK_SECRET_KEY?.startsWith("sk_test_"))
    throw new Error(
      "This acceptance test requires Clerk development credentials.",
    );
  await clerkSetup({ dotenv: false });
  const backend = createClerkClient({
    secretKey: process.env.CLERK_SECRET_KEY,
  });
  const email = `sceneatlas-workflow-${Date.now()}+clerk_test@example.com`;
  const user = await backend.users.createUser({
    emailAddress: [email],
    skipPasswordRequirement: true,
  });
  const session = await backend.sessions.createSession({ userId: user.id });
  const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  let boardId: Id<"boards"> | undefined;
  let tokenTime = 0;
  const base = process.env.SCENEATLAS_E2E_URL ?? "http://localhost:3010";
  const refresh = async () => {
    if (Date.now() - tokenTime > 40_000) {
      client.setAuth(
        (await backend.sessions.getToken(session.id, "convex")).jwt,
      );
      tokenTime = Date.now();
    }
  };
  const snapshot = async () => {
    await refresh();
    return client.query(api.boards.snapshot, { boardId: boardId! });
  };
  type Snapshot = FunctionReturnType<typeof api.boards.snapshot>;
  type Entity = Snapshot["entities"][number];
  const update = async (entity: Entity, data: Entity["data"]) => {
    await refresh();
    const changeId = await client.mutation(api.changes.preview, {
      boardId: boardId!,
      entityId: entity._id,
      expectedRevision: entity.revision,
      data,
    });
    await client.mutation(api.changes.commitInputs, { changeId });
  };
  const finishRun = async (runId: Id<"runs">, kind: string) => {
    let latest: Snapshot | undefined;
    let activeRunId = runId;
    let answeredCheckpoints = 0;
    await expect
      .poll(
        async () => {
          latest = await snapshot();
          await writeFile(
            "/tmp/sceneatlas-live-workflow-snapshot.json",
            JSON.stringify(latest),
          );
          const run = latest.runs.find((r) => r._id === activeRunId);
          if (run?.status === "waiting" && answeredCheckpoints < 3) {
            const questions = latest.entities.filter(
              (e) =>
                e.kind === "question" &&
                e.data.resolution === "open" &&
                e.data.blocks.includes(kind),
            );
            const answers = questions.map((question) => {
              const { key, prompt } = question.data;
              let answer: string;
              if (key === "clarify_rock_formation_flexibility")
                answer =
                  "For this illustrative scene, prioritize locations with sourced rock formations. Return fewer candidates if needed; unverified features remain unverified.";
              else if (/budget.*monitor|monitor.*budget/i.test(prompt))
                answer =
                  "For this illustrative test, budget one monitor's published minimum as a producer-approved contingency estimate. Actual monitoring requirements remain unverified; no waiver or approval assumed.";
              else if (key.startsWith("permit_lead_time_conflict_"))
                answer =
                  "Use ten business days as our internal planning buffer for this illustrative test. Preserve both official source statements; this buffer is not a determination of the authority's actual deadline or an approval.";
              else if (
                key.startsWith("advance_notice_") ||
                key.startsWith("permit_lead_time_")
              )
                answer =
                  "Leave the park-specific advance notice unresolved. For this illustrative preparation draft, use ten business days as our producer-selected internal planning buffer only. This is not a verified park requirement; retain the need to contact the park coordinator before committing to production or applying.";
              else if (key.startsWith("fire_requirements_confirmation_"))
                answer =
                  "Confirmed for this illustrative production: no open flames, pyrotechnics, fire effects, special effects, generators or special lighting.";
              else if (
                /reservation.*fee/i.test(key) &&
                /unknown|not published|unpublished/i.test(prompt)
              )
                answer =
                  "Proceed with this preparation draft with the reservation fee marked unknown and unquoted. Do not invent an amount; an actual quote is still needed before booking.";
              else
                throw new Error(
                  `Test fixture needs an explicit producer answer for ${key}: ${prompt}`,
                );
              return { question, answer };
            });
            if (answers.length) {
              await expect(page.locator(".board-progress")).toContainText(
                "Needs your answer",
              );
              for (const { question, answer } of answers)
                await update(question, {
                  ...question.data,
                  resolution: "answered",
                  answer,
                });
              latest = await snapshot();
              const resumed = latest.runs.find(
                (r) =>
                  r.kind === kind &&
                  r.targetId === run.targetId &&
                  r._id !== run._id &&
                  r.createdAt > run.createdAt,
              );
              expect(
                resumed,
                "All answers should automatically resume this checkpoint",
              ).toBeTruthy();
              activeRunId = resumed!._id;
              answeredCheckpoints++;
              console.log(
                `${kind}: confirmed ${answers.length} illustrative producer inputs; resumed ${activeRunId}`,
              );
              return resumed!.status;
            }
          }
          if (
            run &&
            ["failed", "waiting", "superseded", "cancelled"].includes(
              run.status,
            )
          )
            throw new Error(
              `${kind}: ${run.status}: ${run.error ?? run.activity}`,
            );
          return run?.status;
        },
        {
          timeout: 420_000,
          intervals: [1000, 2000, 5000],
          message: `${kind} should publish a real managed result`,
        },
      )
      .toBe("complete");
    console.log(`${kind} passed: ${activeRunId}`);
    return latest!;
  };
  const start = async (kind: string, target: Entity) => {
    await refresh();
    return client.mutation(api.runs.start, {
      boardId: boardId!,
      kind,
      targetId: target._id,
      scope: target.scope,
    });
  };
  try {
    await page.goto(base);
    await clerk.signIn({ page, emailAddress: email });
    await page.goto(`${base}/workspaces`);
    await page
      .getByRole("button", { name: "New workspace", exact: true })
      .click();
    await page
      .getByLabel("Production name", { exact: true })
      .fill(`Live workflow acceptance ${Date.now()}`);
    await page
      .getByRole("button", { name: "Create and open", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Upload your screenplay" }),
    ).toBeVisible();
    boardId = new URL(page.url()).pathname.split("/").at(-1) as Id<"boards">;

    // Empty and transitioning screens must remain usable before a plan exists.
    await page
      .getByRole("button", { name: "Preparation packet", exact: true })
      .click();
    await expect(page.getByText("Choose a production plan to review packet readiness.")).toBeVisible();
    await page.getByRole("button", { name: "Canvas", exact: true }).click();
    await page
      .getByRole("button", { name: "Upload screenplay", exact: true })
      .click();
    await page
      .getByLabel("Screenplay filename")
      .fill("coastal-rehearsal-acceptance.txt");
    await page.getByLabel("Screenplay text").fill(`COASTAL REHEARSAL
Original acceptance-test screenplay by SceneAtlas.

EXT. CALIFORNIA BEACH - DAY
MARA stands on open sand, studying a folded trail map. The ocean rolls gently behind her.
She turns toward a low rock formation. No other people are present.
MARA
The path must start here.
She walks to the rocks and sits.
FADE OUT.`);
    await page
      .getByRole("button", { name: "Read screenplay", exact: true })
      .click();
    await expect(page.locator(".board-progress")).toContainText(
      /Uploading|received|queued|Reading/,
    );
    let state: Snapshot | undefined;
    await expect
      .poll(async () => {
        state = await snapshot();
        return state.runs.find((r) => r.kind === "ingest")?._id;
      })
      .toBeTruthy();
    state = await finishRun(
      state!.runs.find((r) => r.kind === "ingest")!._id,
      "ingest",
    );
    const intake = state.entities.filter((e) => e.kind === "question");
    expect(intake.map((e) => e.data.key)).toEqual(
      expect.arrayContaining(["search_area", "production_activities"]),
    );
    for (const question of intake) {
      const answer =
        question.data.key === "search_area"
          ? "Los Angeles County, California, within 60 miles of Los Angeles. California state beaches preferred. Open sand, ocean and low rocks."
          : question.data.key === "production_activities"
            ? "Four people including cast, one handheld camera. No drones, stunts, vehicles, closures, generators or special lighting."
            : "Entire screenplay";
      await update(question, {
        ...question.data,
        answer,
        resolution: "answered",
      });
    }
    const script = (await snapshot()).entities.find(
      (e) => e.kind === "script",
    )!;
    state = await finishRun(await start("scenes", script), "scenes");
    expect(state.entities.filter((e) => e.kind === "scene")).toHaveLength(1);
    expect(state.entities.filter((e) => e.kind === "plan")).toHaveLength(2);
    let scene = state.entities.find((e) => e.kind === "scene")!;
    let plan = state.entities.find(
      (e) => e.kind === "plan" && e.data.name === "Budget plan",
    )!;
    await update(scene, {
      ...scene.data,
      durationMinutes: 60,
      durationBasis: "estimate",
      windows: [{ date: "2026-11-16", start: 480, end: 1080 }],
    });
    await update(plan, {
      ...plan.data,
      dates: ["2026-11-16"],
      budgetMinor: 200000,
      moveMinutes: 30,
      setupMinutes: 15,
      timingBasis: "estimate",
      idealShoot:
        "Illustrative acceptance fixture; producer-approved timing estimates. No external availability or approvals assumed.",
    });
    scene = (await snapshot()).entities.find((e) => e._id === scene._id)!;
    const researchRun = await start("research", scene);
    await expect(page.locator(".board-progress")).toContainText(
      /Location search queued|Searching locations/,
    );
    await page.screenshot({ path: "/tmp/sceneatlas-live-searching.png" });
    state = await finishRun(researchRun, "research");
    const locations = state.entities.filter((e) => e.kind === "location");
    expect(locations.length).toBeGreaterThan(0);
    expect(locations.length).toBeLessThanOrEqual(3);
    for (const location of locations) {
      expect(location.data.availability).toBe("unverified");
      expect(location.data.sources.length).toBeGreaterThan(0);
      for (const source of location.data.sources) {
        expect(source.provider).toBe("parallel");
        expect(source.searchId).toMatch(/^search_/);
      }
    }
    const events = await client.query(api.runs.events, { runId: researchRun });
    expect(
      events.some((event) => /^search_/.test(event.providerId ?? "")),
    ).toBe(true);
    const location = locations[0];
    await client.mutation(api.planning.select, {
      boardId,
      planId: plan._id,
      sceneId: scene._id,
      locationId: location._id,
      locked: true,
      expectedRevision: 0,
    });
    state = await finishRun(
      await start("requirements", location),
      "requirements",
    );
    expect(
      state.entities.find((e) => e._id === location._id)!.revision,
    ).toBeGreaterThan(location.revision);
    plan = state.entities.find((e) => e._id === plan._id)!;
    state = await finishRun(await start("schedule", plan), "schedule");
    const schedule = state.entities.find(
      (e) => e.kind === "schedule" && e.data.planId === plan._id,
    )!;
    expect(schedule.data.entries).toHaveLength(1);
    expect(schedule.data.provisional).toBe(true);
    state = await finishRun(await start("packet", plan), "packet");
    const packet = state.entities.find(
      (e) => e.kind === "packet" && e.data.planId === plan._id,
    )!;
    expect(packet.data.externalStatus).toBe("not_submitted");
    await page
      .getByRole("button", { name: "Preparation packet", exact: true })
      .click();
    const downloadPending = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download PDF", exact: true })
      .click();
    const download = await downloadPending;
    expect(await download.failure()).toBeNull();
    await download.saveAs("/tmp/sceneatlas-live-preparation-packet.pdf");
    await page.screenshot({ path: "/tmp/sceneatlas-live-packet.png" });
    console.log(
      `Workflow passed; packet ${packet._id}; research provider IDs preserved.`,
    );
  } finally {
    try {
      if (boardId) {
        await refresh();
        await client.mutation(api.boards.archive, { boardId, archived: true });
      }
    } finally {
      await backend.users.deleteUser(user.id);
    }
  }
});
