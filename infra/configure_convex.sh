#!/usr/bin/env bash
set -euo pipefail

: "${CLERK_JWT_ISSUER_DOMAIN:?Set CLERK_JWT_ISSUER_DOMAIN.}"
: "${CLERK_SECRET_KEY:?Set CLERK_SECRET_KEY.}"
: "${AGENT_BRIDGE_URL:?Set AGENT_BRIDGE_URL.}"
: "${AGENT_BRIDGE_SECRET:?Set AGENT_BRIDGE_SECRET to same value stored in sceneatlas-bridge-dispatch.}"
: "${AGENT_CALLBACK_SECRET:?Set AGENT_CALLBACK_SECRET to same value stored in sceneatlas-agent-callback.}"

bunx convex env set CLERK_JWT_ISSUER_DOMAIN "$CLERK_JWT_ISSUER_DOMAIN"
bunx convex env set CLERK_SECRET_KEY "$CLERK_SECRET_KEY"
bunx convex env set AGENT_BRIDGE_URL "$AGENT_BRIDGE_URL"
bunx convex env set AGENT_BRIDGE_SECRET "$AGENT_BRIDGE_SECRET"
bunx convex env set AGENT_CALLBACK_SECRET "$AGENT_CALLBACK_SECRET"
