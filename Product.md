# SceneAtlas — Product Requirements Document

Working name: **SceneAtlas**  
Promise: **From screenplay to a researched shooting plan.**  

## 1. Product goal

Help a producer turn a screenplay into location choices, a proposed shooting order, and a reviewable permit preparation packet. The user creates and opens a workspace, drops a screenplay PDF onto its infinite canvas, and builds a connected production plan from a persistent script node. Script-level questions and saved answers belong to that node. Generated scenes branch beneath it; each scene owns its questions, answers, filters, and connected outputs. Two plan branches show the tradeoffs between a fixed budget and no fixed budget cap.

The central demonstration is a complete decision: describe production priorities, answer necessary questions, compare researched options, select locations, revise the plan, and export useful paperwork.

Location research, permissions, costs, logistics, and contingency planning are established location-management responsibilities. This MVP supports their research and preparation stages. [ScreenSkills role description](https://www.screenskills.com/skills-checklists/scripted-film-and-tv/location-department/location-manager-skills/)

## 2. Release boundaries

- Primary user: an independent producer or small production team.
- Demo workload: one screenplay containing scenes.
- Each workspace preserves its uploaded screenplay, node connections, questions, answers, filters, selections, results, and canvas layout when reopened.
- Supported permitting scope: a small set of California Film Commission state-property locations, with location-specific requirements researched from official sources. Unsupported jurisdictions are identified explicitly.
- Two plan branches can research and populate concurrently: **Budget plan** and **Creative plan**. Names are editable.
- Candidates per scene: configurable from 1–5, initially shown as 3. This is a requested maximum; results may be fewer when evidence or suitability is insufficient.
- Budget covers location hire, permits, and required location-related services and other required things for budgeting.
- Plan output is a proposed order and timing for the selected scenes. Venue availability, permissions, and unquoted costs retain their actual verification status.

## 3. Core experience

**Create workspace → open empty canvas → drop screenplay PDF → ingestion transition and agent states → script node with clarification questions → saved answer nodes → generated scene groups with their own questions → connected scene outputs → compare and select → shooting plan and preparation packet.**

The same workspace evolves through these stages. Answered questions stay attached to their owning node as new scenes and outputs appear. The script node becomes a scene index: choosing an entry focuses that scene's position on the canvas.

The primary hierarchy follows the supplied wireframe: **script group → scene groups → scene-specific outputs**. Each group contains its main node and connected answer nodes or chips. Locations, costs, requirements, and documents connect below the scene they support; shared results can link to several scenes.

Users can start with one plan and add a comparison. Budget and Creative plan frames connect to the scene selections as downstream planning outputs. Shared script facts, questions, and answers remain in the main tree; each plan retains its own budget, preferences, selections, and schedule.

## 4. Required features

### A. Workspace creation, upload, and script breakdown

Create a named workspace and open its empty infinite canvas. Provide a clear PDF drop target, a file-picker alternative, and a paste-text option. Dropping a text-based screenplay PDF creates its script node and starts ingestion. An unreadable or failed upload shows a specific error and retry action while preserving the workspace.

Show a transition screen during ingestion, with the uploaded filename and actual processing stages: uploading, reading screenplay, and identifying clarification needs. Transition back to the same canvas with the script node in place. Keep ongoing work visible through a compact workspace activity indicator and status labels on the relevant nodes.

Present script-level clarification questions on the script node. Once questions needed for scene generation are answered, enable **Generate scenes**. Create editable scene nodes containing scene number, original excerpt, fictional setting, interior/exterior, day/night, and location needs. Preserve links to the script page or excerpt and links from the script index to each scene's canvas position.

Collect production details through the appropriate node's questions: permitted search area, shooting dates, crew size, equipment, budget scope and currency, and relevant access or timing constraints. Workspace-wide details belong to the script node; scene-specific details belong to that scene. Collect expected scene durations and availability when needed for scheduling.

Script content can suggest questions but cannot establish real production choices. An aerial description, for example, does not confirm that the crew will use a drone. The producer confirms activities that affect research, costs, or paperwork.

### B. Agent clarification

**The agent must ask questions instead of silently filling material gaps.** This applies to missing facts, ambiguous instructions, conflicting constraints, and choices needed to proceed.

- Display questions directly on their owning script or scene node. A separate chat panel can help explore a question, but the question and its resolution remain visible in the canvas group.
- Keep each answered question and the user's original answer as an editable connected answer node or chip. Also show the interpreted planning rule where relevant. Answers remain available after generation, regeneration, and reopening the workspace; an edit retains the previous answer in revision history.
- Generated scenes ask their own questions before producing dependent outputs. Show inherited script-level answers and clearly identify any scene-specific overrides. Ask before resolving an override that conflicts with a confirmed shared constraint.
- Ask focused questions with short suggested answers and a free-text option. Batch up to three related questions when useful.
- Explain briefly which decision needs the answer. Do not ask again when the answer already exists in the relevant scope.
- Continue independent work while waiting. Mark dependent results as awaiting an answer.
- If the producer does not know, retain an explicit unknown and explain the next verification step. Do not invent a fee, availability, approval, duration, or operational detail.
- Distinguish information read from the script, confirmed by the user, retrieved from a source, and supplied as an estimate.
- Clarify primary priorities when instructions conflict. Do not silently relax a hard constraint.
- Store answers at project, branch, or scene scope. Make the scope visible and allow corrections.
- Reuse valid answers during regeneration. Ask a follow-up only when a new decision needs information, an answer has become invalid, or a conflict appears.

Example: “You requested a two-day shoot, but scene durations are missing. What duration should we plan for each scene?” If the user wants estimates, request that choice and label the resulting schedule provisional.

### B1. Visible agent states

Show node states for **Queued**, the current activity (such as **Reading script**, **Generating scenes**, **Researching locations**, **Checking requirements**, or **Planning schedule**), **Needs your answer**, **Complete**, **Needs refresh**, **Failed**, and **Cancelled**. The workspace activity view summarizes which nodes are working, waiting, or need attention and links directly to them.

A node waiting for an answer must not block unrelated scene work. Progress reflects actual completed stages; do not invent percentage completion. Failed tasks offer retry, and running tasks offer cancellation. Preserve completed work and saved answers. A completed agent task describes processing status, not permit approval or confirmed location availability.

### C. Infinite canvas

Automatically arrange the script node at the root, with scene groups branching beneath it as in the supplied wireframe. Within each group, connect saved answer nodes to the main script or scene node; connect generated locations, costs, requirements, and documents to the scene that produced them. Provide pan/zoom, fit selection, multi-select, collapsible groups, and a scene navigator. Save the workspace and layout.

Plan comparisons sit in clearly labeled frames connected to the scene selections. Each frame has its own budget and comparison summary. A location may serve several scenes; links must make this visible. Shared factual records can appear in both branches while planning decisions remain independent.

Default detail shows the script, scenes, unresolved questions, selected locations, and blockers. Collapse answered questions into labeled chips; expand them to review the original question, answer, scope, and edit action. Users should not need to arrange cards before making a decision.

Generation adds or updates connected outputs in place, preserving manual layout and existing answers. Clicking a question, status, scene-index entry, or dependency focuses the relevant node. A scene's **Generate** or **Regenerate** action applies to its dependent outputs, with broader plan effects shown explicitly.

### D. Live location research and selection

For each scene, research up to the requested number of suitable real locations. Candidate cards show:

- Name, address or verified location description, source links, and real source-linked imagery where available.
- Creative fit and the reasons for the match.
- Published access restrictions, relevant authority, and availability status.
- Known fees, estimates, quote requirements, and missing information.
- Other scenes the same location could accommodate.

Users can select and lock one location per scene, reject a candidate, or request alternatives. Insufficient results produce an explanation and an option to broaden the search. Research does not imply permission or booking availability.

Candidate cards, selected locations, cost entries, requirement checklists, and preparation documents appear as connected outputs in the owning scene group. Show each output's status and the answers or filters it depends on. An unanswered scene question holds only the outputs that require its answer.

### E. Budget and natural-language priorities

Provide **Fixed budget** and **No fixed cap**, plus a visible amount/currency field where applicable. The budget is for the entire branch, not a separate allowance for each scene. No fixed cap preserves cost visibility and all non-budget constraints.

Primary planning input: **“Describe your ideal shoot.”** Preset chips provide quick starts: lower cost, fewer moves, finish sooner, and best visual fit.

Convert natural-language requests into editable rules showing scope, value, and whether each is a hard constraint or preference. Clarify ambiguous interpretations before using them. Support budget, dates, shooting hours, scene order, location choices, and travel preferences.

Expose filters beside their owning node: shared production filters at the script node, local requirements and candidate count at each scene, and budget/optimization settings at each plan. Inherited values display their origin. Support edits through both visible controls and natural language, followed by the same impact-preview and regeneration flow.

Location ranking can prioritize creative fit, lower estimated cost, or fewer location changes. Schedule ranking can prioritize lower estimated cost, fewer moves, or fewer shooting days. A schedule preference respects locked location choices; changing those requires a visible proposal.

Cost entries include their basis and unit: published fee, supplied quote, or labeled estimate; per hour, day, location, or application as applicable. Count shared expenses once when their coverage supports that. Additional booking days may add cost.

Branch summaries show budget cap, known costs, estimated costs, and unquoted items. Unknown costs are not zero. Missing material costs prevent a claim of confirmed budget compliance.

### F. Proposed schedule and plan comparison

Generate a proposed shooting order from selected locations and confirmed constraints. Consider scene grouping, location moves, access windows, daylight requirements, supplied duration estimates, and permit submission timing.

Hard constraints take precedence over ranking preferences. Missing critical inputs trigger questions; infeasible combinations produce a conflict explanation and specific alternatives.

Show the proposed order in a compact schedule attached to each branch: scene, location, time window, duration basis, and reason for its position. This is a limited scene-planning view rather than a full production scheduling suite.

Compare the branches on creative fit, known/estimated location costs, unquoted items, estimated shooting days, location moves, and unresolved blockers. Explain tradeoffs without claiming a mathematically global optimum. A lower-cost claim must identify the compared options and the completeness of their cost data.

### G. Scoped chat and change impact

Chat supports a scene, selected cards, one branch, or the whole project. The active scope remains visible beside the input. An ambiguous cross-branch request triggers a scope question.

The agent can explain evidence, answer planning questions, and propose changes. Before applying a material revision, show affected locations, scene order, requirements, cost entries, and documents. Provide an explicit apply action and undo.

Changes to shared production facts mark both affected branches for revalidation. Branch-specific revisions preserve the other branch. Exported or prepared documents become visibly out of date after relevant facts change.

### G1. Answer edits, filter changes, and regeneration

1. The user edits a saved answer, changes a filter, or describes a new requirement on a node.
2. Clarify ambiguous input, then show the revised rule and its scope. Highlight affected output nodes and connected plans, including dependencies shared with other scenes.
3. Mark affected results **Needs refresh** and retain the previous version for comparison. Show exactly what **Regenerate affected outputs** will update. Unrelated answers, outputs, and canvas positions remain intact.
4. Run the necessary dependent tasks with visible node states. Reuse existing valid answers and research; surface any newly required questions on their owning nodes.
5. Preview changed candidates, costs, requirements, documents, and schedules. Preserve locked choices; flag an incompatible lock and ask how to resolve it.
6. Apply the new result version and refresh dependent plan summaries. Allow undo to restore the prior answers, filters, and results together. Older in-progress runs must not overwrite results based on newer answers.

A scene filter edit may also affect a shared location, total budget, or cross-scene schedule. Show these dependencies rather than treating every scene as isolated. Preparing a new packet requires current results; an older packet remains labeled with the version it reflects.

### H. Permit readiness and export

For a selected location and activity, retrieve relevant official requirements, published lead times, forms, required attachments, and authority details. Link each requirement to its source, retrieval date, and applicable production facts. Conflicting or unavailable evidence remains an unresolved research item.

Keep document preparation status separate from external status. A completed draft is not a submitted application; a submitted application is not an approval. Approval status requires supporting confirmation.

Export the chosen branch as a preparation packet containing:

- Scene-to-location assignments and proposed shooting order.
- Location/permit cost breakdown with estimates and unknowns.
- Application answers, production activity summary, and equipment list based on confirmed information.
- Relevant official forms and supporting-document checklist.
- Requirement sources and unresolved questions.

Populate one supported official form where feasible, leaving missing fields and signatures unfilled. Government filing, payments, signatures, and approvals are outside the MVP.

## 5. Technology responsibilities

- **Gemini and the Google Cloud agent platform required by the event:** screenplay understanding, clarification, natural-language rule interpretation, planning explanations, and workflow orchestration.
- **Parallel Search API:** actual runtime discovery of locations, authorities, current requirements, and supporting evidence. Search must influence the displayed recommendations and requirements.
- **Parallel Extract, where useful:** read relevant public pages and PDFs found during research.
- **Application logic:** preserve workspace state and node relationships, original questions and answers, confirmed rules, and branch state; calculate comparable costs, check constraints, track affected outputs, and keep regeneration, revisions, and exports consistent.

Show progressive research results and clear failures. Reuse shared research across branches; label cached evidence and its timestamp. A failed lookup leaves an explicit unresolved item.

The track requires runtime Parallel Search use alongside the required Google technology. [Parallel track requirements](https://agentic-cinema.devpost.com/details/parallel-resources), [official rules](https://agentic-cinema.devpost.com/rules), [Search documentation](https://docs.parallel.ai/search/search-quickstart), [Extract documentation](https://docs.parallel.ai/extract/extract-quickstart)

Delivery includes a hosted English-language application, public source repository with an open-source license and run instructions, and a functioning-product demo of no more than three minutes.

## 6. Three-minute demonstration

1. **0:00–0:20:** Create and open a workspace, then drag a screenplay PDF onto the canvas.
2. **0:20–0:45:** Show the ingestion transition and agent states. Answer a consequential question on the script node; the answer remains attached to it.
3. **0:45–1:15:** Generate the scene groups. Focus a scene from the script index and answer its local question; connected outputs begin appearing.
4. **1:15–1:50:** Inspect a sourced location, select locations, and compare the Budget and Creative plan outputs.
5. **1:50–2:30:** Edit one scene's answer or location filter. Show affected nodes, regenerate dependent results, and apply the revision while preserving other answers and selections.
6. **2:30–3:00:** Inspect the resulting shooting order and a requirement source, then export the chosen plan's preparation packet.

Use one principal revision to keep the story understandable. The previously discussed drone/date-conflict scenario is an alternative demonstration if it produces clearer evidence; it is not an additional required demo sequence.

Demo prices must come from researched fees, supplied quotes, or clearly labeled estimates. Select a plausible illustrative budget after validating the sample locations. Show working product behavior, including real Parallel use.

## 7. Acceptance criteria

- Creating and opening a workspace reveals an empty canvas with PDF drop and file-picker controls.
- Upload shows the filename, ingestion transition, actual agent stages, and actionable failures before returning to the same workspace canvas.
- One script node produces editable connected scene groups and two independently configurable plan outputs on the canvas.
- Questions appear on their owning script or scene node. Original answers remain connected, reviewable, and editable after generation, regeneration, and workspace reopen.
- The script's scene index focuses the corresponding canvas node; scene groups connect questions and answers to their generated locations, costs, requirements, and documents.
- Active, waiting, completed, failed, cancelled, and stale tasks have visible states. Waiting on one scene does not halt independent work.
- Missing material inputs produce visible questions before dependent decisions; answering updates the relevant scope without repeat questioning.
- Candidate count is configurable, supported by real results, and never padded with fabricated locations.
- Every displayed permit requirement has a source or an explicit unresolved status.
- No fixed cap removes only the monetary cap; dates, access, and permission constraints persist.
- Shared-location cost calculations avoid duplicate charges while respecting booking units and duration.
- Natural-language rules are visible and editable; contradictory or unsupported requests are clarified.
- Locked choices and confirmed hard constraints survive schedule optimization, or the agent reports infeasibility.
- Applying a branch revision changes only its intended scope; undo restores the prior state.
- Editing an answer or filter previews and refreshes dependent outputs, including affected shared locations and plan totals, while preserving unrelated results and layout.
- Regeneration reuses valid answers, asks about newly introduced gaps, and prevents an older run from overwriting newer results.
- Unknown costs and availability remain visible in comparisons and exports.
- The preparation packet matches the current chosen branch and does not imply unverified submission or approval.
- The demonstration completes the decision-to-export loop within three minutes. Record research latency and obtain a producer/location-manager review where possible; report measured results only.

## 8. Judging focus and deferred work

The official rubric weights technical implementation, design, potential impact, and idea quality equally. Demonstrate live research affecting decisions, a coherent canvas-to-export journey, a concrete production problem resolved, and an evidence-backed explanation of the tradeoff. [Judging rules](https://agentic-cinema.devpost.com/rules)

Defer generated films/storyboards, full crew and equipment budgeting, worldwide permitting, automatic submission or booking, real-time multiplayer editing, and a complete production scheduling system. Allocate remaining effort to research accuracy, clarification quality, readable comparisons, and reliable revisions.

Official permitting references for the pilot: [California state permits](https://film.ca.gov/state-permits/) and [drone-related requirements](https://film.ca.gov/state-permits/filming-with-drones/). Retrieve applicable requirements during use rather than treating this PRD as a permanent source of rules.
