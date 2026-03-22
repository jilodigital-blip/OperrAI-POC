#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Raymidi Voice Relay — Google Cloud Run Deployment
# ──────────────────────────────────────────────────────────────────────────────
# Usage:
#   ./deploy.sh                  # Deploy with defaults
#   PROJECT_ID=my-proj ./deploy.sh  # Override project ID
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Configuration (override via env vars) ────────────────────────────────────
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-asia-south1}"
SERVICE_NAME="${SERVICE_NAME:-raymidi-voice-relay}"
REPO_NAME="${REPO_NAME:-raydimi-images}"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO_NAME/$SERVICE_NAME:latest"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Raymidi Voice Relay — Cloud Run Deployment                 ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Project:  $PROJECT_ID"
echo "║  Region:   $REGION"
echo "║  Service:  $SERVICE_NAME"
echo "║  Image:    $IMAGE"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── Step 1: Enable required APIs ─────────────────────────────────────────────
echo "▸ Step 1: Enabling required GCP APIs..."
gcloud services enable \
  run.googleapis.com \
  speech.googleapis.com \
  texttospeech.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  --project="$PROJECT_ID"
echo "  ✓ APIs enabled"

# ── Step 2: Create Artifact Registry (if not exists) ─────────────────────────
echo "▸ Step 2: Creating Artifact Registry repository..."
gcloud artifacts repositories describe "$REPO_NAME" \
  --location="$REGION" --project="$PROJECT_ID" 2>/dev/null \
  || gcloud artifacts repositories create "$REPO_NAME" \
    --repository-format=docker \
    --location="$REGION" \
    --project="$PROJECT_ID"
echo "  ✓ Artifact Registry ready"

# ── Step 3: Build & push Docker image via Cloud Build ────────────────────────
echo "▸ Step 3: Building and pushing Docker image..."
gcloud builds submit \
  --tag "$IMAGE" \
  --project="$PROJECT_ID" \
  .
echo "  ✓ Image pushed: $IMAGE"

# ── Step 4: Deploy to Cloud Run ──────────────────────────────────────────────
echo "▸ Step 4: Deploying to Cloud Run..."
echo ""
echo "  ⚠  You must set these env vars in Cloud Run (via console or CLI):"
echo "     JWT_SECRET, OPENAI_API_KEY, SARVAM_API_KEY,"
echo "     SUPABASE_URL, SUPABASE_ANON_KEY, CORS_ORIGIN"
echo ""

gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --platform managed \
  --port 8080 \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 1 \
  --max-instances 5 \
  --timeout 300 \
  --session-affinity \
  --set-env-vars "CORS_ORIGIN=https://www.raymidi.com"

echo "  ✓ Deployed to Cloud Run"

# ── Step 5: Grant STT permissions to service account ─────────────────────────
echo "▸ Step 5: Granting Speech-to-Text permissions..."
SA_EMAIL=$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" --project="$PROJECT_ID" \
  --format='value(spec.template.spec.serviceAccountName)' 2>/dev/null || echo "")

if [ -z "$SA_EMAIL" ]; then
  # Default compute service account
  PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
  SA_EMAIL="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
fi

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/speech.client" \
  --condition=None \
  --quiet
echo "  ✓ Speech-to-Text permissions granted to $SA_EMAIL"

# ── Step 6: Print service URL ────────────────────────────────────────────────
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" --project="$PROJECT_ID" \
  --format='value(status.url)')

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  ✓ Deployment complete!                                     ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Service URL: $SERVICE_URL"
echo "║  Health:      $SERVICE_URL/health"
echo "║  WebSocket:   wss://$(echo $SERVICE_URL | sed 's|https://||')/voice"
echo "║                                                              ║"
echo "║  Next: Set VOICE_RELAY_HOST in Vercel to:                   ║"
echo "║  $(echo $SERVICE_URL | sed 's|https://||')"
echo "╚══════════════════════════════════════════════════════════════╝"
