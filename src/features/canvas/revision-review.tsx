"use client";

import type { BoardSnapshot, ScheduleData } from "../../domain/model";
import { formatTime } from "../../domain/planning";
import { effectivePlanSceneIds } from "../../domain/scope";
import {
  decisionPreservation,
  lockedSceneExclusions,
  revisionInputChanges,
  scheduleRowChanges,
} from "../../domain/revision-review";
import type { ChangeView } from "./board-context";
import styles from "./revision-review.module.css";

function sceneLabel(snapshot: BoardSnapshot, sceneId: string) {
  const scene = snapshot.entities.find((entity) => entity._id === sceneId);
  return scene?.data.kind === "scene" ? `Scene ${scene.data.number}` : "Scene";
}

function locationLabel(snapshot: BoardSnapshot, locationId: string) {
  const location = snapshot.entities.find(
    (entity) => entity._id === locationId,
  );
  return location?.data.kind === "location"
    ? location.data.name
    : "Previously selected location";
}

function ScheduleValue({ entry }: { entry?: ScheduleData["entries"][number] }) {
  return entry ? (
    <>
      <strong>
        {formatTime(entry.start)}–{formatTime(entry.end)}
      </strong>
      <p>{entry.date}</p>
      <p>{entry.locationName}</p>
      <p>Duration basis: {entry.durationBasis}</p>
    </>
  ) : (
    <span>Not in this schedule</span>
  );
}

