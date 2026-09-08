"""Discover and retrieve production evidence using Parallel."""
import asyncio
import ipaddress
import json
import os
import re
import socket
import threading
import time
from urllib.parse import urlparse
from parallel import AsyncParallel, APIConnectionError, APIStatusError

EXHAUSTED_KEY_COOLDOWN_SECONDS = 300
EXTRACT_OBJECTIVE = "Location access, official filming requirements, current fees with units, official forms and source-linked imagery."


class ParallelCreditsExhausted(RuntimeError):
    """Every configured credential has insufficient available Parallel credits."""


def configured_parallel_keys() -> tuple[str, ...]:
    """Accept the original single key and the user's numbered four-key setup."""
    legacy = os.getenv("PARALLEL_API_KEY", "").strip()
    first = os.getenv("PARALLEL_API_KEY1", "").strip()
    if legacy and first and legacy != first:
        raise RuntimeError("Configure either PARALLEL_API_KEY or PARALLEL_API_KEY1 for the first Parallel key, not both.")
    keys = [legacy or first, *(os.getenv(f"PARALLEL_API_KEY{i}", "").strip() for i in range(2, 5))]
    unique = tuple(dict.fromkeys(key for key in keys if key))
    if not unique:
        raise RuntimeError("Parallel is not configured. Add PARALLEL_API_KEY to the agent deployment, or configure PARALLEL_API_KEY1 through PARALLEL_API_KEY4.")
    return unique


class ParallelKeyPool:
    """Share credit cooldowns across concurrent Search and Extract requests."""

    def __init__(self, keys: tuple[str, ...]):
        self.keys = keys
        self._exhausted_until: dict[int, float] = {}
        self._lock = threading.Lock()

    def next_key(self, attempted: set[int]) -> tuple[int, str] | None:
        with self._lock:
            now = time.monotonic()
            return next(((index, key) for index, key in enumerate(self.keys)
                         if index not in attempted and self._exhausted_until.get(index, 0) <= now), None)

    def exhaust(self, index: int) -> None:
        with self._lock:
            self._exhausted_until[index] = time.monotonic() + EXHAUSTED_KEY_COOLDOWN_SECONDS


_pool: ParallelKeyPool | None = None
_pool_lock = threading.Lock()


def parallel_key_pool() -> ParallelKeyPool:
    global _pool
    keys = configured_parallel_keys()
    with _pool_lock:
        if _pool is None or _pool.keys != keys:
            _pool = ParallelKeyPool(keys)
        return _pool


async def parallel_call(operation: str, **kwargs):
    """Advance in configured order only on Parallel's documented HTTP 402."""
    pool = parallel_key_pool()
    attempted: set[int] = set()
    while selected := pool.next_key(attempted):
        index, key = selected
        attempted.add(index)
        try:
            async with AsyncParallel(api_key=key, max_retries=2, timeout=45) as client:
                return await getattr(client, operation)(**kwargs)
        except APIStatusError as error:
            # https://docs.parallel.ai/resources/warnings-and-errors#402-payment-required-troubleshooting
            # 429 can mean rate/quota limits; it is not evidence of exhausted credit.
            if error.status_code != 402:
                message = ("Check the agent's Parallel credentials and account permissions." if error.status_code in {401, 403}
                           else "Retry later or check Parallel account capacity." if error.status_code == 429 or error.status_code >= 500
                           else "Check the research request and agent configuration.")
                # Preserve the SDK error type/status, without forwarding an arbitrary provider body.
                raise type(error)(f"Parallel request failed (HTTP {error.status_code}). {message}", response=error.response, body=None) from None
            pool.exhaust(index)
    subject = "The configured Parallel API key has" if len(pool.keys) == 1 else f"All {len(pool.keys)} configured Parallel API keys have"
    raise ParallelCreditsExhausted(
        f"{subject} insufficient available credits. "
        "Add credits or update the agent's Parallel secrets, then retry after up to five minutes "
        "or restart the agent to recheck immediately."
    ) from None


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
    response = await parallel_call("search", objective=objective[:5000], search_queries=[query[:500] for query in queries[:4]], max_chars_total=32000)
    data = response.model_dump(mode="json")
    return {"provider": "parallel", "searchId": data.get("search_id", ""), "retrievedAt": int(time.time()*1000),
            "results": [{"url": r["url"], "title": r.get("title", r["url"]),
                         "excerpt": "\n".join(r.get("excerpts", []))[:6000]}
                        for r in data.get("results", [])[:8]]}

