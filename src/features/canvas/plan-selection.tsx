"use client";
import { useState } from "react";
import { Plus, Trash2, GitBranch } from "lucide-react";
import { AsyncButton } from "../../components/async-button";
import { useBoard } from "./board-context";
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
        <span className="eyebrow">YOUR SCREENPLAY · YOUR PLANS</span>
        <h2>Choose the plans you want</h2>
        <p>
          Add one plan or compare several. Each budget plan can have a different
          cap. A plan without a fixed budget is optional.
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
                  Budget cap (USD)
                  <input
                    aria-label={`Plan ${index + 1} budget cap (USD)`}
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
                <p>No cap. Costs and missing quotes are still tracked.</p>
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
            : "Create your branches, then set the production brief and choose scenes before starting research."}
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
              })),
            );
            onDone();
          }}
        >
          Create {drafts.length || "selected"}{" "}
          {drafts.length === 1 ? "plan" : "plans"}
        </AsyncButton>
      </footer>
    </div>
  );
}
