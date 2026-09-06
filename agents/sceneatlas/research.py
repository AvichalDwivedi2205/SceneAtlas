"""Parallel is the mandatory primary discovery provider."""
import asyncio
import ipaddress
import json
import os
import re
import socket
import time
import httpx
from urllib.parse import urlparse
from parallel import AsyncParallel, APIConnectionError, APIStatusError

def bound_context(value, *, depth: int = 0):
    """Bound every nested extraction value before it reaches the model context."""
    if depth > 8:
        return "[nested content omitted]"
    if isinstance(value, str):
        return value[:12_000]
    if isinstance(value, list):
        return [bound_context(item, depth=depth + 1) for item in value[:100]]
    if isinstance(value, dict):
        return {
            str(key)[:200]: bound_context(item, depth=depth + 1)
            for key, item in list(value.items())[:100]
        }
    return value

def public_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Only public HTTP sources can be retrieved.")
    if parsed.port not in {None, 80, 443}:
        raise ValueError("Unexpected source port.")
    for address in socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM):
        if not ipaddress.ip_address(address[4][0]).is_global:
            raise ValueError("Private network sources cannot be retrieved.")
    return url

async def parallel_search(objective: str, queries: list[str]) -> dict:
    """Discover real locations and requirements with Parallel Search; preserve search IDs and excerpts."""
    key = os.environ.get("PARALLEL_API_KEY")
    if not key:
        raise RuntimeError("Parallel Search is not configured. Add PARALLEL_API_KEY to the agent deployment.")
    async with AsyncParallel(api_key=key, max_retries=2, timeout=45) as client:
        response = await client.search(objective=objective[:5000], search_queries=[query[:500] for query in queries[:4]], max_chars_total=32000)
    data = response.model_dump(mode="json")
    return {"provider": "parallel", "searchId": data.get("search_id", ""), "retrievedAt": int(time.time()*1000),
            "results": [{"url": r["url"], "title": r.get("title", r["url"]),
                         "excerpt": "\n".join(r.get("excerpts", []))[:6000]}
                        for r in data.get("results", [])[:8]]}

def research_request(target: dict, answers: list[dict]) -> tuple[str, list[str]]:
    """Build a focused search without copying existing source excerpts into the request."""
    facts = {key: target[key] for key in ["name", "address", "setting", "needs", "interiorExterior", "timeOfDay", "windows"] if key in target}
    confirmed = [{"key": answer.get("key"), "answer": (answer.get("answer") or "")[:600]} for answer in answers[:12]]
    objective = ("Research real filming locations and current official California state-property filming requirements. "
                 "Do not assume availability or approval. Location/scene: " + json.dumps(facts) +
                 ". Producer-confirmed inputs: " + json.dumps(confirmed))[:5000]
    place = target.get("setting", target.get("name", ""))
    area = next((answer.get("answer") or "" for answer in answers if answer.get("key") == "search_area"), "")
    return objective, [f"{place} {area} filming location"[:500],
                       "site:film.ca.gov state permits requirements fees filming",
                       "site:parks.ca.gov filming permit location fees"]

def provider_failure(error: Exception) -> str | None:
    """Fail over only for exhausted capacity or transient availability failures."""
    if isinstance(error, APIConnectionError):
        return "Parallel connection or timeout failure"
    if isinstance(error, APIStatusError):
        if error.status_code in {402, 429}:
            return "Parallel quota or rate limit reached"
        if error.status_code >= 500:
            return "Parallel service temporarily unavailable"
    return None

async def exa_search(objective: str, queries: list[str], reason: str) -> dict:
    """Use the producer-enabled backup and preserve Exa's actual request ID."""
    key = os.getenv("EXA_API_KEY", "").strip()
    if not key:
        raise RuntimeError("Exa fallback is enabled but EXA_API_KEY is not configured.")
    async with httpx.AsyncClient(timeout=45) as client:
        response = await client.post("https://api.exa.ai/search", headers={"x-api-key": key}, json={
            "query": objective[:8000], "additionalQueries": queries[:4], "type": "auto", "numResults": 8,
            "contents": {"text": True},
        })
        if response.status_code != 200:
            raise RuntimeError(f"{reason}. Exa fallback also failed (HTTP {response.status_code}); retry later or check provider capacity.")
        data = response.json()
    if not data.get("requestId"):
        raise RuntimeError("Exa response did not include a request ID; research was not published.")
    return {"provider": "exa", "searchId": f"exa_{data['requestId']}", "retrievedAt": int(time.time()*1000), "fallbackReason": reason,
            "results": [{"url": r["url"], "title": r.get("title") or r["url"],
                         "excerpt": (r.get("text") or "\n".join(r.get("highlights") or []))[:6000]}
                        for r in data.get("results", [])[:8]]}

async def search_sources(objective: str, queries: list[str]) -> dict:
    """Start every discovery with Parallel; use Exa only when explicitly enabled."""
    try:
        return await parallel_search(objective, queries)
    except (APIConnectionError, APIStatusError) as error:
        reason = provider_failure(error)
        if not reason:
            raise
        if os.getenv("EXA_FALLBACK_ENABLED", "false").lower() != "true":
            raise RuntimeError(f"{reason}. Exa fallback is disabled; retry later or check provider capacity.") from error
        return await exa_search(objective, queries, reason)

