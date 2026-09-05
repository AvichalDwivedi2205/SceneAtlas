#!/usr/bin/env bash
set -euo pipefail

: "${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT.}"
: "${AGENT_RUNTIME_RESOURCE:?Set AGENT_RUNTIME_RESOURCE from deploy_agent.py output.}"
: "${CONVEX_SITE_URL:?Set CONVEX_SITE_URL.}"
SCENEATLAS_REGION="${GOOGLE_CLOUD_LOCATION:-us-central1}"
SCENEATLAS_QUEUE="${CLOUD_TASKS_QUEUE:-sceneatlas-runs}"
SCENEATLAS_SERVICE="sceneatlas-agent-bridge"
SCENEATLAS_BRIDGE_SA="sceneatlas-bridge@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com"
SCENEATLAS_TASK_SA="sceneatlas-tasks@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com"
SCENEATLAS_IMAGE="${SCENEATLAS_REGION}-docker.pkg.dev/${GOOGLE_CLOUD_PROJECT}/sceneatlas/agent-bridge"
SCENEATLAS_EXISTING_URL="$(gcloud run services describe "$SCENEATLAS_SERVICE" --region="$SCENEATLAS_REGION" --format='value(status.url)' 2>/dev/null || true)"
SCENEATLAS_WORKER_BASE="${SCENEATLAS_EXISTING_URL:-https://bootstrap.invalid}"

gcloud artifacts repositories describe sceneatlas --location="$SCENEATLAS_REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create sceneatlas --repository-format=docker --location="$SCENEATLAS_REGION"
gcloud builds submit . --config=infra/cloudbuild-bridge.yaml --substitutions="_IMAGE=${SCENEATLAS_IMAGE}" --project="$GOOGLE_CLOUD_PROJECT"
gcloud run deploy "$SCENEATLAS_SERVICE" --image="$SCENEATLAS_IMAGE" --region="$SCENEATLAS_REGION" --service-account="$SCENEATLAS_BRIDGE_SA" --allow-unauthenticated --cpu=1 --memory=1Gi --timeout=1800 --concurrency=8 --max-instances=4 \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT},GOOGLE_CLOUD_LOCATION=${SCENEATLAS_REGION},CLOUD_TASKS_QUEUE=${SCENEATLAS_QUEUE},TASK_SERVICE_ACCOUNT=${SCENEATLAS_TASK_SA},AGENT_RUNTIME_RESOURCE=${AGENT_RUNTIME_RESOURCE},CONVEX_SITE_URL=${CONVEX_SITE_URL},TASK_WORKER_URL=${SCENEATLAS_WORKER_BASE}/work" \
  --set-secrets="AGENT_BRIDGE_SECRET=sceneatlas-bridge-dispatch:latest,AGENT_CALLBACK_SECRET=sceneatlas-agent-callback:latest"
SCENEATLAS_URL="$(gcloud run services describe "$SCENEATLAS_SERVICE" --region="$SCENEATLAS_REGION" --format='value(status.url)')"
if [[ "$SCENEATLAS_WORKER_BASE" != "$SCENEATLAS_URL" ]]; then
  gcloud run services update "$SCENEATLAS_SERVICE" --region="$SCENEATLAS_REGION" --update-env-vars="TASK_WORKER_URL=${SCENEATLAS_URL}/work" >/dev/null
fi
echo "$SCENEATLAS_URL"
