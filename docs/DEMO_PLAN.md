# SceneAtlas demo recording plan

Prepared September 7, 2026. Research and storyboard are ready; no footage has been recorded for this plan.

## Recommendation

Produce a 2:55 silent, 1920 × 1080, 16:9 H.264 MP4 with separate chapter clips and voiceover timing notes. The user will record and add the voiceover. The PRD allows at most three minutes, so the edit leaves five seconds of headroom.

Show the 202-scene canvas for about seven seconds to establish scale, then focus on readable cards and a complete production decision. The main claim is: **SceneAtlas turns a screenplay into a shared planning workspace where research, choices, and preparation documents remain connected.**

The 124-page / 202-scene result proves full-script intake and breakdown. The currently verified decision-to-export workflow uses a separate, original one-scene screenplay. Until the combined workflow is verified, use an explicit transition into “Focused planning example.” Do not imply that all 202 scenes have completed research, scheduling, and packet generation.

## Recording approach and research

Use agent-authored Playwright browser automation to operate the hosted application and capture its actual UI. Set both viewport and recording dimensions explicitly to 1920 × 1080; Playwright otherwise scales its default recording into an 800 × 800 area. Close the browser context to finalize each video. [Playwright video documentation](https://playwright.dev/docs/videos)

Assemble the selected footage with the existing local FFmpeg installation. Use restrained cursor emphasis, deliberate holds, chapter labels, and cuts over long waits. Playwright is already a project dependency; FFmpeg and ffprobe are available locally. This route requires no new recording-service account or API key. Live product runs still use the existing application providers and their ordinary quotas.

Other approaches researched:

| Approach | How it works | Fit for this demo |
| --- | --- | --- |
| Screen Studio | Records the real screen, adds automatic zoom and smooth cursor motion, and supports manual focus and trimming. | Strong option for a person recording on this Mac. Its capture polish is automation, not evidence that an AI agent operated the app. [Official product page](https://screen.studio/) |
| Tella | Records clips, then offers AI mistake/silence/filler removal and editable automatic zooms from eligible desktop recordings. | Useful all-in-one editor. Preserve intentional visual holds when preparing silent footage. [Editing guide](https://www.tella.tv/help/editing/edit-a-video) |
| Tella with an AI agent | Its published walkthrough shows an agent using MCP to cut an existing recording, add zooms, and apply a reusable editing skill, followed by visual review. | Concrete example of AI-assisted demo editing. It requires a connected Tella account; this plan does not depend on one. [Official walkthrough](https://www.tella.tv/video/vid_cmqgi0h7j000r04jq4df65nh8/view) |
| Descript | Combines screen capture with transcript-based editing and AI cleanup. | More useful once the user's voiceover exists; speech-based editing provides less value for the silent master. [Screen recording workflow](https://www.descript.com/screen-recording) |
| Remotion with an AI agent | Provides skills for creating compositions, animation, captions, and renders through code. | Optional for custom motion graphics around recorded footage. FFmpeg is sufficient for the first edit. [Official agent skills](https://www.remotion.dev/docs/ai/skills) |

These are documented capabilities and workflow examples, not a hands-on comparison of every editor. The proposed production route is Playwright plus FFmpeg.

## Storyboard

Times below are edit targets. Record real action durations first, then choose cuts and holds against those recordings. Do not globally accelerate the master.

| Time | Entry state and action | Success assertion | Voiceover point and hold |
| --- | --- | --- | --- |
| 0:00–0:08 | Open the completed scale board; fit the graph to show the scene grid and its count. | Count matches the verified source inventory. The graph is loaded and interactive. | “A feature-length screenplay becomes one connected workspace.” Hold the wide view for about seven seconds. |
| 0:08–0:32 | Cut back to a new workspace. Upload the full 100+ page PDF, show real reading progress, and answer scope plus one consequential producer question. | Filename, page count, actual task state, and saved answer are visible. | Establish a real full-file upload and producer control. Cut over processing with an elapsed-time label derived from that take. |
| 0:32–0:50 | Show completed breakdown; use the script index to jump to the final scene, then focus one readable card. | The last scene reaches the last screenplay page; heading and page span match the source. | Prove completeness and navigation. Hold the focused card long enough to read its heading and page span. |
| 0:50–1:22 | Transition visibly to “Focused planning example.” Use the original coastal scene, start location research, show searching/source-checking states, then inspect a returned location and its evidence. | A real provider event produced the displayed results; source link and retrieval/provenance details are present. | Show research informing a choice. Hold the evidence panel for at least five seconds. |
| 1:22–1:48 | Inspect Budget and Creative plan settings. Select and lock a researched location for the chosen plan; inspect costs and provisional shooting order. | The choice persists; displayed costs retain their evidence or estimate labels. Unknown availability remains visible. | Explain one concrete tradeoff. Only claim a calculated comparison if both branch outputs have been generated and checked. |
| 1:48–2:17 | Change one producer answer or location filter; preview affected outputs, regenerate, and apply the revision. | The intended output updates; an unrelated saved answer and locked choice remain intact. | Show one change propagating through its dependencies. This scene requires additional live acceptance before recording. |
| 2:17–2:34 | Keep two authenticated people on the same board. Have the editor add a short note while recording the owner's view; briefly show the two views together if useful. | Presence shows both people; the owner's view receives the editor's note without reload. | “The team can work together or follow along.” Hold the arriving note for four seconds. |
| 2:34–2:55 | Open Preparation packet, download the current chosen plan's PDF, and show the downloaded document with a source and an unresolved item. Close on the app name and hosted URL. | The download succeeds and the PDF reflects the current plan. It is labeled a preparation draft. | Close on a useful deliverable. Leave the final frame for three seconds. |

If the revision sequence does not pass its live checks, replace that scene with a visibly labeled requirements refresh and a longer evidence inspection. Record the resulting feature scope accurately in the submission; this replacement does not mean the PRD's revision acceptance is complete.

## Scale footage and sample screenplay

The measured full-length test used the 124-page *Big Fish* PDF and produced 202 scenes. Its breakdown took 250.4 seconds; upload/intake took another 32.6 seconds. These are separate measurements from one test, not a promise for a new recording. See [full screenplay evidence](SCREENPLAY_SCALE.md).

For the public recording, prefer an original or otherwise cleared full-length screenplay. Show its actual resulting count; do not pad a script to force 202 cards. If the public sample differs, label the 202-scene result as separate scale-test evidence. Do not connect an upload of one file to the results of another without an explicit transition.

The original one-scene “Coastal Rehearsal” fixture in `e2e/live-workflow.spec.ts` is available for the focused planning sequence. It uses explicitly illustrative production inputs. Keep those labels and do not present test assumptions as verified prices, access, or approvals.

The previous scale and workflow boards were archived and their disposable users deleted. Prepare fresh recording boards and authenticate before the timed sequence. Existing screenshots can serve as labeled historical evidence, not as a substitute for recorded interaction.

## Preparation and verification

1. Select the full-length public sample and review its expected scene inventory. Confirm the exact public URL is `https://sceneatlas-black.vercel.app`.
2. Prepare scale and focused-planning boards, with two authenticated people for the collaboration shot. Keep auth state outside the repository and outside the video frame.
3. Rehearse the exact visible UI path, including actions that prior integration tests invoked through APIs. Those tests are useful backend evidence but do not replace a click-by-click recording rehearsal.
4. Verify branch comparison and the one principal revision, including preserved answers and choices. Current broader revision acceptance remains incomplete. Check current provider/Convex quota headroom before long live runs; the last deployment report recorded exceeded Free-plan usage.
5. Complete two consecutive successful dry passes. The recording skill explicitly requires: “Do not record until the complete path works twice consecutively.” See the local [demo-video-producer skill](/Users/avichaldwivedi/.codex/skills/demo-video-producer/SKILL.md).
6. Record with normal action timing and the actual loading states. Log scene boundaries and real elapsed durations. Include real Parallel use for the submission story; if Exa serves a fallback, preserve its visible provenance and do not describe that result as Parallel.
7. Edit into the target timeline. Preserve the application's olive, brass, and clay visual style. Favor full-screen product footage, readable cards, restrained zooms, and short editorial labels. Keep loading cut labels separate from application-generated status text.
8. Inspect the whole silent master, sample frames throughout, and verify H.264, dimensions, duration, and successful playback. Hand over timing notes and separate chapter clips for the user's voiceover. Check voiceover synchronization and subtitles after the user adds audio.

The current export is a preparation PDF with a JSON manifest and official guidance links. Official-form drafting, ZIP export, and external submission/approval are not part of the recorded claim.

## Planned deliverables

- `artifacts/demo-video/sceneatlas-silent.mp4`: the 2:55 master.
- `artifacts/demo-video/chapters/`: separately editable scene clips.
- `artifacts/demo-video/timing.md`: actual in/out times and concise voiceover cues.
- `artifacts/demo-video/evidence.json`: source page/scene counts, real run references, measured waits, and rehearsal results; no credentials or auth state.

These paths describe future recording outputs. This planning task has not generated those files.
