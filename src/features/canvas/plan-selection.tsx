"use client";
import { useState } from "react";
import { Plus, Trash2, GitBranch } from "lucide-react";
import { AsyncButton } from "../../components/async-button";
import { useBoard } from "./board-context";
import { PlanScenePicker } from "./scene-scope";
import { isPending, runHeadline } from "./workflow-state";
import type { PlanData } from "../../domain/model";
import "./variant-setup.css";

type Draft = {
  key: string;
  name: string;
  budgetMode: "fixed" | "uncapped";
  budget: string;
};

export function PlanSelection({ onDone }: { onDone: () => void }) {
  const { snapshot, actions, previewMode } = useBoard();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const editable = snapshot.role !== "viewer" && !previewMode;
  const existing = snapshot.entities.filter((e) => e.data.kind === "plan");
  const scenes = snapshot.entities.filter((e) => e.data.kind === "scene");
  const script = snapshot.entities.find((e) => e.data.kind === "script");
  const [step, setStep] = useState<"scope" | "plans">("scope");
  const [sceneScope, setSceneScope] = useState<
    NonNullable<PlanData["sceneScope"]>
  >({ mode: "selected", sceneIds: [] });
  const included =
    sceneScope.mode === "all" ? scenes.length : sceneScope.sceneIds.length;
  const pending = snapshot.runs.find(
    (r) => ["ingest", "scenes"].includes(r.kind) && isPending(r),
  );
  const scopeQuestions = snapshot.entities.filter(
    (e) =>
      e.data.kind === "question" &&
      e.data.blocks.includes("scenes") &&
      e.data.resolution !== "answered",
  );
  const otherQuestions = scopeQuestions.filter(
    (e) =>
      e.data.kind === "question" &&
      !["scene_scope", "scene_scope_selection"].includes(e.data.key),
  );
  const nameFor = (draft: Draft) =>
    draft.name.trim() ||
    (draft.budgetMode === "fixed"
      ? `Budget $${Number(draft.budget).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
      : "No fixed budget");
  const update = (key: string, values: Partial<Draft>) =>
    setDrafts((previous) =>
      previous.map((d) => (d.key === key ? { ...d, ...values } : d)),
    );
  const add = (budgetMode: Draft["budgetMode"]) =>
    setDrafts((previous) => [
      ...previous,
      { key: crypto.randomUUID(), name: "", budgetMode, budget: "" },
    ]);
  const valid =
    included > 0 &&
    drafts.length > 0 &&
    drafts.every(
      (d) =>
        d.budgetMode === "uncapped" ||
        (Math.round(Number(d.budget) * 100) > 0 &&
          Number.isSafeInteger(Math.round(Number(d.budget) * 100))),
    );
  return (
    <div className="variant-setup">
      <div className="variant-intro">
        <span className="eyebrow">
          1 · CHOOSE SCENES → 2 · CREATE PLAN OPTIONS
        </span>
        <h2>
          {step === "scope"
            ? "Which scenes are you planning?"
            : "Choose the plans you want"}
        </h2>
        <p>
          {step === "scope"
            ? "Choose the scenes for this shoot first. Each plan you create will be an alternative for those scenes."
            : "Add one plan or compare several options for the same shoot. Each can have its own location budget cap."}
        </p>
      </div>
      {step === "scope" ? (
        <>
          {scenes.length ? (
            <fieldset
              className="variant-fields"
              disabled={!editable || !!pending}
            >
              <PlanScenePicker plan={{ sceneScope }} onChange={setSceneScope} />
            </fieldset>
          ) : (
            <section className="variant-fields">
              <p>
                Read the screenplay into selectable scenes. You will choose
                which scenes to include before entering any budget.
              </p>
              {pending ? (
                <p role="status">{runHeadline(pending)}</p>
              ) : (
                <AsyncButton
                  className="button primary"
                  pendingLabel="Starting scene breakdown…"
                  disabled={!editable || !script || otherQuestions.length > 0}
                  onClick={async () => {
                    if (!script) return;
                    for (const q of scopeQuestions) {
                      if (q.data.kind !== "question") continue;
                      const id = await actions.preview(q, {
                        ...q.data,
                        answer: "Entire screenplay",
                        resolution: "answered",
                        rule: null,
                      });
                      await actions.change("commitInputs", id);
                    }
                    await actions.start("scenes", script._id, {
                      kind: "workspace",
                    });
                  }}
                >
                  Read all screenplay scenes
                </AsyncButton>
              )}
              {otherQuestions.map((q) => (
                <p key={q._id} className="notice">
                  {q.data.kind === "question" ? q.data.prompt : ""} — answer
                  this in Tasks before continuing.
                </p>
              ))}
            </section>
          )}
          <footer className="variant-footer">
            <p>
              Location caps cover the included scenes together. Cast, crew,
              equipment and post-production budgets are separate.
            </p>
            <button
              className="button primary"
              disabled={!editable || !included || !!pending}
              onClick={() => setStep("plans")}
            >
              Continue with {included} {included === 1 ? "scene" : "scenes"}
            </button>
          </footer>
        </>
      ) : (
        <>
          <div className="variant-scope-summary">
            <strong>
              {included} {included === 1 ? "scene" : "scenes"} in each plan ·
              Location costs only
            </strong>
            <button
              type="button"
              className="button small-button quiet"
              onClick={() => setStep("scope")}
            >
              Change scenes
            </button>
            <p>
              Each cap covers these scenes together, not each scene separately.
              Cast, crew, equipment and post-production costs are not included.
            </p>
          </div>
          <fieldset className="variant-fields" disabled={!editable}>
            <div className="variant-add-actions">
              <button
                type="button"
                className="button"
                disabled={drafts.length >= 8}
                onClick={() => add("fixed")}
              >
                <Plus size={16} />
                Add budget plan
              </button>
              <button
                type="button"
                className="button"
                disabled={drafts.length >= 8}
                onClick={() => add("uncapped")}
              >
                <Plus size={16} />
                Add no fixed budget plan
              </button>
            </div>
            {!drafts.length && (
              <p role="status">
                No new plans selected. Add only the branches you need.
              </p>
            )}
            <div className="variant-options">
              {drafts.map((draft, index) => (
                <section key={draft.key} aria-label={`New plan ${index + 1}`}>
                  <div className="variant-option-heading">
                    <GitBranch size={18} />
                    <h3>Plan {index + 1}</h3>
                    <button
                      className="button tiny quiet"
                      type="button"
                      aria-label={`Remove plan ${index + 1}`}
                      onClick={() =>
                        setDrafts((previous) =>
                          previous.filter((d) => d.key !== draft.key),
                        )
                      }
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                  <label>
                    Plan type
                    <select
                      aria-label={`Plan ${index + 1} type`}
                      value={draft.budgetMode}
                      onChange={(event) =>
                        update(draft.key, {
                          budgetMode: event.target.value as Draft["budgetMode"],
                        })
                      }
                    >
                      <option value="fixed">Budget plan</option>
                      <option value="uncapped">No fixed budget</option>
                    </select>
                  </label>
                  {draft.budgetMode === "fixed" ? (
                    <label>
                      Location budget cap (USD)
                      <input
                        aria-label={`Plan ${index + 1} location budget cap (USD)`}
                        type="number"
                        min="0.01"
                        step="0.01"
                        placeholder="e.g. 2500"
                        value={draft.budget}
                        onChange={(event) =>
                          update(draft.key, { budget: event.target.value })
                        }
                      />
                    </label>
                  ) : (
                    <p>
                      No location spending cap. Costs and missing quotes are
                      still tracked.
                    </p>
                  )}
                  <label>
                    Plan name (optional)
                    <input
                      aria-label={`Plan ${index + 1} name`}
                      maxLength={80}
                      placeholder={
                        draft.budgetMode === "fixed" && !draft.budget
                          ? "e.g. Lean shoot"
                          : nameFor({ ...draft, name: "" })
                      }
                      value={draft.name}
                      onChange={(event) =>
                        update(draft.key, { name: event.target.value })
                      }
                    />
                  </label>
                </section>
              ))}
            </div>
          </fieldset>
          <footer className="variant-footer">
            <p>
              {existing.length
                ? "New branches start with the saved production inputs. Choose their locations independently and review each plan’s settings."
                : "Create these alternatives for your selected scenes, then add the production details before research."}
            </p>
            <AsyncButton
              className="button primary"
              pendingLabel="Creating selected branches…"
              disabled={!editable || !valid || !actions.createPlans}
              onClick={async () => {
                await actions.createPlans!(
                  drafts.map((d) => ({
                    key: d.key,
                    name: nameFor(d),
                    budgetMode: d.budgetMode,
                    budgetMinor:
                      d.budgetMode === "fixed"
                        ? Math.round(Number(d.budget) * 100)
                        : null,
                    sceneScope,
                  })),
                );
                onDone();
              }}
            >
              Create {drafts.length || "selected"}{" "}
              {drafts.length === 1 ? "plan" : "plans"}
            </AsyncButton>
          </footer>
        </>
      )}
    </div>
  );
}
