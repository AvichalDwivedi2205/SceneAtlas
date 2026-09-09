import { expect, test } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

test("overview cards stay visible and clickable after parent rerenders", async ({
  page,
}) => {
  await page.goto("/preview");
  const cards = page.locator(".react-flow__node-overview");
  await expect(cards).toHaveCount(3);
  for (const card of await cards.all()) await expect(card).toBeVisible();

  // Opening and closing a sibling dialog rerenders the real overview while
  // leaving its card sizes unchanged, just like presence and run updates.
  for (let iteration = 0; iteration < 3; iteration++) {
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Bring your team to the board" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close dialog" }).click();
    for (const card of await cards.all()) await expect(card).toBeVisible();
  }

  await page
    .getByRole("button", { name: "Open plan: Budget plan", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Budget plan workflow" }),
  ).toBeVisible();
});

test("live snapshot updates preserve visible measured overview cards", async ({
  page,
}) => {
  // Use the real component and browser ResizeObserver, isolated from auth and
  // external services. This fixture contains no recorded production data.
  const server = await createServer({
    root: path.resolve("e2e/fixtures"),
    configFile: false,
    plugins: [react()],
    css: { postcss: { plugins: [] } },
    server: {
      host: "127.0.0.1",
      port: 0,
      fs: { allow: [process.cwd()] },
      forwardConsole: false,
    },
    logLevel: "silent",
  });
  await server.listen();
  try {
    const address = server.httpServer!.address();
    if (!address || typeof address === "string")
      throw new Error("Browser fixture server did not bind a port");
    await page.goto(
      `http://127.0.0.1:${address.port}/production-overview.html`,
    );
    const cards = page.locator(".react-flow__node-overview");
    await expect(cards).toHaveCount(3);
    for (const card of await cards.all()) await expect(card).toBeVisible();

    // Eventual visibility misses cards repeatedly disappearing during a live
    // stream. Sample every animation frame while real snapshot props change.
    const observation = page.evaluate(async () => {
      let sampledFrames = 0;
      const hiddenFrames: { revision: number; hidden: string[] }[] = [];
      for (let frame = 0; frame < 180; frame++) {
        await new Promise(requestAnimationFrame);
        const revision = Number(
          document.querySelector('[aria-label="Snapshot revision"]')
            ?.textContent,
        );
        if (revision > 0) {
          sampledFrames++;
          const hidden = [
            ...document.querySelectorAll<HTMLElement>(
              ".react-flow__node-overview",
            ),
          ]
            .filter((node) => getComputedStyle(node).visibility !== "visible")
            .map((node) => node.dataset.id ?? "missing id");
          if (hidden.length) hiddenFrames.push({ revision, hidden });
        }
        if (revision === 100) break;
      }
      return { sampledFrames, hiddenFrames };
    });
    await page.getByRole("button", { name: "Stream snapshot updates" }).click();
    await expect(
      page.getByRole("status", { name: "Snapshot revision" }),
    ).toHaveText("100");
    const result = await observation;
    expect(result.sampledFrames).toBeGreaterThan(50);
    expect(result.hiddenFrames).toEqual([]);
    for (const card of await cards.all()) await expect(card).toBeVisible();
    await page
      .getByRole("button", { name: "Open plan: Budget plan", exact: true })
      .click();
    await expect(page.getByRole("status", { name: "Opened plan" })).toHaveText(
      "budget",
    );
  } finally {
    await server.close();
  }
});
