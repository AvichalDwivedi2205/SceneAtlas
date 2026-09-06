"""Run-scoped, authenticated transport back to the application."""
import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any
import httpx

def sign(body: bytes, secret: str, timestamp: str) -> str:
    return hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()

class Backend:
    def __init__(self, run_id: str, attempt: int):
        self.run_id, self.attempt = run_id, attempt
        self.url = os.environ["CONVEX_SITE_URL"].strip().rstrip("/")
        self.secret = os.environ["AGENT_CALLBACK_SECRET"].strip()
        if not self.secret:
            raise ValueError("Agent callback authentication is not configured.")

    async def post(self, operation: str, data: dict[str, Any] | None = None, binary: bool = False):
        payload = {"runId": self.run_id, "attempt": self.attempt, **(data or {})}
        body = json.dumps(payload, separators=(",", ":")).encode()
        timestamp = str(int(time.time() * 1000))
        headers = {"Content-Type": "application/json", "X-SceneAtlas-Time": timestamp,
                   "X-SceneAtlas-Signature": sign(body, self.secret, timestamp)}
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(f"{self.url}/agent/{operation}", content=body, headers=headers)
            response.raise_for_status()
            return response.content if binary else response.json()

    async def artifact(self, content: bytes, filename: str, mime: str) -> str:
        data = await self.post("artifact", {"filename": filename, "mime": mime,
                    "data": base64.b64encode(content).decode()})
        return data["assetId"]
