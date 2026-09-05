"""Signed Convex dispatch -> Cloud Tasks -> managed Vertex AI Agent Engine."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import re
import time
from typing import Any

import google.auth.transport.requests
from fastapi import FastAPI, Header, HTTPException, Request, Response, status
from google.cloud import tasks_v2
from google.oauth2 import id_token
from pydantic import BaseModel, ConfigDict, Field
import vertexai
from vertexai import agent_engines

from sceneatlas.backend import Backend

app = FastAPI(title="SceneAtlas Agent Bridge", docs_url=None, redoc_url=None)


class Dispatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    runId: str = Field(min_length=5, max_length=200)
    attempt: int = Field(ge=1, le=20)
    callbackUrl: str


def _required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is not configured")
    return value


def verify_dispatch(raw: bytes, timestamp: str | None, signature: str | None) -> None:
    if not timestamp or not timestamp.isdigit() or abs(time.time() * 1000 - int(timestamp)) > 300_000:
        raise HTTPException(status_code=401, detail="Expired dispatch")
    if not signature or not re.fullmatch(r"[0-9a-f]{64}", signature):
        raise HTTPException(status_code=401, detail="Invalid dispatch signature")
    expected = hmac.new(_required("AGENT_BRIDGE_SECRET").encode(), timestamp.encode() + b"." + raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=401, detail="Invalid dispatch signature")


def verify_worker(authorization: str | None) -> None:
    if os.getenv("ALLOW_LOCAL_WORKER") == "true":
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Worker identity required")
    audience = _required("TASK_WORKER_URL")
    try:
        claims = id_token.verify_oauth2_token(authorization[7:], google.auth.transport.requests.Request(), audience=audience)
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid worker identity") from exc
    expected_email = _required("TASK_SERVICE_ACCOUNT")
    if claims.get("email") != expected_email or not claims.get("email_verified"):
        raise HTTPException(status_code=403, detail="Worker identity is not allowed")


def create_task(payload: Dispatch) -> str:
    project = _required("GOOGLE_CLOUD_PROJECT")
    location = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")
    queue = os.getenv("CLOUD_TASKS_QUEUE", "sceneatlas-runs")
    worker = _required("TASK_WORKER_URL")
    service_account = _required("TASK_SERVICE_ACCOUNT")
    client = tasks_v2.CloudTasksClient()
    parent = client.queue_path(project, location, queue)
    suffix = hashlib.sha256(f"{payload.runId}:{payload.attempt}".encode()).hexdigest()[:32]
    task = {
        "name": f"{parent}/tasks/run-{suffix}",
        "http_request": {
            "http_method": tasks_v2.HttpMethod.POST,
            "url": worker,
            "headers": {"Content-Type": "application/json"},
            "body": payload.model_dump_json().encode(),
            "oidc_token": {"service_account_email": service_account, "audience": worker},
        },
        "dispatch_deadline": {"seconds": 1800},
    }
    try:
        return client.create_task(parent=parent, task=task).name
    except Exception as exc:
        if exc.__class__.__name__ == "AlreadyExists":
            return task["name"]
        raise


def _activity(event: dict[str, Any]) -> tuple[str | None, str | None]:
    state = (event.get("actions") or {}).get("state_delta") or (event.get("actions") or {}).get("stateDelta") or {}
    activity = state.get("activity")
    provider_id = state.get("parallelSearchId")
    return (activity if isinstance(activity, str) else None, provider_id if isinstance(provider_id, str) else None)


def _result(event: dict[str, Any]) -> dict[str, Any] | None:
    for part in ((event.get("content") or {}).get("parts") or []):
        text = part.get("text") if isinstance(part, dict) else None
        if not text or "sceneatlasResult" not in text:
            continue
        try:
            parsed = json.loads(text)
            value = parsed.get("sceneatlasResult")
            if isinstance(value, dict):
                return value
        except json.JSONDecodeError:
            continue
    return None


async def execute(payload: Dispatch) -> None:
    backend = Backend(payload.runId, payload.attempt)
    claimed = await backend.post("claim")
    if claimed is not True:
        return
    sequence = 1
    await backend.post("event", {"sequence": sequence, "activity": "Starting managed agent"})
    final: dict[str, Any] | None = None
    try:
        project = _required("GOOGLE_CLOUD_PROJECT")
        location = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")
        vertexai.init(project=project, location=location)
        context = await backend.post("context")
        run_kind = context["run"]["kind"]
        remote = agent_engines.get(_required("AGENT_RUNTIME_RESOURCE"))
        async for event in remote.async_stream_query(
            user_id=f"run-{payload.runId}"[:128],
            message=json.dumps({"runId": payload.runId, "attempt": payload.attempt}),
        ):
            if not isinstance(event, dict):
                continue
            activity, provider_id = _activity(event)
            result = _result(event)
            if result is not None:
                final = result
            if activity:
                sequence += 1
                accepted = await backend.post("event", {"sequence": sequence, "activity": activity, "providerId": provider_id})
                if accepted.get("accepted") is False:
                    return
        if final is None:
            raise RuntimeError("Managed agent completed without a validated SceneAtlas result")
        sequence += 1
        waiting = any(run_kind in question.get("data", {}).get("blocks", []) for question in final.get("questions", []))
        await backend.post("event", {"sequence": sequence, "activity": "Waiting for your answer" if waiting else "Complete", "status": "waiting" if waiting else "complete", "result": final})
    except Exception as exc:
        sequence += 1
        await backend.post("event", {"sequence": sequence, "activity": "Agent task failed", "status": "failed", "detail": str(exc)[:4000]})


@app.get("/health")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/dispatch", status_code=status.HTTP_202_ACCEPTED)
async def dispatch(request: Request, x_sceneatlas_time: str | None = Header(default=None), x_sceneatlas_signature: str | None = Header(default=None)) -> dict[str, str]:
    raw = await request.body()
    if len(raw) > 16_384:
        raise HTTPException(status_code=413, detail="Dispatch too large")
    verify_dispatch(raw, x_sceneatlas_time, x_sceneatlas_signature)
    try:
        payload = Dispatch.model_validate_json(raw)
    except Exception as exc:
        raise HTTPException(status_code=422, detail="Invalid dispatch") from exc
    if payload.callbackUrl.rstrip("/") != _required("CONVEX_SITE_URL").rstrip("/"):
        raise HTTPException(status_code=400, detail="Callback target is not allowed")
    name = await asyncio.to_thread(create_task, payload)
    return {"task": name}


@app.post("/work", status_code=status.HTTP_204_NO_CONTENT)
async def work(payload: Dispatch, authorization: str | None = Header(default=None)) -> Response:
    verify_worker(authorization)
    if payload.callbackUrl.rstrip("/") != _required("CONVEX_SITE_URL").rstrip("/"):
        raise HTTPException(status_code=400, detail="Callback target is not allowed")
    await execute(payload)
    return Response(status_code=204)
