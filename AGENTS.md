<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Demo video production stays local

Keep demo recording and editing scripts, plans, footage, renders, narration, rehearsal evidence, and delivery archives local. Never stage, commit, or push these materials, and never force-add them past `.gitignore`. Store new demo production files under `artifacts/demo-video/`; legacy recording scripts and demo plans are also ignored.

Before committing or pushing, check staged changes and outgoing commits for added or modified demo production files. Remove tracked demo files with `git rm --cached` so local copies remain available. Deletions that remove demo files from the repository are allowed. Keep recording plans and evidence out of tracked documentation and pull request descriptions.
