import { loadEnvFile } from "node:process";
import { test, expect, type Page } from "@playwright/test";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

test.use({ trace: "off", screenshot: "off", video: "off" });

// Explicit opt-in: uses real development services and creates disposable users.
test.describe("live Clerk and Convex collaboration", () => {
  test.skip(
    process.env.SCENEATLAS_LIVE_E2E !== "1",
    "Set SCENEATLAS_LIVE_E2E=1 to exercise deployed development services.",
  );
  test("owner invites an editor and viewer; updates and presence reach all three", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    loadEnvFile(".env.local");
    if (!process.env.CLERK_SECRET_KEY?.startsWith("sk_test_"))
      throw new Error(
        "Live acceptance tests require a Clerk development instance.",
      );
    await clerkSetup({ dotenv: false });
    const backend = createClerkClient({
      secretKey: process.env.CLERK_SECRET_KEY,
    });
    const suffix = Date.now();
    const userIds: string[] = [];
    const contexts = [];
    let ownerSession: string | undefined;
    let boardId: Id<"boards"> | undefined;
    const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    const base = process.env.SCENEATLAS_E2E_URL ?? "http://localhost:3010";
    try {
      const people: { role: string; email: string; page: Page; id: string }[] =
        [];
      for (const role of ["owner", "editor", "viewer"]) {
        const email = `sceneatlas-${role}-${suffix}+clerk_test@example.com`;
        const user = await backend.users.createUser({
          emailAddress: [email],
          skipPasswordRequirement: true,
        });
        userIds.push(user.id);
        const context = await browser.newContext();
        contexts.push(context);
        const page = await context.newPage();
        page.setDefaultTimeout(20_000);
        console.log(`Signing in test ${role}`);
        await page.goto(base);
        await clerk.signIn({ page, emailAddress: email });
        console.log(`Signed in test ${role}`);
        people.push({ role, email, page, id: user.id });
      }
      const [owner, editor, viewer] = people;
      console.log("Creating production board");
      await owner.page.goto(`${base}/workspaces`);
      await owner.page
        .getByRole("button", { name: "New workspace", exact: true })
        .click();
      await owner.page
        .getByLabel("Production name", { exact: true })
        .fill(`Acceptance test ${suffix}`);
      await owner.page
        .getByRole("button", { name: "Create and open", exact: true })
        .click();
      await expect(
        owner.page.getByRole("heading", {
          name: "Bring your story to the board.",
        }),
      ).toBeVisible();
      boardId = new URL(owner.page.url()).pathname
        .split("/")
        .at(-1) as Id<"boards">;
      for (const person of [editor, viewer]) {
        console.log(`Inviting test ${person.role}`);
        await owner.page
          .getByRole("button", { name: "Share", exact: true })
          .click();
        const dialog = owner.page.getByRole("dialog");
        await dialog
          .getByLabel("Email address", { exact: true })
          .fill(person.email);
        await dialog
          .getByRole("combobox", { name: "Access", exact: true })
          .selectOption(person.role);
        await dialog
          .getByRole("button", { name: "Create invite link", exact: true })
          .click();
        const invitation = dialog.getByLabel("Invitation link", {
          exact: true,
        });
        await expect(invitation).toBeVisible();
        await person.page.goto(await invitation.inputValue());
        await person.page
          .getByRole("button", { name: "Accept invitation", exact: true })
          .click();
        await expect(
          person.page.getByRole("heading", {
            name: "Bring your story to the board.",
          }),
        ).toBeVisible();
        await owner.page
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
      }
      console.log("Testing shared note");
      await editor.page
        .getByRole("button", { name: "Add production note", exact: true })
        .click();
      await editor.page
        .getByLabel("Production note", { exact: true })
        .fill("Shared canvas acceptance check");
      await editor.page
        .getByRole("button", { name: "Add note", exact: true })
        .click();
      for (const person of people) {
        await expect(person.page.locator(".note-text")).toHaveText(
          "Shared canvas acceptance check",
        );
        await expect(person.page.locator(".people-stack .avatar")).toHaveCount(
          3,
        );
      }
      await expect(
        viewer.page.getByRole("button", {
          name: "Add production note",
          exact: true,
        }),
      ).toBeDisabled();
      await viewer.page.reload();
      await expect(viewer.page.locator(".note-text")).toHaveText(
        "Shared canvas acceptance check",
      );
      await expect(
        viewer.page.getByText("Shared with you · View only", { exact: true }),
      ).toBeVisible();
      ownerSession = (
        await backend.sessions.createSession({ userId: owner.id })
      ).id;
      client.setAuth(
        (await backend.sessions.getToken(ownerSession, "convex")).jwt,
      );
      // Check the real server boundary in addition to the disabled viewer UI.
      const viewerSession = await backend.sessions.createSession({
        userId: viewer.id,
      });
      try {
        const readOnly = new ConvexHttpClient(
          process.env.NEXT_PUBLIC_CONVEX_URL!,
        );
        readOnly.setAuth(
          (await backend.sessions.getToken(viewerSession.id, "convex")).jwt,
        );
        await expect(
          readOnly.mutation(api.boards.addNote, {
            boardId,
            text: "Should be denied",
            x: 0,
            y: 0,
          }),
        ).rejects.toThrow(/access/);
      } finally {
        await backend.sessions.revokeSession(viewerSession.id);
      }
      await owner.page.screenshot({
        path: "/tmp/sceneatlas-live-collaboration.png",
      });
    } finally {
      if (boardId && userIds[0]) {
        if (!ownerSession)
          ownerSession = (
            await backend.sessions.createSession({ userId: userIds[0] })
          ).id;
        client.setAuth(
          (await backend.sessions.getToken(ownerSession, "convex")).jwt,
        );
        await client.mutation(api.boards.archive, { boardId, archived: true });
      }
      await Promise.all(contexts.map((context) => context.close()));
      await Promise.all(userIds.map((id) => backend.users.deleteUser(id)));
    }
  });
});
