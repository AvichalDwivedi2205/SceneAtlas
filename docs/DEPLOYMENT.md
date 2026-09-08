# SceneAtlas deployed development environment

Last verified: September 8, 2026.

The September 8 deployment uses Parallel Search and Extract only. Vercel deployment `dpl_GGiFhkwAxUyKasNd4mjXwdhJAXrv` is ready, Convex functions deployed at 19:31 IST, Cloud Run revision `sceneatlas-agent-bridge-00009-s6l` serves all traffic, and Agent Engine update operation `7468039471577956352` completed. Runtime metadata contains only the callback and Parallel secret bindings; obsolete provider access was removed from the agent service account. Cloud Run health returns HTTP 200.

Validation of this update: 58 Python tests and 26 app tests pass, with clean typecheck/lint and two passing hosted preview tests. The default local Turbopack build encountered a process/port restriction; the local Webpack production build and Vercel's default Turbopack production build both passed. Full hosted one-scene acceptance passed in 1.8 minutes: screenplay upload, intake, scene generation, sourced location research, requirements, schedule, and authenticated PDF download. All saved sources report `parallel`. Research run `ks72q9k9c7dsjhxywp0bx464k98e0gfm`, requirements run `ks7ffjgz52pcwye31yaedr3mrd8e0yna`, and packet run `ks709a8a71b93ev4n7f7n0w0m58e1dgj` completed. Source evidence carries search IDs `search_a0a2edc3aa5d5bf09d685e5c06753356` and `search_cb7ea080c2bbb03450355a1025fcc3ac`. The disposable board was archived and its test user removed. Older managed run records below remain dated evidence.

| Resource | Value | State |
| --- | --- | --- |
| Web | `https://sceneatlas-black.vercel.app` | Authenticated workspaces and preview live |
| Convex | `oceanic-ladybug-337` | Functions deployed |
| Convex site | `https://oceanic-ladybug-337.convex.site` | Signed agent callbacks live |
| Google Cloud project | `sceneatlas-avd-260906` | Billing and required APIs enabled |
| Region | `us-central1` | Active |
| Agent Engine | `projects/245638196984/locations/us-central1/reasoningEngines/2253688224905953280` | Ready |
| Cloud Run bridge | `https://sceneatlas-agent-bridge-x4lfgrmrha-uc.a.run.app` | Ready |
| Cloud Tasks queue | `sceneatlas-runs` | Ready |
| Parallel key | Secret Manager `sceneatlas-parallel-api-key` | Live Search and Extract verified |
| Clerk | Dedicated SceneAtlas development application | Keys synced; verified email sign-in enabled |

Verified cloud boundaries:

- Cloud Run `/health` returns HTTP 200.
- Unsigned `/dispatch` requests return HTTP 401.
- A correctly signed dispatch returns HTTP 202 and creates a deterministic Cloud Task.
- Cloud Tasks reaches `/work` with Google OIDC.
- Managed Agent Engine ingested an original one-scene test screenplay through Cloud Tasks and signed Convex callbacks, called Gemini, and published its summary and clarification question. Run: `ks7fzc17dar3674hk1yk85rphd8dxtzx`.
- Three isolated browser sessions passed real Clerk sign-in, workspace creation, recipient-bound editor/viewer invitations, shared note updates, presence, reload persistence, and server rejection of viewer writes.
- Full hosted workflow acceptance passed: screenplay upload, confirmed intake, one editable scene, sourced location research, selected-location requirements refresh, provisional schedule, and authenticated PDF download. Real run IDs are recorded below.
- The 12-node interactive sample canvas passes navigation and evidence-inspection tests. Clerk development builds can emit provider development/telemetry warnings.
- Real PDF scale acceptance passed: a 20-page PDF produced 28 scenes and recovered from a deliberate cancellation; the complete 124-page screenplay produced all 202 scenes across 34 saved batches. Two users shared the board, reload and last-scene navigation passed, and every source record was checked. See [full screenplay evidence](SCREENPLAY_SCALE.md).

The September 7 deployment uses Vercel `dpl_DeumcpM9zYnkRDkPtGeyaLkn4PAW`, Cloud Run revision `sceneatlas-agent-bridge-00008-s4d`, and managed Agent Engine update operation `3596222798940340224`. Convex functions were last deployed at 20:21 IST for the original scale acceptance run.

