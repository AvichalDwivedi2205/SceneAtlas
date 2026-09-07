import hashlib
import hmac
import json
import time
import asyncio
import httpx
import pytest
from contextlib import aclosing

from fastapi.testclient import TestClient

from bridge import main
from sceneatlas.backend import Backend


def test_callback_secret_ignores_secret_file_line_ending(monkeypatch):
    monkeypatch.setenv("CONVEX_SITE_URL", "https://example.convex.site")
    monkeypatch.setenv("AGENT_CALLBACK_SECRET", "callback-secret\n")
    assert Backend("run-12345", 1).secret == "callback-secret"


def signed(body: bytes, secret: str):
    timestamp = str(int(time.time() * 1000))
    signature = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
    return {"X-SceneAtlas-Time": timestamp, "X-SceneAtlas-Signature": signature, "Content-Type": "application/json"}


def test_dispatch_requires_signature(monkeypatch):
    monkeypatch.setenv("AGENT_BRIDGE_SECRET", "secret")
    with TestClient(main.app) as client:
        assert client.post("/dispatch", json={}).status_code == 401


def test_health_endpoint_is_public():
    with TestClient(main.app) as client:
        assert client.get("/health").json() == {"status": "ok"}


def test_dispatch_is_idempotently_queued(monkeypatch):
    monkeypatch.setenv("AGENT_BRIDGE_SECRET", "secret")
    monkeypatch.setenv("CONVEX_SITE_URL", "https://example.convex.site")
    monkeypatch.setattr(main, "create_task", lambda payload: f"task/{payload.runId}/{payload.attempt}")
    body = json.dumps({"runId": "run-12345", "attempt": 1, "callbackUrl": "https://example.convex.site"}, separators=(",", ":")).encode()
    with TestClient(main.app) as client:
        response = client.post("/dispatch", content=body, headers=signed(body, "secret"))
    assert response.status_code == 202
    assert response.json()["task"] == "task/run-12345/1"


def test_extracts_only_structured_final_result():
    assert main._result({"content": {"parts": [{"text": "ordinary model text"}]}}) is None
    event = {"content": {"parts": [{"text": json.dumps({"sceneatlasResult": {"message": "done"}})}]}}
    assert main._result(event) == {"message": "done"}


@pytest.mark.parametrize("remote_failure", [None, httpx.ReadTimeout("")])
def test_progress_without_search_id_omits_optional_callback_field(monkeypatch, remote_failure):
    sent = []

    class Backend:
        def __init__(self, *args):
            pass

        async def post(self, operation, data=None):
            if operation == "claim":
                return True
            if operation == "context":
                return {"run": {"kind": "chat"}}
            sent.append(data)
            return {"accepted": True}

    class Remote:
        async def async_stream_query(self, **kwargs):
            yield {"actions": {"state_delta": {"activity": "Reading screenplay"}}}
            if remote_failure:
                raise remote_failure
            yield {"content": {"parts": [{"text": json.dumps({"sceneatlasResult": {"message": "done"}})}]}}

    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "test-project")
    monkeypatch.setenv("AGENT_RUNTIME_RESOURCE", "test-runtime")
    monkeypatch.setattr(main, "Backend", Backend)
    loading = False
    ticked_while_loading = []
    def load_engine(*_):
        nonlocal loading
        loading = True
        time.sleep(0.04)
        loading = False
        return Remote()
    monkeypatch.setattr(main, "managed_engine", load_engine)
    async def check_responsiveness():
        while not loading:
            await asyncio.sleep(0.001)
        ticked_while_loading.append(True)
    async def run():
        await asyncio.wait_for(asyncio.gather(
            main.execute(main.Dispatch(runId="run-12345", attempt=1, callbackUrl="https://example.convex.site")),
            check_responsiveness(),
        ), timeout=1)
    asyncio.run(run())
    assert ticked_while_loading == [True]
    progress = next(item for item in sent if item["activity"] == "Reading screenplay")
    assert "providerId" not in progress
    assert sent[-1]["status"] == ("failed" if remote_failure else "complete")
    if remote_failure:
        assert "ReadTimeout" in sent[-1]["detail"]


@pytest.mark.asyncio
async def test_heartbeat_does_not_cancel_slow_provider_and_closes_on_cancellation():
    closed = []
    async def remote():
        try:
            await asyncio.sleep(0.035)
            yield {"result": "event after several ticks"}
            await asyncio.sleep(60)
        finally:
            closed.append(True)
    async with aclosing(main.with_heartbeats(remote(), interval=0.01)) as stream:
        events = []
        async for event in stream:
            events.append(event)
            if event is not None:
                break
    assert events.count(None) >= 2
    assert events[-1] == {"result": "event after several ticks"}
    assert closed == [True]