export function RevisionReview({
  change,
  snapshot,
}: {
  change: ChangeView;
  snapshot: BoardSnapshot;
}) {
  const differences = revisionInputChanges(
    change.before,
    change.proposed,
    snapshot.entities,
  );
  const exclusions = lockedSceneExclusions(
    change.targetId,
    change.before,
    change.proposed,
    snapshot,
  );
  const preservation = decisionPreservation(
    change.preservedDecisions,
    snapshot,
  );
  const schedules = change.stagedSchedules ?? [];
  const priorSchedules =
    change.beforeSchedules ??
    (change.status === "preview"
      ? snapshot.entities
          .filter(
            (entity) =>
              change.affectedIds.includes(entity._id) &&
              entity.data.kind === "schedule",
          )
          .map((entity) => entity.data as ScheduleData)
      : []);
  const proposedMembership =
    change.proposed?.kind === "plan"
      ? new Set(effectivePlanSceneIds(change.proposed, snapshot.entities))
      : undefined;
  const savedPlan = change.before?.kind === "plan" ? change.before : undefined;
  const proposedPlan =
    change.proposed?.kind === "plan" ? change.proposed : undefined;
  const equalTiming =
    savedPlan &&
    proposedPlan &&
    ["setupMinutes", "moveMinutes", "timingBasis"].every(
      (field) =>
        savedPlan[field as keyof typeof savedPlan] ===
        proposedPlan[field as keyof typeof proposedPlan],
    );
  return (
    <>
      <section className={styles.comparison}>
        <h3>Production input changes</h3>
        {differences.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Input</th>
                  <th scope="col">Previous</th>
                  <th scope="col">Proposed</th>
                </tr>
              </thead>
              <tbody>
                {differences.map((difference) => (
                  <tr key={difference.field}>
                    <th scope="row">{difference.label}</th>
                    <td>{difference.before}</td>
                    <td>{difference.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>
            {change.before
              ? "No input differences recorded."
              : "Previous input values were not captured for this revision."}
          </p>
        )}
        {equalTiming && (
          <p className="small muted">
            Setup remains{" "}
            {savedPlan.setupMinutes === null
              ? "unknown"
              : `${savedPlan.setupMinutes} minutes`}
            ; moves remain{" "}
            {savedPlan.moveMinutes === null
              ? "unknown"
              : `${savedPlan.moveMinutes} minutes`}{" "}
            ({savedPlan.timingBasis}).
          </p>
        )}
        {exclusions.length > 0 && (
          <p className="notice brass-notice">
            This excludes{" "}
            {exclusions
              .map((choice) => sceneLabel(snapshot, choice.sceneId))
              .join(", ")}{" "}
            with locked locations. Those saved choices remain available when the
            scenes are included again; their assignments and costs leave this
            plan.
          </p>
        )}
      </section>
      {schedules.map((schedule) => {
        const previous = priorSchedules.find(
          (candidate) => candidate.planId === schedule.planId,
        );
        const rows = scheduleRowChanges(previous, schedule);
        const plan = snapshot.entities.find(
          (entity) => entity._id === schedule.planId,
        );
        return (
          <section className={styles.comparison} key={schedule.planId}>
            <h3>
              {plan?.data.kind === "plan" ? plan.data.name : "Plan"} ·{" "}
              {change.status === "applied"
                ? "Applied schedule comparison"
                : "Review updated schedule"}
            </h3>
            {!previous && (
              <p className="small muted">
                No previous schedule was captured; only the staged result can be
                verified here.
              </p>
            )}
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Scene</th>
                    <th scope="col">Previous schedule</th>
                    <th scope="col">
                      {change.status === "applied"
                        ? "Applied schedule"
                        : "Staged schedule"}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.sceneId}>
                      <th scope="row">
                        Scene {(row.after ?? row.before)!.sceneNumber}
                        <p>
                          {row.changed
                            ? row.before
                              ? row.after
                                ? "Updated"
                                : "Removed"
                              : "Added"
                            : "Unchanged"}
                        </p>
                      </th>
                      <td>
                        {previous ? (
                          <ScheduleValue entry={row.before} />
                        ) : (
                          "Not recorded"
                        )}
                      </td>
                      <td>
                        <ScheduleValue entry={row.after} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!rows.length && <p>No scene assignments were generated.</p>}
            <p className="small muted">
              {schedule.days} day{schedule.days === 1 ? "" : "s"} ·{" "}
              {schedule.moves} location move{schedule.moves === 1 ? "" : "s"} ·{" "}
              {schedule.provisional ? "Preparation draft" : "Saved schedule"}
            </p>
            {schedule.conflicts.map((conflict, index) => (
              <p className="notice clay-notice" key={index}>
                {conflict}
              </p>
            ))}
          </section>
        );
      })}
      <section className={styles.comparison}>
        <h3>Saved decisions</h3>
        {!preservation ? (
          <p className="small muted">
            This revision has no saved decision baseline, so preservation cannot
            be verified here.
          </p>
        ) : !preservation.choices.length && !preservation.answers.length ? (
          <p className="small muted">
            No saved location choices or answers were in this revision’s
            baseline.
          </p>
        ) : (
          <div className={styles.preserved}>
            {preservation.choices.map(({ saved, current, unchanged }) => (
              <div key={`${saved.planId}:${saved.sceneId}`}>
                <p>
                  <strong>
                    {sceneLabel(snapshot, saved.sceneId)} ·{" "}
                    {locationLabel(snapshot, saved.locationId)}
                  </strong>
                </p>
                <span
                  className={`badge ${unchanged ? "moss-badge" : "clay-badge"}`}
                >
                  {unchanged
                    ? saved.locked
                      ? "Location and lock unchanged"
                      : "Location choice unchanged"
                    : "Choice changed since review"}
                </span>
                {proposedMembership &&
                  saved.planId === change.targetId &&
                  !proposedMembership.has(saved.sceneId) && (
                    <p>Saved outside the proposed scene set.</p>
                  )}
                {!unchanged && (
                  <p>
                    {current
                      ? `Current choice: ${locationLabel(snapshot, current.locationId)} · ${current.locked ? "locked" : "unlocked"}`
                      : "The saved choice is no longer present."}
                  </p>
                )}
              </div>
            ))}
            {preservation.answers.length > 0 && (
              <div>
                <details open={preservation.answers.length <= 3}>
                  <summary>
                    Saved production answers ({preservation.answers.length})
                  </summary>
                  {preservation.answers.map(({ saved, current, unchanged }) => (
                    <div key={saved.id}>
                      <p>
                        <strong>
                          {current?.data.kind === "question"
                            ? current.data.prompt
                            : "Saved production answer"}
                        </strong>
                      </p>
                      <p>{saved.answer || "No answer recorded"}</p>
                      <span
                        className={`badge ${unchanged ? "moss-badge" : "clay-badge"}`}
                      >
                        {unchanged
                          ? "Answer unchanged"
                          : "Answer changed since review"}
                      </span>
                      {!unchanged && (
                        <p>
                          Current answer:{" "}
                          {current?.data.kind === "question"
                            ? current.data.answer || "Unanswered"
                            : "No longer present"}
                        </p>
                      )}
                    </div>
                  ))}
                </details>
              </div>
            )}
          </div>
        )}
        <p className="small muted">
          Compared with the saved choices and answer revisions captured for this
          review. Concurrent edits are checked again when applying or undoing.
        </p>
      </section>
    </>
  );
}
