"""Signed Convex dispatch -> Cloud Tasks -> managed Vertex AI Agent Engine."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import re
import time
from contextlib import aclosing, suppress
from functools import lru_cache
from typing import Any

import google.auth.transport.requests
from fastapi import FastAPI, Header, HTTPException, Request, Response, status
from google.cloud import tasks_v2
from google.oauth2 import id_token
from pydantic import BaseModel, ConfigDict, Field
import vertexai

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
    provider_id = state.get("providerRequestId") or state.get("searchId") or state.get("parallelSearchId")
    return (activity if isinstance(activity, str) else None, provider_id if isinstance(provider_id, str) else None)


def _research(event: dict[str, Any]) -> dict[str, Any] | None:
    """Forward bounded coordinator trace fields; never tool arguments or raw responses."""
    state = (event.get("actions") or {}).get("state_delta") or (event.get("actions") or {}).get("stateDelta") or {}
    trace = state.get("research")
    if not isinstance(trace, dict) or trace.get("kind") != "research":
        return None
    if trace.get("operation") not in ("search", "extract") or trace.get("phase") not in ("request", "complete", "failed"):
        return None
    safe: dict[str, Any] = {key: trace[key] for key in ("kind", "operation", "phase")}
    for key, limit in (("objective", 5000), ("requestId", 200), ("error", 600)):
        if isinstance(trace.get(key), str):
            safe[key] = trace[key][:limit]
    for key, count, limit in (("queries", 4, 500), ("urls", 5, 2000)):
        if isinstance(trace.get(key), list):
            safe[key] = [value[:limit] for value in trace[key][:count] if isinstance(value, str)]
    for key in ("retrievedAt", "resultCount"):
        if type(trace.get(key)) is int and trace[key] >= 0:
            safe[key] = trace[key]
    if type(trace.get("cached")) is bool:
        safe["cached"] = trace["cached"]
    return safe


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


async def with_heartbeats(stream, interval=30):
    """Keep a pending remote read alive across heartbeat ticks; cancel on exit."""
    iterator = stream.__aiter__()
    pending = asyncio.create_task(anext(iterator))
    try:
        while True:
            done, _ = await asyncio.wait({pending}, timeout=interval)
            if not done:
                yield None
                continue
            try:
                event = pending.result()
            except StopAsyncIteration:
                break
            yield event
            pending = asyncio.create_task(anext(iterator))
    finally:
        pending.cancel()
        with suppress(asyncio.CancelledError, StopAsyncIteration):
            await pending
        if hasattr(iterator, "aclose"):
            await iterator.aclose()


@lru_cache(maxsize=1)
def managed_engine(project: str, location: str, resource: str):
    # The legacy agent_engines async wrapper iterates a synchronous HTTP stream.
    # The Client wrapper uses async_request_streamed and leaves heartbeats and
    # concurrent Cloud Tasks free to run. Metadata lookup stays off the loop.
    client = vertexai.Client(project=project, location=location, http_options={"timeout": 1_500_000})
    return client.agent_engines.get(name=resource)


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
        context = await backend.post("context")
        run_kind = context["run"]["kind"]
        remote = await asyncio.to_thread(managed_engine, project, location, _required("AGENT_RUNTIME_RESOURCE"))
        stream = remote.async_stream_query(
            user_id=f"run-{payload.runId}"[:128],
            message=json.dumps({"runId": payload.runId, "attempt": payload.attempt}),
        )
        last_activity = "Starting managed agent"
        # Leave time to save a useful failure before the Cloud Tasks 30-minute deadline.
        async with asyncio.timeout(1500), aclosing(with_heartbeats(stream)) as events:
            async for event in events:
                if event is None:
                    sequence += 1
                    accepted = await backend.post("event", {"sequence": sequence, "activity": last_activity})
                    if accepted.get("accepted") is False:
                        return
                    continue
                if not isinstance(event, dict):
                    continue
                if event.get("errorMessage"):
                    raise RuntimeError(str(event["errorMessage"])[:4000])
                activity, provider_id = _activity(event)
                research = _research(event)
                result = _result(event)
                if result is not None:
                    final = result
                if activity:
                    last_activity = activity
                    sequence += 1
                    progress = {"sequence": sequence, "activity": activity}
                    if provider_id:
                        progress["providerId"] = provider_id
                    if research:
                        progress["research"] = research
                    accepted = await backend.post("event", progress)
                    if accepted.get("accepted") is False:
                        return
        if final is None:
            raise RuntimeError("Managed agent completed without a validated SceneAtlas result")
        sequence += 1
        waiting = any(run_kind in question.get("data", {}).get("blocks", []) for question in final.get("questions", []))
        await backend.post("event", {"sequence": sequence, "activity": "Waiting for your answer" if waiting else "Complete", "status": "waiting" if waiting else "complete", "result": final})
    except Exception as exc:
        sequence += 1
        detail = str(exc).strip() or f"Managed agent failed ({type(exc).__name__}). Retry resumes any saved screenplay batches."
        await backend.post("event", {"sequence": sequence, "activity": "Agent task failed", "status": "failed", "detail": ("Worker reached its time limit. Retry resumes saved screenplay batches." if isinstance(exc, TimeoutError) else detail)[:4000]})


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
