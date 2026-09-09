import { expect, test } from "@playwright/test";

test("sample board supports navigation and evidence inspection", async ({
  page,
}) => {
  await page.goto("/preview");
  await expect(
    page.getByText("Example board. Explore cards and views"),
  ).toBeVisible();
  await expect(page.getByTestId("overview-screenplay-card")).toBeVisible();
  await expect(page.getByTestId("overview-plan-card")).toHaveCount(2);
  // Real pointer clicks catch canvas overlays that accidentally swallow actions.
  await page
    .getByRole("button", { name: "Open plan: Budget plan", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Budget plan workflow" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to plan tree" }).click();
  await expect(page.getByTestId("overview-screenplay-card")).toBeVisible();
  await page.getByRole("button", { name: "Find a card" }).click();
  await page
    .getByRole("button", { name: /location Leo Carrillo State Park/ })
    .click();
  await expect(page.getByTestId("rf__node-loc-leo")).toBeInViewport();
  const location = page.getByTestId("rf__node-loc-leo");
  await expect(
    location.getByRole("button", { name: "Scene 1 Locked" }),
  ).toBeVisible();
  await expect(
    location.getByRole("button", { name: "Scene 2 Select" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.localStorage.getItem("sceneatlas:viewport:sample:sample-user"),
      ),
    )
    .not.toBeNull();
  await page
    .getByTestId("rf__node-loc-leo")
    .getByRole("button", { name: /Evidence/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Leo Carrillo State Park" }),
  ).toBeVisible();
  const evidence = page.getByRole("dialog");
  await expect(
    evidence.getByText("Availability", { exact: true }),
  ).toBeVisible();
  await expect(evidence.getByText("Unverified", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Finding a location is not permission to film there."),
  ).toBeVisible();
});

test("schedule and packet explain incomplete production state", async ({
  page,
}) => {
  await page.goto("/preview");
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /shooting schedule/ }),
  ).toBeVisible();
  await expect(page.getByText("Scene 2 duration still unknown.")).toBeVisible();
  await page
    .getByRole("button", { name: "Preparation packet", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Production preparation packet" }),
  ).toBeVisible();
  await expect(
    page
      .getByText("Application", { exact: true })
      .locator("..")
      .getByText("Not submitted", { exact: true }),
  ).toBeVisible();
});