Agent reliability improvements include bounded model-draft repair, compact URL references with canonical evidence hydration, and isolated specialist requests. ADK's `include_contents="none"` still includes earlier events from the current turn, so each batch now explicitly receives only its current authoritative context. Unvalidated drafts stay inside the coordinator. The bridge uses the SDK's actual asynchronous transport so concurrent runs and heartbeats remain responsive. Complete calculated schedules publish directly with their provisional status; repeated answered questions must be repaired before publication. These changes pass 45 Python tests. A real-model, full-agent component run verified all 202 scenes across 34 batches in 266 seconds, including a successful repair, without streaming raw drafts.

Managed acceptance evidence (one original illustrative screenplay, September 6):

| Stage | Completed run |
| --- | --- |
| Ingestion | `ks7ejhqs34m68pavmxhrf4ghes8dwhe5` |
| Scenes | `ks79t7g0mxdk37n7vfqz1aw1t58dw10e` |
| Location research | `ks70qchbnrx4b0y1d7qarv38118dwmjj` |
| Requirements | `ks7fjvwzj0wssjy5wrvhgfwqz18dw6ep` |
| Schedule | `ks791ky91y8v4a13ebm17s5cps8dx4m7` |
| Preparation packet | `ks7b5gjtvx72g75b7z26wxhahh8dx8c2` |

The browser downloaded an eight-page PDF; packet entity `jx74586my3th0dbrw5kh722wkh8dwhhz`. The disposable board was archived and its Clerk user removed. Final source-scope, assumed-cost labeling, and PDF pagination fixes were additionally checked with regression tests and a local replay of those same records. This is one-scene integration evidence, not multi-scene or production-scale acceptance.

Clerk keys and issuer are configured in Vercel and Convex. These are development-instance credentials. A production Clerk instance requires its own matching keys and configured domain.

Parallel uses `sceneatlas-parallel-api-key` in this project's Secret Manager. Its value was copied from the user's existing Parallel secret in `slatetrace-avd-260822`; the managed agent receives it as `PARALLEL_API_KEY`. Search and Extract run only on the agent backend. No provider key is exposed to browsers. Current source and deployment scripts configure no alternate web research provider. Capacity limits, exhausted transient retries, and authentication/configuration errors remain visible. Sources retain their actual Parallel request ID, retrieval time, and cache state. The deployed managed agent configuration was inspected after update and contains no alternate provider binding.

Run live collaboration acceptance explicitly with:

```sh
SCENEATLAS_LIVE_E2E=1 bunx playwright test e2e/live-collaboration.spec.ts
```

Set `SCENEATLAS_E2E_URL=https://sceneatlas-black.vercel.app` to exercise the hosted web app. The test creates disposable Clerk test accounts, archives its board, and deletes its test accounts. It disables auth traces and screenshots containing sign-in material.

Run full cloud workflow acceptance with `SCENEATLAS_LIVE_WORKFLOW=1 bunx playwright test e2e/live-workflow.spec.ts`. This uses ordinary Gemini/Parallel quota, confirms explicitly illustrative production inputs, and downloads a draft PDF through the signed-in browser.

Loading feedback follows the supplied olive/brass/clay design: route skeletons, measured file upload, queued/running/waiting/failed/completed tasks, per-action pending labels, search and source-checking activity, assistant responses, save/reconnect status, collaborator access changes, file downloads, and reduced-motion transitions. Percentages appear only for measurable byte transfer. Paused tasks resume after all relevant answers; staged revisions track the replacement run and retain conflict checks for collaborator edits.

Convex currently warns that the account is above Free-plan limits. Resolve account usage or choose a paid plan before relying on uninterrupted public access.

PDF validation includes readable table headers, per-item rate × quantity and totals, producer-confirmed inputs, original retrieval dates for reused evidence, and fee-source links. Unit tests cover quantity conflicts, mixed-currency totals, and assumptions that must remain estimates. Official requirements use CFC state-permit guidance or the named park’s own official page; unrelated park references remain unverified.

Remaining release work: official-form drafting and a ZIP bundle are not implemented; the current export is a preparation PDF plus JSON manifest and official guidance links. Full-script intake/breakdown/canvas scale is now verified. Research, scheduling, and packet generation across every scene of a feature, broader revision/regeneration acceptance, and production Clerk configuration still need completion or validation. The application does not submit permit applications or represent external approval.
