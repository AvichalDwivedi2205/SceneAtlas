"""Discover and retrieve production evidence using Parallel."""
import asyncio
import ipaddress
import json
import os
import re
import socket
import threading
import time
from decimal import Decimal
from urllib.parse import urlparse
from parallel import AsyncParallel, APIConnectionError, APIStatusError

EXHAUSTED_KEY_COOLDOWN_SECONDS = 300
EXTRACT_OBJECTIVE = "Location access, official filming requirements, current fees with units, official forms and source-linked imagery."
FEE_ESTIMATES_ALLOW = "Allow clearly labeled cost estimates"
FEE_ESTIMATES_UNKNOWN = "Keep unquoted fees unknown"


def fee_estimates_allowed(answers: list[dict]) -> bool:
    """Time estimates and a budget cap do not authorize estimated fee amounts."""
    return any(answer.get("key") == "fee_estimate_policy" and answer.get("resolution") == "answered"
               and (answer.get("answer") or "").strip().rstrip(".").casefold() == FEE_ESTIMATES_ALLOW.casefold()
               for answer in answers)


def mentions_shoot_classification(text: str) -> bool:
    return bool(re.search(r"\b(?:simple|complex)[\s'\"-]+(?:shoots?|films?|filming|productions?)\b", text, re.I))


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

def fee_amount_match(text: str, amount_minor: int, currency: str = "USD"):
    """Require an explicit monetary amount, not a coincidental phone/date number."""
    if type(amount_minor) is not int or amount_minor < 0:
        return None
    major, minor = divmod(amount_minor, 100)
    whole = "(?:" + "|".join(re.escape(value) for value in dict.fromkeys([str(major), f"{major:,}"])) + ")"
    fraction = r"(?:\.00?)?" if minor == 0 else r"\." + (f"{minor:02d}" if minor % 10 else f"{minor // 10}0?")
    number = whole + fraction
    code = re.escape(currency)
    prefix = {"USD": r"(?:US\s*\$|\$|USD)", "EUR": r"(?:€|EUR)", "GBP": r"(?:£|GBP)"}.get(currency, code)
    found = re.search(rf"(?<!\w)(?:{prefix}\s*{number}|{number}\s*{code})(?![\d,]|\.\d)", text, re.I)
    if not found and amount_minor == 0:
        found = re.search(r"\b(?:no (?:application |permit |filming |parking )?fees?|free of charge|no charge)\b", text, re.I)
    return found


def attach_fee_amount_evidence(cost: dict, extracted: dict | None = None) -> bool:
    """Attach the actual fee-bearing passage; this does not establish applicability or approval."""
    source = cost.get("source")
    if not source:
        return False
    passages = [(source.get("excerpt", ""), None)]
    if not source.get("cached"):
        for item in (extracted or {}).get("results", []):
            if item.get("url") == source.get("url"):
                passages += [(text, (extracted or {}).get("retrievedAt")) for text in
                             [item.get("full_content", ""), *item.get("excerpts", [])] if isinstance(text, str)]
    for text, retrieved_at in passages:
        match = fee_amount_match(text, cost.get("amountMinor"), cost.get("currency", "USD"))
        if match:
            source["excerpt"] = text[max(0, match.start() - 200):match.end() + 450]
            if retrieved_at:
                source["retrievedAt"] = retrieved_at
            return True
    return False


def monetary_values(text: str) -> set[tuple[str, Decimal]]:
    """Normalize explicit currency amounts, including insurance shorthand such as $1 million."""
    number = r"\d+(?:,\d{3})*(?:\.\d+)?"
    scale = r"(?:\s*(?P<scale>thousand|million|billion|k|m)\b)?"
    patterns = [
        rf"(?<!\w)(?P<currency>US\s*\$|\$|USD|EUR|€|GBP|£)\s*(?P<number>{number}){scale}(?![\d,]|\.\d)",
        rf"(?<![\w$,])(?P<number>{number}){scale}\s*(?P<currency>USD|US dollars?|dollars?|EUR|euros?|GBP|pounds?)\b",
    ]
    currencies = {"$": "USD", "US$": "USD", "DOLLAR": "USD", "DOLLARS": "USD", "USDOLLAR": "USD", "USDOLLARS": "USD",
                  "€": "EUR", "EURO": "EUR", "EUROS": "EUR", "£": "GBP", "POUND": "GBP", "POUNDS": "GBP"}
    scales = {None: 1, "thousand": 1000, "k": 1000, "million": 1000000, "m": 1000000, "billion": 1000000000}
    values = set()
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I):
            currency = re.sub(r"\s", "", match["currency"]).upper()
            amount = Decimal(match["number"].replace(",", "")) * scales[(match["scale"] or "").lower() or None]
            values.add((currencies.get(currency, currency), amount))
    return values


def attach_requirement_passage(source: dict, requirement: dict, extracted: dict | None = None) -> bool:
    """Keep a relevant provider passage instead of a page title; not an entailment or approval check."""
    words = lambda text: set(re.findall(r"\b\w{4,}\b", text.lower()))
    stop = {"this", "that", "with", "from", "have", "will", "must", "should", "their", "your", "there"}
    terms = words(" ".join(requirement.get(key, "") for key in ["title", "detail"])) - stop
    claimed_amounts = monetary_values(" ".join(requirement.get(key, "") for key in ["title", "detail"]))
    title_words = words(source.get("title", ""))
    passages = [(source.get("excerpt", ""), None)]
    if not source.get("cached"):
        for item in (extracted or {}).get("results", []):
            if item.get("url") == source.get("url"):
                passages += [(text, extracted.get("retrievedAt")) for text in
                             [item.get("full_content", ""), *item.get("excerpts", [])] if isinstance(text, str)]
    candidates = []
    for text, retrieved_at in passages:
        for start in range(0, len(text), 800):
            passage = text[start:start + 1600]
            content = words(passage) - stop
            score = len((content - title_words) & terms)
            # Shared vocabulary alone cannot substantiate precise financial
            # claims (for example, insurance coverage limits). Keep them
            # unresolved unless the same applicable passage contains each sum.
            if content - title_words and score >= 2 and claimed_amounts <= monetary_values(passage):
                candidates.append((score, passage, retrieved_at))
    if not candidates:
        return False
    _, passage, retrieved_at = max(candidates, key=lambda candidate: candidate[0])
    source["excerpt"] = passage
    if retrieved_at:
        source["retrievedAt"] = retrieved_at
    return True


