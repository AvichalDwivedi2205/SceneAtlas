"use client";
import { useState } from "react";
import type { PlanData } from "../../domain/model";
import { effectivePlanSceneIds, scopedPlan } from "../../domain/scope";
import { useBoard } from "./board-context";
import { TaskButton } from "./workflow-state";

export function PlanScenePicker({
  plan,
  onChange,
}: {
  plan: Pick<PlanData, "sceneScope">;
  onChange: (scope: NonNullable<PlanData["sceneScope"]>) => void;
}) {
  const { snapshot } = useBoard();
  const [query, setQuery] = useState("");
  const scenes = snapshot.entities
    .filter((e) => e.data.kind === "scene")
    .sort(
      (a, b) =>
        (a.data.kind === "scene" ? a.data.number : 0) -
        (b.data.kind === "scene" ? b.data.number : 0),
    );
  const ids = new Set(effectivePlanSceneIds(plan, scenes));
  const mode = plan.sceneScope?.mode ?? "all";
  return (
    <fieldset className="scene-picker">
      <legend>Choose scenes for this shoot plan</legend>
      <label>
        Scope
        <select
          aria-label="Plan scene scope"
          value={mode}
          onChange={(e) =>
            onChange({
              mode: e.target.value as "all" | "selected",
              sceneIds: [],
            })
          }
        >
          <option value="all">All screenplay scenes</option>
          <option value="selected">Selected scenes</option>
        </select>
      </label>
      <p>
        <strong>
          {ids.size} of {scenes.length} scenes included
        </strong>
        . The complete screenplay stays on the canvas.
      </p>
      {mode === "selected" && (
        <>
          <input
            aria-label="Find scenes to include"
            placeholder="Scene number, heading or page"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="scene-picker-list">
            {scenes
              .filter(
                (e) =>
                  e.data.kind === "scene" &&
                  `${e.data.number} ${e.data.heading} ${e.data.pageStart} ${e.data.pageEnd}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
              )
              .map(
                (e) =>
                  e.data.kind === "scene" && (
                    <label key={e._id}>
                      <input
                        type="checkbox"
                        checked={ids.has(e._id)}
                        onChange={(event) => {
                          const next = new Set(ids);
                          if (event.target.checked) next.add(e._id);
                          else next.delete(e._id);
                          onChange({
                            mode: "selected",
                            sceneIds: scenes
                              .filter((s) => next.has(s._id))
                              .map((s) => s._id),
                          });
                        }}
                      />
                      <span>
                        Scene {e.data.number} · {e.data.heading}
                        <small>
                          Pages {e.data.pageStart}–{e.data.pageEnd}
                        </small>
                      </span>
                    </label>
                  ),
              )}
          </div>
          {!ids.size && (
            <p className="notice clay-notice">
              No scenes included. Select at least one to generate this plan.
            </p>
          )}
        </>
      )}
    </fieldset>
  );
}

export function SceneNavigator({ onNavigate }: { onNavigate: () => void }) {
  const {
    snapshot,
    activePlanId,
    focus,
    edit,
    inspect,
    actions,
    act,
    previewMode,
  } = useBoard();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const plan = snapshot.entities.find((e) => e._id === activePlanId);
  const selection = plan
    ? scopedPlan(plan, snapshot.entities, snapshot.choices)
    : null;
  const included = new Set(selection?.sceneIds);
  const scenes = snapshot.entities
    .filter((e) => e.data.kind === "scene")
    .sort(
      (a, b) =>
        (a.data.kind === "scene" ? a.data.number : 0) -
        (b.data.kind === "scene" ? b.data.number : 0),
    );
  const rows = scenes
    .map((scene) => {
      const questions = snapshot.entities.filter(
        (e) =>
          e.data.kind === "question" &&
          e.scope.sceneId === scene._id &&
          (!e.scope.planId || e.scope.planId === activePlanId) &&
          e.data.resolution !== "answered",
      );
      const chosen = selection?.choices.some((c) => c.sceneId === scene._id);
      const timing =
        scene.data.kind === "scene" &&
        (scene.data.durationMinutes === null || !scene.data.windows.length);
      const stale =
        scene.stale ||
        snapshot.entities.some(
          (e) =>
            e.scope.sceneId === scene._id &&
            (!e.scope.planId || e.scope.planId === activePlanId) &&
            e.stale,
        );
      return { scene, questions, chosen, timing, stale };
    })
    .filter(
      ({ scene, questions, chosen, timing, stale }) =>
        scene.data.kind === "scene" &&
        `${scene.data.number} ${scene.data.heading} ${scene.data.pageStart} ${scene.data.pageEnd}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (filter === "all" ||
          (filter === "included" && included.has(scene._id)) ||
          (filter === "questions" && questions.length) ||
          (filter === "locations" && included.has(scene._id) && !chosen) ||
          (filter === "timing" && included.has(scene._id) && timing) ||
          (filter === "stale" && stale)),
    );
  const navigate = (fn: () => void) => {
    onNavigate();
    fn();
  };
  return (
    <div className="scene-navigator">
      <h2>Screenplay scenes</h2>
      <p>
        {selection?.sceneIds.length ?? 0} of {scenes.length} included in{" "}
        {plan?.data.kind === "plan" ? plan.data.name : "the active plan"}.
      </p>
      {plan && (
        <button
          className="button small-button"
          onClick={() => navigate(() => edit(plan))}
          disabled={previewMode || snapshot.role === "viewer"}
        >
          Choose scenes for this shoot plan
        </button>
      )}
      <div className="form-grid">
        <input
          aria-label="Find screenplay scene"
          placeholder="Scene number, heading or page"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="Filter scenes"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All scenes</option>
          <option value="included">Included scenes</option>
          <option value="questions">Unanswered questions</option>
          <option value="locations">Missing locations</option>
          <option value="timing">Timing blockers</option>
          <option value="stale">Needs refresh</option>
        </select>
      </div>
      <p className="small muted">{rows.length} matching scenes</p>
      <div className="scene-navigator-list">
        {rows.map(
          ({ scene, questions, chosen, timing, stale }) =>
            scene.data.kind === "scene" && (
              <article key={scene._id}>
                <button
                  className="scene-heading"
                  onClick={() => navigate(() => focus(scene._id))}
                >
                  Scene {scene.data.number} · {scene.data.heading}
                </button>
                <p>
                  Pages {scene.data.pageStart}–{scene.data.pageEnd} ·{" "}
                  {included.has(scene._id) ? "Included" : "Outside this plan"}
                  {stale ? " · Needs refresh" : ""}
                </p>
                <div className="actions">
                  <button
                    className="button tiny quiet"
                    onClick={() => navigate(() => inspect(scene))}
                  >
                    {chosen ? "Review location evidence" : "Review scene"}
                  </button>
                  {!!questions.length && (
                    <button
                      className="button tiny"
                      onClick={() => navigate(() => edit(questions[0]))}
                      disabled={snapshot.role === "viewer" || previewMode}
                    >
                      {questions.length} unanswered
                    </button>
                  )}
                  {timing && (
                    <button
                      className="button tiny"
                      onClick={() => navigate(() => edit(scene))}
                      disabled={snapshot.role === "viewer" || previewMode}
                    >
                      Set timing
                    </button>
                  )}
                  {included.has(scene._id) && !chosen && (
                    <TaskButton
                      kind="research"
                      targetId={scene._id}
                      className="button tiny"
                      disabled={snapshot.role === "viewer" || previewMode}
                      onClick={() =>
                        act(() =>
                          actions.start("research", scene._id, scene.scope),
                        )
                      }
                    >
                      Find filming locations
                    </TaskButton>
                  )}
                </div>
              </article>
            ),
        )}
      </div>
    </div>
  );
}
