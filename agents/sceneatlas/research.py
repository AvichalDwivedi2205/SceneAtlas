"""Parallel is the mandatory primary discovery provider."""
import asyncio
import ipaddress
import os
import socket
import time
from urllib.parse import urlparse
from parallel import AsyncParallel

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
    client = AsyncParallel(api_key=key, max_retries=2, timeout=45)
    response = await client.search(objective=objective, search_queries=queries[:4], max_results=8)
    data = response.model_dump(mode="json")
    return {"searchId": data.get("search_id", ""), "retrievedAt": int(time.time()*1000),
            "results": [{"url": r["url"], "title": r.get("title", r["url"]),
                         "excerpt": "\n".join(r.get("excerpts", []))[:6000]}
                        for r in data.get("results", [])]}

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
    client = AsyncParallel(api_key=os.environ["PARALLEL_API_KEY"], max_retries=2, timeout=45)
    response = await client.extract(urls=safe, objective="Location access, official filming requirements, current fees with units, official forms and source-linked imagery.")
    data = response.model_dump(mode="json")
    # Evidence is bounded before inclusion in model context. Preserve source URL and title.
    bounded = [bound_context(item) for item in data.get("results", [])[:5]]
    return {"results": bounded, "errors": data.get("errors", [])[:10]}

def normalize_sources(result: dict, evidence: dict) -> dict:
    """Reject fabricated source URLs and replace metadata with observed retrieval data."""
    discovered = {item["url"]: item for item in evidence.get("results", [])}
    for location in result.get("locations", []):
        for source in location.get("sources", []):
            if source["url"] not in discovered:
                raise ValueError("Candidate cites a source that was not returned by Parallel.")
            observed = discovered[source["url"]]
            source.update(title=observed["title"], retrievedAt=evidence["retrievedAt"],
                          searchId=evidence["searchId"], provider="parallel", cached=False)
            source["excerpt"] = observed["excerpt"][:4000]
        for cost in location.get("costs", []):
            source = cost.get("source")
            if source and source["url"] not in discovered:
                raise ValueError("Cost cites unobserved evidence.")
            if source:
                observed = discovered[source["url"]]
                source.update(title=observed["title"], excerpt=observed["excerpt"][:4000], retrievedAt=evidence["retrievedAt"], searchId=evidence["searchId"], provider="parallel", cached=False)
            if cost.get("basis") == "unknown":
                cost["amountMinor"] = None
        for req in location.get("requirements", []):
            for source in req.get("sources", []):
                host = urlparse(source["url"]).hostname or ""
                if source["url"] not in discovered or not (host == "film.ca.gov" or host == "parks.ca.gov" or host.endswith(".parks.ca.gov")):
                    raise ValueError("A supported requirement must cite retrieved official California evidence.")
                observed = discovered[source["url"]]
                source.update(title=observed["title"], excerpt=observed["excerpt"][:4000], retrievedAt=evidence["retrievedAt"], searchId=evidence["searchId"], provider="parallel", cached=False)
            if req.get("status") == "sourced" and not req.get("sources"):
                raise ValueError("Requirement has no official source.")
            req["externalStatus"] = "unverified"
        location["availability"] = "unverified"
        # Model-supplied image addresses require separately verified media provenance.
        location.pop("imageUrl", None)
        location.pop("imageSourceUrl", None)
    return result