def normalize_sources(result: dict, evidence: dict, previous_location: dict | None = None, *, allow_fee_estimates: bool = False, extracted_evidence: dict | None = None) -> dict:
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
            explanation = " ".join(cost.get(key) or "" for key in ["assumptions", "coverageReason"])
            if cost.get("basis") in {"published", "quote"} and re.search(r"\b(mid[- ]?range|midpoint|assum(?:e[sd]?|ing)|estimated|rounded|rounding)\b", explanation, re.I):
                cost["basis"] = "estimate"
            if cost.get("basis") in {"published", "quote"} and not attach_fee_amount_evidence(cost, extracted_evidence):
                cost.update(basis="unknown", amountMinor=None,
                            assumptions="The retrieved evidence does not establish this fee amount. Confirm the applicable rate, quantity and category or obtain a quote.")
            classification_text = " ".join([cost.get("label", ""), explanation, (cost.get("source") or {}).get("excerpt", "")])
            if mentions_shoot_classification(classification_text):
                if cost.get("basis") in {"published", "quote"}:
                    cost["basis"] = "estimate"
                # Classification remains unconfirmed even if an earlier guard
                # already removed the amount. Do not leave a contradictory
                # eligibility claim in the cost's coverage explanation.
                cost.update(coverageReason="The authority must confirm the applicable shoot category and eligibility for the complete production; crew size and handheld equipment alone do not establish qualification.",
                            assumptions="The authority must confirm the applicable simple/complex shoot category and fees before this cost can be relied on.")
            if cost.get("basis") == "published" and re.search(r"\b(?:hours?|hourly|hrs?)\b", cost.get("unit", ""), re.I):
                # A published hourly rate does not establish how many hours the
                # whole plan will be billed. Scene durations can be estimates,
                # and shared-location scope can grow after initial discovery.
                cost.update(basis="estimate",
                            coverageReason="Billable hours for the complete plan remain unconfirmed; confirm duration, minimums and rounding with the authority.",
                            assumptions="The source establishes an hourly rate, not a confirmed plan quantity. This line is a provisional quantity-based estimate.")
            if cost.get("basis") == "estimate" and not allow_fee_estimates:
                cost.update(basis="unknown", amountMinor=None,
                            assumptions="No producer approval for fee estimates. Confirm the applicable rate, quantity and fee category or obtain a quote before including an amount.")
            if cost.get("basis") == "unknown":
                cost["amountMinor"] = None
        for req in location.get("requirements", []):
            inapplicable = []
            substantive = []
            for source in req.get("sources", []):
                host = urlparse(source["url"]).hostname or ""
                if source["url"] not in observed_urls or not (host == "film.ca.gov" or host == "parks.ca.gov" or host.endswith(".parks.ca.gov")):
                    applicable_urls = [url for url in sorted(observed_urls) if len(url) <= 1000
                                       and official_source_applies(discovered.get(url, saved.get(url, {})), location)][:8]
                    raise ValueError(
                        "A supported requirement must cite retrieved official California evidence using the exact observed URL. "
                        "If none applies, keep it unresolved with sources=[], no formUrl and attachments=[], "
                        "and state that the authority must confirm it; or omit it. "
                        f"Rejected citation: {source['url'][:1000]!r}. "
                        f"Requirement: {req.get('title', '')[:160]!r}. Applicable observed URLs: {json.dumps(applicable_urls)}.")
                observed_source(source)
                if not official_source_applies(source, location):
                    inapplicable.append(source)
                elif attach_requirement_passage(source, req, extracted_evidence):
                    substantive.append(source)
            if inapplicable:
                req["sources"] = [source for source in req.get("sources", []) if source not in inapplicable]
                if not req["sources"]:
                    req.update(status="unresolved", detail="The retrieved official reference is not verified for this park. Confirm the applicable requirement with this location's authority.", attachments=[])
                    req.pop("formUrl", None)
            if req.get("status") == "sourced" and not req.get("sources"):
                raise ValueError("Requirement has no official source.")
            if req.get("status") == "sourced" and not substantive:
                req.update(status="unresolved", detail="The saved official reference does not contain substantive guidance for this requirement. Confirm its applicability and details with the location authority.", attachments=[])
                req.pop("formUrl", None)
            if mentions_shoot_classification(" ".join(req.get(key, "") for key in ["title", "detail"])):
                req.update(status="unresolved", detail="The source describes simple/complex shoot categories, but the authority must confirm this production's category, eligibility and applicable fees. Crew size and handheld equipment alone do not establish classification.", attachments=[])
                req.pop("formUrl", None)
            req["externalStatus"] = "unverified"
        location["availability"] = "unverified"
        # Model-supplied image addresses require separately verified media provenance.
        location.pop("imageUrl", None)
        location.pop("imageSourceUrl", None)
    return result
