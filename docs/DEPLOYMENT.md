# SceneAtlas deployed development environment

Last verified: September 6, 2026.

| Resource | Value | State |
| --- | --- | --- |
| Web | `https://sceneatlas-black.vercel.app` | Landing and `/preview` live |
| Convex | `oceanic-ladybug-337` | Functions deployed |
| Convex site | `https://oceanic-ladybug-337.convex.site` | Signed agent callbacks live |
| Google Cloud project | `sceneatlas-avd-260906` | Billing and required APIs enabled |
| Region | `us-central1` | Active |
| Agent Engine | `projects/245638196984/locations/us-central1/reasoningEngines/2253688224905953280` | Ready |
| Cloud Run bridge | `https://sceneatlas-agent-bridge-x4lfgrmrha-uc.a.run.app` | Ready |
| Cloud Tasks queue | `sceneatlas-runs` | Ready |
| Parallel key | Secret Manager `sceneatlas-parallel-api-key` | Version installed |
| Clerk | Dedicated SceneAtlas application | Required |

Verified cloud boundaries:

- Cloud Run `/health` returns HTTP 200.
- Unsigned `/dispatch` requests return HTTP 401.
- A correctly signed dispatch returns HTTP 202 and creates a deterministic Cloud Task.
- Cloud Tasks reaches `/work` with Google OIDC.
- Managed Agent Engine imports the deployed `sceneatlas` package and reaches the signed Convex context endpoint. The smoke request used an intentionally nonexistent run and stopped with the expected HTTP 400 at that boundary.
- Vercel production serves a 12-node interactive sample canvas with zero browser warnings or errors.

To finish authenticated release, create a dedicated Clerk application and a JWT template named `convex`. Add `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` to Vercel, set `CLERK_JWT_ISSUER_DOMAIN` and `CLERK_SECRET_KEY` in Convex, redeploy, then run the three-browser owner/editor/viewer acceptance flow.

Convex currently warns that the account is above Free-plan limits. Resolve account usage or choose a paid plan before relying on uninterrupted public access.
