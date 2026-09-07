# SceneAtlas recorded hackathon demo

Recorded September 7, 2026, against https://sceneatlas-black.vercel.app.

The completed silent master is **2:55, 1920 × 1080, 30 fps, H.264**. It leaves five seconds below the PRD's three-minute limit. The user will add the voiceover; no generated narration or music is included.

## Delivered story

Open on the actual 202-scene graph to establish scale, then show the full PDF upload and producer-confirmed breakdown. At 0:44, an explicit “Focused planning example” transition introduces the original one-scene *Coastal Rehearsal*. Follow live location research, inspect its sources, select and lock Point Dume State Beach, revise the production start, receive a teammate's note, and download the preparation PDF.

The full-length test uses the 124-page *Big Fish* screenplay from [John August's library](https://johnaugust.com/library). The upload and 202-card result belong to the same recorded board. Every scene number, heading, source span, and excerpt matched the independently reviewed inventory; the final scene reaches physical PDF page 124. The input PDF and full screenplay text are not bundled into the delivery kit. This is source-test attribution, not a claim of a public-demo license.

The scale sequence proves full-script intake, breakdown, and canvas navigation. Research, schedule revision, collaboration, and export are demonstrated on the separately labeled original scene. The film's 202 scenes have not all been researched, scheduled, or exported.

## Actual timeline

| Time | Shot | Voiceover cue |
| --- | --- | --- |
| 0:00–0:08 | Full-Script Scale | A full screenplay becomes one connected production workspace. |
| 0:08–0:16 | Start With The Screenplay | Upload the entire screenplay to a private board. |
| 0:16–0:26 | Producer Stays In Control | The agent asks which scenes to break down. Your answer stays attached. |
| 0:26–0:32 | Visible Work In Progress | The board shows the work happening in the background. |
| 0:32–0:39 | Complete Breakdown | All pages were read and every scene was checked against the source inventory. |
| 0:39–0:44 | Find Any Scene | Use the scene index to reach the end of the script. |
| 0:44–0:56 | Focused Planning Example | Now follow one original coastal scene through planning. Confirm the crew and equipment before research. |
| 0:56–1:04 | Research Real Locations | SceneAtlas researches locations against the scene and confirmed production needs. |
| 1:04–1:11 | A Location With Evidence | The result explains why a real location fits the scene. |
| 1:11–1:21 | Check The Source | Open its source evidence. Unknown availability and costs remain explicit. |
| 1:21–1:31 | Make A Production Decision | Choose the location for this plan and lock it while the rest of the plan evolves. |
| 1:31–1:39 | Build The Shooting Plan | The chosen location feeds a proposed shooting order. |
| 1:39–1:55 | One Change, Clear Consequences | The cast needs a later start. Change the day's start time and review affected outputs. |
| 1:55–2:01 | Refresh Affected Work | Regenerate the schedule using the new confirmed input. |
| 2:01–2:10 | Review And Apply | Apply the revised result. The schedule moves later; setup time, the locked location, and earlier answers stay intact. |
| 2:10–2:22 | Work Together | A second teammate adds a production update. It reaches the shared board without a reload. |
| 2:22–2:27 | Prepare The Handoff | Prepare the handoff from the current plan. |
| 2:27–2:39 | Download The Result | Download the preparation PDF with sources, decisions, and unresolved questions. |
| 2:39–2:46 | Downloaded PDF | This is a preparation draft for review. External permission and unverified items still need confirmation. |
| 2:46–2:55 | SceneAtlas | SceneAtlas keeps the screenplay, research, and team decisions connected through the handoff. |

## Acceptance evidence

The exact complete browser path passed twice consecutively (`rehearsal-8`, `rehearsal-9`) before capture. The final recorded pass also passed all assertions, with 19 recorded shot markers and no browser errors. The edit uses 18 of those shots plus the actual downloaded PDF and a closing card.

| Recorded assertion | Result |
| --- | --- |
| Full upload and scene breakdown | 124 physical PDF pages, 202 verified scenes, 34 batches |
| Full-script breakdown duration | 325.6 seconds in this recorded run; processing waits are cut and labeled |
| Location research | Real Parallel sources; provider and source links remain visible |
| Principal revision | Production start 08:00 → 09:00; first scene 08:15–09:15 → 09:15–10:15 |
| Preserved inputs | Locked location, saved producer answer, and 15-minute setup offset retained |
| Collaboration | Two independent authenticated accounts; editor note reaches owner's visible board without reload |
| Export | Actual six-page preparation PDF downloaded through the signed-in UI |

Recorded cloud runs:

| Stage | Run ID |
| --- | --- |
| Original scene · ingest | `ks77vdzsv62a1axc3r6rkx128d8dzaan` |
| Full screenplay · ingest | `ks7c43vbnbph4p04rxf0s6k07d8dzgg1` |
| Original scene · scenes | `ks706jfwt2799j3zrm237ntan58dyrnf` |
| Original scene · research | `ks72f4afmyepmce68wbnvvgtm18dyaj4` |
| Original scene · schedule | `ks7e3ybpa6gx2zzqn7v0cgcm198dya06` |
| Original scene · schedule | `ks77a1heryyb0jsjyxjhj4zk558dy66s` |
| Original scene · packet | `ks7eveygfd4w99tfwbfbh142fs8dy3et` |
| Full screenplay · scenes | `ks76chfsze6zsrekvjrte96keh8dz5hk` |

The recorded research used Parallel search `search_ae82d6d2e7729c5dfa8a7f4ffa3ca3e5`, including California State Parks and California Film Commission sources. Exa remains an enabled fallback, but did not supply this recorded result. Costs, availability, and permission uncertainties stay visible; the PDF is a preparation draft. No official-form drafting, application submission, external approval, or generated ZIP permit bundle is claimed.

## Production and delivery

[`scripts/record-demo.mjs`](../scripts/record-demo.mjs) captures the real hosted app using Playwright, asserts the workflow, records source timestamps and cloud run references, and gates recording on two successful full rehearsals. Demonstrated writes occur through the UI. Read-only backend snapshots verify results. Auth setup and invitation preparation are outside the final cuts.

[`scripts/edit-demo.py`](../scripts/edit-demo.py) assembles the footage with FFmpeg and restrained graphics matching the olive/brass interface. It preserves action speed. Long waits and intermediate navigation are cut, and short visual holds can repeat the final frame. The revision chapter keeps the apply click and the final revised schedule. The document shot renders the PDF actually downloaded by the app.

Local deliverables (media are intentionally ignored by Git):

- `artifacts/demo-video/sceneatlas-silent.mp4`: completed 2:55 master.
- `artifacts/demo-video/chapters/`: 20 separate MP4 clips for editing around the voiceover.
- `artifacts/demo-video/timing.md`: time ranges and optional narration cues.
- `artifacts/demo-video/preparation-packet.pdf`: actual six-page downloaded draft.
- `artifacts/demo-video/evidence.json`: sanitized run, source, rehearsal, editing, and media-verification evidence.
- `artifacts/demo-video/sceneatlas-demo-kit.zip`: master, chapters, timing, readme, evidence, and preparation PDF.

Raw browser recordings remain local and are excluded from the delivery archive because they include off-camera invitation setup. The original screenplay, credentials, and auth state are also excluded. All 22 disposable rehearsal/recording boards were archived, the two demo actors deleted, and their local browser auth files removed.

Final media verification is recorded in the delivery's `evidence.json`: frame inspection across all chapters, exact frame count/dimensions, full decode, and native playback completion. Voiceover synchronization and subtitles remain the next editing step after the user records narration.

## Recording approach and research


Use agent-authored Playwright browser automation to operate the hosted application and capture its actual UI. Set both viewport and recording dimensions explicitly to 1920 × 1080; Playwright otherwise scales its default recording into an 800 × 800 area. Close the browser context to finalize each video. [Playwright video documentation](https://playwright.dev/docs/videos)

Assemble the selected footage with the existing local FFmpeg installation. Use restrained cursor emphasis, deliberate holds, chapter labels, and cuts over long waits. Playwright is already a project dependency; FFmpeg and ffprobe are available locally. This route required no new recording-service account or API key. Live product runs still use the existing application providers and their ordinary quotas.

Other approaches researched:

| Approach | How it works | Fit for this demo |
| --- | --- | --- |
| Screen Studio | Records the real screen, adds automatic zoom and smooth cursor motion, and supports manual focus and trimming. | Strong option for a person recording on this Mac. Its capture polish is automation, not evidence that an AI agent operated the app. [Official product page](https://screen.studio/) |
| Tella | Records clips, then offers AI mistake/silence/filler removal and editable automatic zooms from eligible desktop recordings. | Useful all-in-one editor. Preserve intentional visual holds when preparing silent footage. [Editing guide](https://www.tella.tv/help/editing/edit-a-video) |
| Tella with an AI agent | Its published walkthrough shows an agent using MCP to cut an existing recording, add zooms, and apply a reusable editing skill, followed by visual review. | Concrete example of AI-assisted demo editing. It requires a connected Tella account; this plan does not depend on one. [Official walkthrough](https://www.tella.tv/video/vid_cmqgi0h7j000r04jq4df65nh8/view) |
| Descript | Combines screen capture with transcript-based editing and AI cleanup. | More useful once the user's voiceover exists; speech-based editing provides less value for the silent master. [Screen recording workflow](https://www.descript.com/screen-recording) |
| Remotion with an AI agent | Provides skills for creating compositions, animation, captions, and renders through code. | Optional for custom motion graphics around recorded footage. FFmpeg is sufficient for the first edit. [Official agent skills](https://www.remotion.dev/docs/ai/skills) |

These are documented capabilities and workflow examples, not a hands-on comparison of every editor. The completed production route used Playwright plus FFmpeg.
