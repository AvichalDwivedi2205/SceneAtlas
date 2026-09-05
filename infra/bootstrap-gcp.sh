#!/usr/bin/env bash
set -euo pipefail

: "${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT to a dedicated, billing-enabled Google Cloud project.}"
SCENEATLAS_REGION="${GOOGLE_CLOUD_LOCATION:-us-central1}"
SCENEATLAS_QUEUE="${CLOUD_TASKS_QUEUE:-sceneatlas-runs}"
SCENEATLAS_AGENT_SA="sceneatlas-agent@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com"
SCENEATLAS_BRIDGE_SA="sceneatlas-bridge@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com"
SCENEATLAS_TASK_SA="sceneatlas-tasks@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com"
SCENEATLAS_BUCKET="${GOOGLE_CLOUD_PROJECT}-sceneatlas-agent-staging"

gcloud config set project "$GOOGLE_CLOUD_PROJECT"
gcloud services enable aiplatform.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com cloudtasks.googleapis.com secretmanager.googleapis.com storage.googleapis.com iamcredentials.googleapis.com

for SCENEATLAS_ACCOUNT in sceneatlas-agent sceneatlas-bridge sceneatlas-tasks; do
  gcloud iam service-accounts describe "${SCENEATLAS_ACCOUNT}@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com" >/dev/null 2>&1 || \
    gcloud iam service-accounts create "$SCENEATLAS_ACCOUNT" --display-name="SceneAtlas ${SCENEATLAS_ACCOUNT#sceneatlas-}"
done

gcloud storage buckets describe "gs://${SCENEATLAS_BUCKET}" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://${SCENEATLAS_BUCKET}" --location="$SCENEATLAS_REGION" --uniform-bucket-level-access
gcloud tasks queues describe "$SCENEATLAS_QUEUE" --location="$SCENEATLAS_REGION" >/dev/null 2>&1 || \
  gcloud tasks queues create "$SCENEATLAS_QUEUE" --location="$SCENEATLAS_REGION" --max-concurrent-dispatches=8 --max-dispatches-per-second=4 --max-attempts=1

for SCENEATLAS_SECRET in sceneatlas-parallel-api-key sceneatlas-agent-callback sceneatlas-bridge-dispatch; do
  gcloud secrets describe "$SCENEATLAS_SECRET" >/dev/null 2>&1 || gcloud secrets create "$SCENEATLAS_SECRET" --replication-policy=automatic
done

gcloud projects add-iam-policy-binding "$GOOGLE_CLOUD_PROJECT" --member="serviceAccount:${SCENEATLAS_AGENT_SA}" --role="roles/aiplatform.user" --condition=None >/dev/null
gcloud projects add-iam-policy-binding "$GOOGLE_CLOUD_PROJECT" --member="serviceAccount:${SCENEATLAS_BRIDGE_SA}" --role="roles/aiplatform.user" --condition=None >/dev/null
gcloud projects add-iam-policy-binding "$GOOGLE_CLOUD_PROJECT" --member="serviceAccount:${SCENEATLAS_BRIDGE_SA}" --role="roles/cloudtasks.enqueuer" --condition=None >/dev/null
for SCENEATLAS_SECRET in sceneatlas-parallel-api-key sceneatlas-agent-callback; do
  gcloud secrets add-iam-policy-binding "$SCENEATLAS_SECRET" --member="serviceAccount:${SCENEATLAS_AGENT_SA}" --role="roles/secretmanager.secretAccessor" --condition=None >/dev/null
done
for SCENEATLAS_SECRET in sceneatlas-agent-callback sceneatlas-bridge-dispatch; do
  gcloud secrets add-iam-policy-binding "$SCENEATLAS_SECRET" --member="serviceAccount:${SCENEATLAS_BRIDGE_SA}" --role="roles/secretmanager.secretAccessor" --condition=None >/dev/null
done
gcloud iam service-accounts add-iam-policy-binding "$SCENEATLAS_TASK_SA" --member="serviceAccount:${SCENEATLAS_BRIDGE_SA}" --role="roles/iam.serviceAccountUser" --condition=None >/dev/null

echo "GCP base ready. Add secret versions without putting values in shell history:"
echo "  printf %s \"\$PARALLEL_API_KEY\" | gcloud secrets versions add sceneatlas-parallel-api-key --data-file=-"
echo "  openssl rand -hex 32 | gcloud secrets versions add sceneatlas-agent-callback --data-file=-"
echo "  openssl rand -hex 32 | gcloud secrets versions add sceneatlas-bridge-dispatch --data-file=-"
echo "Staging bucket: gs://${SCENEATLAS_BUCKET}"