def research_request(target: dict, answers: list[dict], kind: str = "research") -> tuple[str, list[str]]:
    """Build a focused search without copying existing source excerpts into the request."""
    facts = {key: target[key] for key in ["name", "address", "setting", "needs", "interiorExterior", "timeOfDay", "windows"] if key in target}
    confirmed = [{"key": answer.get("key"), "answer": (answer.get("answer") or "")[:600]} for answer in answers[:12]]
    area = next((answer.get("answer") or "" for answer in answers if answer.get("key") == "search_area"), "")
    purpose = ("Find current official filming requirements for this exact selected location. Do not discover replacement locations."
               if kind == "requirements" else
               "Find real filming locations inside the producer's confirmed search area. Exclude locations outside that boundary, even when their physical features match.")
    objective = (purpose + " Confirmed search area: " + area[:1200] +
                 ". Do not assume availability or approval. Location/scene: " + json.dumps(facts) +
                 ". Producer-confirmed inputs: " + json.dumps(confirmed))[:5000]
    # Keep the geographic constraint in every discovery query. Generic statewide
    # permit queries otherwise crowd out evidence about suitable local candidates.
    area_query = area[:260]
    if kind == "requirements":
        place = target.get("name", "")[:140]
        queries = [f"{place} {area_query} filming permit requirements",
                   f"site:parks.ca.gov {place} {area_query} filming fees",
                   f"site:film.ca.gov {place} state parks filming requirements"]
    else:
        place = target.get("setting", target.get("name", ""))[:140]
        queries = [f"{area_query} {place} filming location",
                   f"site:parks.ca.gov {area_query} {place}",
                   f"{area_query} {place} filming access restrictions"]
    return objective, [query[:500] for query in queries]

def provider_failure(error: Exception) -> str | None:
    """Identify capacity and transient errors while preserving auth/config failures."""
    if isinstance(error, ParallelCreditsExhausted):
        return "All configured Parallel keys have insufficient available credits"
    if isinstance(error, APIConnectionError):
        return "Parallel connection or timeout failure"
    if isinstance(error, APIStatusError):
        if error.status_code == 402:
            return "Parallel has insufficient available credits"
        if error.status_code == 429:
            return "Parallel quota or rate limit reached"
        if error.status_code >= 500:
            return "Parallel service temporarily unavailable"
    return None

async def search_sources(objective: str, queries: list[str]) -> dict:
    """Use Parallel discovery and surface actionable capacity failures."""
    try:
        return await parallel_search(objective, queries)
    except (APIConnectionError, APIStatusError) as error:
        reason = provider_failure(error)
        if not reason:
            raise
        raise RuntimeError(f"{reason}. Retry later or check Parallel account capacity.") from error

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
    response = await parallel_call("extract", urls=safe, objective=EXTRACT_OBJECTIVE, max_chars_total=32000)
    data = response.model_dump(mode="json")
    # Evidence is bounded before inclusion in model context. Preserve source URL and title.
    bounded = [bound_context(item) for item in data.get("results", [])[:5]]
    return {"provider": "parallel", "extractId": data.get("extract_id", ""), "retrievedAt": int(time.time() * 1000), "requestedUrls": safe,
            "results": bounded, "errors": data.get("errors", [])[:10]}

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
                    applicable_urls = [url for url in sorted(observed_urls) if len(url) <= 1000
                                       and official_source_applies(discovered.get(url, saved.get(url, {})), location)][:8]
                    raise ValueError(
                        f"Requirement {req.get('title', '')[:160]!r} cites unsupported source {source['url'][:1000]!r}. "
                        "A supported requirement must cite retrieved official California evidence using the exact observed URL. "
                        f"Applicable observed URLs: {json.dumps(applicable_urls)}. "
                        "If none supports this requirement, keep it unresolved with sources=[], no formUrl and attachments=[], "
                        "and state that the authority must confirm it; or omit the unsupported requirement. "
                        "Third-party location references cannot establish an official filming requirement.")
                observed_source(source)
                if not official_source_applies(source, location):
                    inapplicable.append(source)
            if inapplicable:
                req["sources"] = [source for source in req.get("sources", []) if source not in inapplicable]
                if not req["sources"]:
                    req.update(status="unresolved", detail="The retrieved official reference is not verified for this park. Confirm the applicable requirement with this location's authority.", attachments=[])
                    req.pop("formUrl", None)
            if req.get("status") == "sourced" and not req.get("sources"):
                raise ValueError("Requirement has no official source.")
            req["externalStatus"] = "unverified"
        location["availability"] = "unverified"
        # Model-supplied image addresses require separately verified media provenance.
        location.pop("imageUrl", None)
        location.pop("imageSourceUrl", None)
    return result
