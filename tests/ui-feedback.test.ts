// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AsyncButton } from "../src/components/async-button";
import { BoardProgress, RunState } from "../src/features/canvas/workflow-state";
import type { BoardRun } from "../src/domain/model";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("feedback during real async boundaries", () => {
  it("prevents duplicate clicks and restores the action after completion", async () => {
    let finish!: () => void;
    const callback = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () =>
      root.render(
        createElement(
          AsyncButton,
          { onClick: callback, pendingLabel: "Searching…" },
          "Search",
        ),
      ),
    );
    const button = container.querySelector("button")!;
    await act(async () => {
      button.click();
      button.click();
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Searching…");
    await act(async () => finish());
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Search");
  });
  it("exposes rejected actions and makes retry available", async () => {
    await act(async () =>
      root.render(
        createElement(
          AsyncButton,
          {
            onClick: async () => {
              throw new Error("Connection interrupted");
            },
          },
          "Save",
        ),
      ),
    );
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Connection interrupted",
    );
    expect(container.querySelector("button")!.disabled).toBe(false);
  });
  it("shows honest unknown-duration search progress and answer checkpoints", async () => {
    const run: BoardRun = {
      _id: "research",
      kind: "research",
      status: "running",
      activity: "Checking source requirements",
      scope: { kind: "workspace" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await act(async () => root.render(createElement(RunState, { run })));
    expect(container.textContent).toContain("Searching locations…");
    expect(container.textContent).toContain("Checking source requirements");
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    await act(async () =>
      root.render(
        createElement(RunState, { run: { ...run, status: "waiting" } }),
      ),
    );
    expect(container.textContent).toContain("Needs your answer");
    expect(container.querySelector(".spin")).toBeNull();
  });
  it("removes obsolete failures after a successful retry", async () => {
    const run: BoardRun = {
      _id: "failed",
      kind: "ingest",
      status: "failed",
      activity: "Failed",
      scope: { kind: "workspace" },
      createdAt: Date.now() - 2000,
      updatedAt: Date.now() - 2000,
    };
    await act(async () =>
      root.render(
        createElement(BoardProgress, {
          runs: [
            run,
            {
              ...run,
              _id: "retry",
              status: "complete",
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
          uploadProgress: null,
          onActivity: () => {},
        }),
      ),
    );
    expect(container.textContent).toContain("Screenplay ready to review");
    expect(container.textContent).not.toContain("interrupted");
  });
});
