import hashlib
import hmac
import json
import time

from fastapi.testclient import TestClient

from bridge import main


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