async def parallel_extract(urls: list[str]) -> dict:
    """Read selected public evidence pages with Parallel Extract."""
    safe = []
    for url in urls[:5]:
        try:
            safe.append(await asyncio.to_thread(public_url, url))
        except (ValueError, OSError):
            continue
    if not safe:
        return {"results": [], "errors": ["No usable public source URLs."]}
    async with AsyncParallel(api_key=os.environ["PARALLEL_API_KEY"], max_retries=2, timeout=45) as client:
        response = await client.extract(urls=safe, objective="Location access, official filming requirements, current fees with units, official forms and source-linked imagery.", max_chars_total=32000)
    data = response.model_dump(mode="json")
    # Evidence is bounded before inclusion in model context. Preserve source URL and title.
    bounded = [bound_context(item) for item in data.get("results", [])[:5]]
    return {"results": bounded, "errors": data.get("errors", [])[:10]}

def official_source_applies(source: dict, location: dict) -> bool:
    """Pilot scope: CFC state-permit guidance or the named park's own official page."""
    url = urlparse(source["url"])
    host = url.hostname or ""
    if host == "film.ca.gov" and (url.path.rstrip("/") == "/state-permits" or url.path.startswith("/state-permits/")):
        return True
    name = re.sub(r"[^a-z0-9]", "", location.get("name", "").lower())
    title = re.sub(r"[^a-z0-9]", "", source.get("title", "").lower())
    return bool(name and name in title and (host == "parks.ca.gov" or host.endswith(".parks.ca.gov")))

def normalize_sources(result: dict, evidence: dict, previous_location: dict | None = None) -> dict:
    """Reject fabricated source URLs and replace metadata with observed retrieval data."""
    discovered = {item["url"]: item for item in evidence.get("results", [])}
    previous = previous_location or {}
    saved_sources = [*previous.get("sources", []),
                     *(cost["source"] for cost in previous.get("costs", []) if cost.get("source")),
                     *(source for req in previous.get("requirements", []) for source in req.get("sources", []))]
    saved = {source["url"]: source for source in saved_sources}
    observed_urls = discovered.keys() | saved.keys()
    def observed_source(source: dict):
        if source["url"] not in discovered:
            original = dict(saved[source["url"]])
            source.clear()
            source.update(original, cached=True)
            return
        observed = discovered[source["url"]]
        source.update(title=observed["title"], excerpt=observed["excerpt"][:4000], retrievedAt=evidence["retrievedAt"],
                      searchId=evidence["searchId"], provider=evidence.get("provider", "parallel"), cached=False)
        source.pop("fallbackReason", None)
        if evidence.get("fallbackReason"):
            source["fallbackReason"] = evidence["fallbackReason"]
    for location in result.get("locations", []):
        for source in location.get("sources", []):
            if source["url"] not in observed_urls:
                raise ValueError("Candidate cites a source that was not returned by the research provider.")
            observed_source(source)
        for cost in location.get("costs", []):
            source = cost.get("source")
            if source and source["url"] not in observed_urls:
                raise ValueError("Cost cites unobserved evidence.")
            if source:
                observed_source(source)
                host = urlparse(source["url"]).hostname or ""
                if (host == "parks.ca.gov" or host.endswith(".parks.ca.gov")) and not official_source_applies(source, location):
                    cost.update(basis="unknown", amountMinor=None, assumptions="This official reference is not verified for the selected park. Obtain an applicable rate or quote.")
            if cost.get("basis") in {"published", "quote"} and not source:
                cost.update(basis="unknown", amountMinor=None, assumptions="No item-level fee source was returned. Verify the published rate or obtain a quote.")
            if cost.get("basis") in {"published", "quote"} and re.search(r"\b(mid[- ]?range|midpoint|assum(?:e[sd]?|ing)|estimated)\b", cost.get("assumptions") or "", re.I):
                cost["basis"] = "estimate"
            if cost.get("basis") == "unknown":
                cost["amountMinor"] = None
        for req in location.get("requirements", []):
            inapplicable = []
            for source in req.get("sources", []):
                host = urlparse(source["url"]).hostname or ""
                if source["url"] not in observed_urls or not (host == "film.ca.gov" or host == "parks.ca.gov" or host.endswith(".parks.ca.gov")):
                    raise ValueError("A supported requirement must cite retrieved official California evidence.")
                observed_source(source)
                if not official_source_applies(source, location):
                    inapplicable.append(source)
            if inapplicable:
                req["sources"] = [source for source in req.get("sources", []) if source not in inapplicable]
                if not req["sources"]:
                    req.update(status="unknown", detail="The retrieved official reference is not verified for this park. Confirm the applicable requirement with this location's authority.", attachments=[])
                    req.pop("formUrl", None)
            if req.get("status") == "sourced" and not req.get("sources"):
                raise ValueError("Requirement has no official source.")
            req["externalStatus"] = "unverified"
        location["availability"] = "unverified"
        # Model-supplied image addresses require separately verified media provenance.
        location.pop("imageUrl", None)
        location.pop("imageSourceUrl", None)
    return result
