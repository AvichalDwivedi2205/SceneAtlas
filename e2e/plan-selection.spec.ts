import { expect, test } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

test("producer chooses three budget branches, then adds an optional uncapped branch", async ({
  page,
}) => {
  const server = await createServer({
    root: path.resolve("e2e/fixtures"),
    configFile: false,
    plugins: [react()],
    define: { "process.env": {} },
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
      throw new Error("Fixture did not bind");
    await page.goto(`http://127.0.0.1:${address.port}/plan-selection.html`);
    await expect(page.getByTestId("overview-screenplay-card")).toBeVisible();
    await expect(page.getByTestId("overview-plan-card")).toHaveCount(0);
    await page
      .getByTestId("overview-screenplay-card")
      .getByRole("button", { name: "Choose scenes & plans", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Add budget plan", exact: true }),
    ).toHaveCount(0);
    await page
      .getByLabel("Plan scene scope", { exact: true })
      .selectOption("all");
    await page
      .getByRole("button", { name: "Continue with 3 scenes", exact: true })
      .click();
    await expect(
      page.getByText("No new plans selected.", { exact: false }),
    ).toBeVisible();
    const create = page.getByRole("button", {
      name: "Create selected plans",
      exact: true,
    });
    await expect(create).toBeDisabled();
    // Draft removal must not leave a hidden uncapped branch in the payload.
    await page
      .getByRole("button", { name: "Add no fixed budget plan", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Remove plan 1", exact: true })
      .click();
    for (const [index, budget] of ["2500", "5000", "10000"].entries()) {
      await page
        .getByRole("button", { name: "Add budget plan", exact: true })
        .click();
      await page
        .getByRole("spinbutton", {
          name: `Plan ${index + 1} location budget cap (USD)`,
        })
        .fill(budget);
    }
    await expect(page.getByTestId("overview-plan-card")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Create 3 plans", exact: true })
      .click();
    const cards = page.getByTestId("overview-plan-card");
    await expect(cards).toHaveCount(3);
    await expect(page.locator(".react-flow__edge-path")).toHaveCount(3);
    for (const name of ["Budget $2,500", "Budget $5,000", "Budget $10,000"])
      await expect(
        page.getByRole("article", { name: `${name} overview` }),
      ).toBeVisible();
    const saved = JSON.parse(
      (await page.getByTestId("created-plans").textContent()) ?? "null",
    );
    expect(
      saved.every(
        (p: { sceneScope: unknown }) =>
          JSON.stringify(p.sceneScope) ===
          JSON.stringify({ mode: "all", sceneIds: [] }),
      ),
    ).toBe(true);
    expect(
      saved.map((p: { budgetMode: string; budgetMinor: number }) => [
        p.budgetMode,
        p.budgetMinor,
      ]),
    ).toEqual([
      ["fixed", 250000],
      ["fixed", 500000],
      ["fixed", 1000000],
    ]);
    await page
      .getByRole("button", { name: "Open production setup", exact: true })
      .click();
    await expect(
      page.getByRole("spinbutton", {
        name: "Budget $2,500 location budget cap (USD)",
      }),
    ).toHaveValue("2500");
    await expect(
      page.getByRole("spinbutton", {
        name: "Budget $5,000 location budget cap (USD)",
      }),
    ).toHaveValue("5000");
    await expect(
      page.getByRole("spinbutton", {
        name: "Budget $10,000 location budget cap (USD)",
      }),
    ).toHaveValue("10000");
    await page
      .getByRole("textbox", { name: "Creative priorities" })
      .fill("A small coastal shoot");
    await page
      .getByLabel("Shared shooting date", { exact: true })
      .fill("2026-11-16");
    await page
      .getByRole("spinbutton", { name: "Shared move minutes", exact: true })
      .fill("30");
    await page
      .getByRole("spinbutton", { name: "Shared setup minutes", exact: true })
      .fill("15");
    await page
      .getByRole("combobox", { name: "Shared timing basis", exact: true })
      .selectOption("estimate");
    await page.getByLabel("Shared scene duration", { exact: true }).fill("45");
    await page
      .getByLabel("Confirm shared scene windows", { exact: true })
      .check();
    await page
      .getByRole("button", {
        name: "Research locations for 3 plans",
        exact: true,
      })
      .click();
    await expect
      .poll(
        async () =>
          JSON.parse(
            (await page.getByTestId("configured-plans").textContent()) ??
              "null",
          )?.plans?.length,
      )
      .toBe(3);
    const configured = JSON.parse(
      (await page.getByTestId("configured-plans").textContent()) ?? "null",
    );
    expect(
      configured.plans.map((p: { budgetMinor: number }) => p.budgetMinor),
    ).toEqual([250000, 500000, 1000000]);
    await page.getByRole("button", { name: "Add plans", exact: true }).click();
    await page
      .getByLabel("Plan scene scope", { exact: true })
      .selectOption("all");
    await page
      .getByRole("button", { name: "Continue with 3 scenes", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add no fixed budget plan", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Create 1 plan", exact: true })
      .click();
    await expect(cards).toHaveCount(4);
    await expect(page.locator(".react-flow__edge-path")).toHaveCount(4);
    await expect(
      page.getByRole("article", {
        name: "No fixed budget overview",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Schedule", exact: true }).click();
    await expect(
      page.getByRole("button", {
        name: "Generate selected schedules (0)",
        exact: true,
      }),
    ).toBeDisabled();
    await page
      .getByRole("checkbox", { name: "Generate Budget $5,000", exact: true })
      .check();
    await expect(
      page.getByRole("checkbox", {
        name: "Generate Budget $2,500",
        exact: true,
      }),
    ).not.toBeChecked();
    await expect(
      page.getByRole("checkbox", {
        name: "Generate No fixed budget",
        exact: true,
      }),
    ).not.toBeChecked();
    await expect(
      page.getByRole("button", {
        name: "Generate selected schedules (1)",
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await server.close();
  }
});
