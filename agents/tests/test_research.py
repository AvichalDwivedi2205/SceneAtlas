import asyncio
import json
import httpx
import pytest
from parallel import AsyncParallel, APIConnectionError, APIStatusError, AuthenticationError, BadRequestError, PermissionDeniedError

from sceneatlas import research


@pytest.fixture(autouse=True)
def isolated_key_pool(monkeypatch):
    for name in ["PARALLEL_API_KEY", *(f"PARALLEL_API_KEY{i}" for i in range(1, 5))]:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(research, "_pool", None)


def use_parallel_transport(monkeypatch, respond):
    """Exercise the installed SDK, including its real retry and error mappings."""
    monkeypatch.setenv("PARALLEL_API_KEY", "test-only")
    monkeypatch.delenv("PARALLEL_BASE_URL", raising=False)
    monkeypatch.setattr(research, "AsyncParallel", lambda **kwargs: AsyncParallel(
        **kwargs, http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))))


@pytest.mark.asyncio
async def test_search_uses_installed_sdk_and_preserves_runtime_provenance(monkeypatch):
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={
            "search_id": "search-live-contract",
            "results": [{"url": "https://film.ca.gov/state-permits/", "title": "State permits", "excerpts": ["Observed source text"], "publish_date": None}],
            "warnings": None,
        })

    use_parallel_transport(monkeypatch, respond)
    result = await research.search_sources("Find official filming guidance " * 400, ["state filming permits"])
    assert [str(request.url) for request in requests] == ["https://api.parallel.ai/v1/search"]
    assert len(json.loads(requests[0].content)["objective"]) <= 5000
    assert result["searchId"] == "search-live-contract"
    assert result["retrievedAt"] > 0
    assert result["results"][0]["excerpt"] == "Observed source text"
    normalized = research.normalize_sources({"locations": [{"sources": [{"url": result["results"][0]["url"]}], "costs": [], "requirements": []}]}, result)
    source = normalized["locations"][0]["sources"][0]
    assert source["provider"] == "parallel"
    assert source["searchId"] == result["searchId"]
    assert source["retrievedAt"] == result["retrievedAt"]
    assert source["excerpt"] == "Observed source text"


def test_requirements_search_retains_production_facts_without_old_page_text():
    objective, queries = research.research_request(
        {"name": "Point Dume State Beach", "address": "Malibu", "sources": [{"excerpt": "EXISTING_PAGE_TEXT" * 1000}]},
        [{"key": "search_area", "answer": "Los Angeles County"}, {"key": "production_activities", "answer": "Four people, handheld camera, no drones."}],
    )
    assert "Point Dume State Beach" in objective
    assert "Four people" in objective
    assert "EXISTING_PAGE_TEXT" not in objective
    assert len(objective) <= 5000
    assert all(len(query) <= 500 for query in queries)


def test_requirements_refresh_preserves_saved_provenance_without_claiming_new_retrieval():
    url = "https://film.ca.gov/state-permits/state-parks-beaches/"
    prior = {"url": url, "title": "Previously observed guidance", "excerpt": "Original text", "provider": "parallel", "searchId": "search_original", "retrievedAt": 100, "cached": False}
    result = {"locations": [{"sources": [{"url": url, "retrievedAt": 999}], "costs": [], "requirements": [{"sources": [{"url": url}], "status": "sourced"}]}]}
    evidence = {"results": [], "searchId": "search_refresh", "retrievedAt": 200}
    normalized = research.normalize_sources(result, evidence, {"sources": [prior]})
    source = normalized["locations"][0]["sources"][0]
    assert source == {**prior, "cached": True}
    assert normalized["locations"][0]["requirements"][0]["sources"][0] == source
    assert prior["cached"] is False
    evidence["results"] = [{"url": url, "title": "Newly observed guidance", "excerpt": "Current text"}]
    fresh = research.normalize_sources(result, evidence, {"sources": [prior]})["locations"][0]["sources"][0]
    assert fresh["searchId"] == "search_refresh"
    assert fresh["retrievedAt"] == 200
    assert fresh["cached"] is False
    with pytest.raises(ValueError, match="not returned"):
        research.normalize_sources({"locations": [{"sources": [{"url": "https://example.com/fabricated"}]}]}, evidence, {"sources": [prior]})


@pytest.mark.asyncio
@pytest.mark.parametrize("failure, message, attempts", [
    (429, "quota or rate limit", 3),
    (500, "temporarily unavailable", 3),
    (503, "temporarily unavailable", 3),
    ("connect", "connection or timeout", 3),
    ("timeout", "connection or timeout", 3),
])
async def test_capacity_and_transient_failures_remain_on_parallel(monkeypatch, failure, message, attempts):
    requests = []

    def respond(request):
        requests.append(request)
        if failure == "connect":
            raise httpx.ConnectError("Connection unavailable", request=request)
        if failure == "timeout":
            raise httpx.ReadTimeout("Request timed out", request=request)
        return httpx.Response(failure, headers={"retry-after-ms": "1"}, json={"error": "Provider unavailable"})

    use_parallel_transport(monkeypatch, respond)
    with pytest.raises(RuntimeError, match=message) as caught:
        await research.search_sources("Find filming guidance", ["State permits"])
    assert "Retry later or check Parallel account capacity" in str(caught.value)
    assert isinstance(caught.value.__cause__, (APIConnectionError, APIStatusError))
    assert [str(request.url) for request in requests] == ["https://api.parallel.ai/v1/search"] * attempts


@pytest.mark.asyncio
@pytest.mark.parametrize("status, error_type", [(400, BadRequestError), (401, AuthenticationError), (403, PermissionDeniedError)])
async def test_request_and_auth_failures_are_not_hidden_or_retried(monkeypatch, status, error_type):
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(status, json={"error": "Request or account configuration must be fixed"})

    use_parallel_transport(monkeypatch, respond)
    with pytest.raises(error_type) as caught:
        await research.search_sources("Find filming guidance", ["State permits"])
    assert caught.value.status_code == status
    assert research.provider_failure(caught.value) is None
    assert [str(request.url) for request in requests] == ["https://api.parallel.ai/v1/search"]


@pytest.mark.asyncio
async def test_missing_parallel_key_stops_before_network_access(monkeypatch):
    def unexpected_client(**_):
        pytest.fail("Missing credentials must stop before creating a network client")

    monkeypatch.delenv("PARALLEL_API_KEY", raising=False)
    monkeypatch.setattr(research, "AsyncParallel", unexpected_client)
    with pytest.raises(RuntimeError, match="Add PARALLEL_API_KEY to the agent deployment"):
        await research.search_sources("Find filming guidance", ["State permits"])


@pytest.mark.parametrize("assumptions", ["Using the mid-range of published parking fees for one assumed vehicle.", "Assumes one vehicle for the crew.", "Assume a monitor is assigned for six hours."])
def test_modeled_fee_is_an_estimate_even_when_its_rate_has_a_source(assumptions):
    url = "https://film.ca.gov/state-permits/state-parks-beaches/"
    evidence = {"results": [{"url": url, "title": "Parking guidance", "excerpt": "Parking rates vary by location."}], "searchId": "search_fee", "retrievedAt": 200}
    location = {"sources": [{"url": url}], "costs": [{"basis": "published", "amountMinor": 1500, "assumptions": assumptions, "source": {"url": url}}], "requirements": []}
    cost = research.normalize_sources({"locations": [location]}, evidence)["locations"][0]["costs"][0]
    assert cost["basis"] == "estimate"
    assert cost["amountMinor"] == 1500
    assert cost["source"]["searchId"] == "search_fee"


def test_another_parks_official_form_does_not_establish_this_parks_rules():
    url = "https://parks.ca.gov/pages/644/files/Film%20Permit%20Request-Information%20-.pdf"
    evidence = {"results": [{"url": url, "title": "Crystal Cove State Park activity information", "excerpt": "Location: Crystal Cove State Park. Location-specific provisions."}], "searchId": "search_park", "retrievedAt": 200}
    location = {"name": "Leo Carrillo State Park", "sources": [{"url": url}], "costs": [{"basis": "published", "amountMinor": 6500, "source": {"url": url}}], "requirements": [{"status": "sourced", "detail": "A restriction from the other park.", "sources": [{"url": url}], "formUrl": url, "attachments": ["Other park form"]}]}
    normalized = research.normalize_sources({"locations": [location]}, evidence)["locations"][0]
    assert normalized["costs"][0]["amountMinor"] is None
    requirement = normalized["requirements"][0]
    assert requirement["status"] == "unresolved"
    assert requirement["sources"] == []
    assert "formUrl" not in requirement
    assert "not verified for this park" in requirement["detail"]
    assert research.official_source_applies(evidence["results"][0], {"name": "Crystal Cove State Park"})


@pytest.mark.asyncio
async def test_extract_uses_parallel_sdk_and_preserves_partial_results(monkeypatch):
    requests = []
    url = "https://film.ca.gov/state-permits/"
    missing_url = "https://parks.ca.gov/unavailable"
    failure = {"url": missing_url, "error_type": "HTTP_ERROR", "http_status_code": 503, "content": None}

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={"extract_id": "extract-observed", "session_id": "session-test", "results": [{"url": url, "title": "Observed official guidance", "excerpts": ["Retrieved permit guidance"], "full_content": "x" * 20_000}], "errors": [failure]})

    use_parallel_transport(monkeypatch, respond)
    monkeypatch.setattr(research, "public_url", lambda value: value)
    evidence = await research.parallel_extract([url, missing_url])
    assert [str(request.url) for request in requests] == ["https://api.parallel.ai/v1/extract"]
    assert json.loads(requests[0].content)["urls"] == [url, missing_url]
    assert evidence["results"][0]["url"] == url
    assert evidence["results"][0]["excerpts"] == ["Retrieved permit guidance"]
    assert len(evidence["results"][0]["full_content"]) == 12_000
    assert evidence["errors"] == [failure]
    assert evidence["extractId"] == "extract-observed"
    assert evidence["retrievedAt"] > 0


def configure_four_keys(monkeypatch):
    monkeypatch.delenv("PARALLEL_API_KEY", raising=False)
    for i in range(1, 5):
        monkeypatch.setenv(f"PARALLEL_API_KEY{i}", f"test-slot-{i}")


@pytest.mark.asyncio
async def test_legacy_single_key_credit_exhaustion_is_actionable(monkeypatch):
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(402, json={"error": {"message": "Insufficient credit"}})
    use_parallel_transport(monkeypatch, respond)
    with pytest.raises(research.ParallelCreditsExhausted, match="The configured Parallel API key has"):
        await research.search_sources("Guidance", [])
    assert len(requests) == 1


def search_response():
    return httpx.Response(200, json={"search_id": "search-after-failover", "results": [
        {"url": "https://film.ca.gov/state-permits/", "title": "Observed source", "excerpts": ["Real retrieved text"], "publish_date": None}
    ], "warnings": None})


@pytest.mark.asyncio
async def test_credit_failover_follows_all_four_keys_and_extract_reuses_active_key(monkeypatch):
    requests = []
    def respond(request):
        key = request.headers["x-api-key"]
        requests.append((key, request.url.path))
        if key != "test-slot-4":
            return httpx.Response(402, json={"error": {"message": "Insufficient credit"}})
        if request.url.path.endswith("extract"):
            return httpx.Response(200, json={"extract_id": "extract-after-failover", "results": [], "errors": []})
        return search_response()

    use_parallel_transport(monkeypatch, respond)
    configure_four_keys(monkeypatch)
    monkeypatch.setattr(research, "public_url", lambda value: value)
    evidence = await research.search_sources("Find official guidance", ["state permits"])
    extracted = await research.parallel_extract([evidence["results"][0]["url"]])
    assert requests == [(f"test-slot-{i}", "/v1/search") for i in range(1, 5)] + [("test-slot-4", "/v1/extract")]
    assert evidence["searchId"] == "search-after-failover"
    assert evidence["results"][0]["excerpt"] == "Real retrieved text"
    assert extracted["extractId"] == "extract-after-failover"
    assert "test-slot" not in json.dumps([evidence, extracted])


@pytest.mark.asyncio
async def test_extract_credit_failure_advances_shared_search_key(monkeypatch):
    requests = []
    def respond(request):
        key = request.headers["x-api-key"]
        requests.append((key, request.url.path))
        if request.url.path.endswith("extract"):
            if key == "test-slot-1":
                return httpx.Response(402, json={"error": {"message": "Insufficient credit"}})
            return httpx.Response(200, json={"extract_id": "extract-next", "results": [], "errors": []})
        return search_response()
    use_parallel_transport(monkeypatch, respond)
    configure_four_keys(monkeypatch)
    monkeypatch.setattr(research, "public_url", lambda value: value)
    await research.parallel_extract(["https://film.ca.gov/state-permits/"])
    await research.search_sources("Guidance", [])
    assert requests == [("test-slot-1", "/v1/extract"), ("test-slot-2", "/v1/extract"), ("test-slot-2", "/v1/search")]


@pytest.mark.asyncio
async def test_all_keys_exhausted_is_safe_actionable_and_recovers_after_cooldown(monkeypatch):
    requests = []
    replenished = False
    now = [1000.0]
    def respond(request):
        requests.append(request.headers["x-api-key"])
        if replenished:
            return search_response()
        return httpx.Response(402, json={"error": {"message": f"Credit unavailable for {request.headers['x-api-key']}"}})
    use_parallel_transport(monkeypatch, respond)
    configure_four_keys(monkeypatch)
    monkeypatch.setattr(research.time, "monotonic", lambda: now[0])
    for _ in range(2):
        with pytest.raises(research.ParallelCreditsExhausted, match="All 4 configured Parallel API keys") as caught:
            await research.search_sources("Guidance", [])
        assert "Add credits or update" in str(caught.value)
        assert "test-slot" not in str(caught.value)
        assert caught.value.__cause__ is None
        assert research.provider_failure(caught.value)
    assert requests == [f"test-slot-{i}" for i in range(1, 5)]
    replenished = True
    now[0] += research.EXHAUSTED_KEY_COOLDOWN_SECONDS + 1
    assert (await research.search_sources("Guidance", []))["searchId"] == "search-after-failover"
    assert requests[-1] == "test-slot-1"


@pytest.mark.asyncio
@pytest.mark.parametrize("status, attempts", [(400, 1), (401, 1), (403, 1), (429, 3), (503, 3)])
async def test_non_credit_errors_do_not_switch_key_with_four_keys(monkeypatch, status, attempts):
    requests = []
    def respond(request):
        requests.append(request.headers["x-api-key"])
        return httpx.Response(status, headers={"retry-after-ms": "1"}, json={"error": {"message": "Failure"}})
    use_parallel_transport(monkeypatch, respond)
    configure_four_keys(monkeypatch)
    with pytest.raises((RuntimeError, APIStatusError)):
        await research.search_sources("Guidance", [])
    assert requests == ["test-slot-1"] * attempts
    assert research.parallel_key_pool().next_key(set()) == (0, "test-slot-1")


@pytest.mark.asyncio
async def test_authentication_error_preserves_type_without_exposing_provider_body(monkeypatch):
    def respond(request):
        return httpx.Response(401, json={"error": {"message": f"Rejected {request.headers['x-api-key']}"}})
    use_parallel_transport(monkeypatch, respond)
    with pytest.raises(AuthenticationError) as caught:
        await research.search_sources("Guidance", [])
    assert caught.value.status_code == 401
    assert "credentials and account permissions" in str(caught.value)
    assert "test-only" not in str(caught.value)
    assert caught.value.body is None


@pytest.mark.asyncio
async def test_concurrent_credit_failures_do_not_skip_healthy_keys(monkeypatch):
    requests = []
    arrived = asyncio.Event()
    first_count = 0
    async def respond(request):
        nonlocal first_count
        key = request.headers["x-api-key"]
        requests.append(key)
        if key == "test-slot-1":
            first_count += 1
            if first_count == 4:
                arrived.set()
            await asyncio.wait_for(arrived.wait(), timeout=1)
            return httpx.Response(402, json={"error": {"message": "Insufficient credit"}})
        return search_response()
    use_parallel_transport(monkeypatch, respond)
    configure_four_keys(monkeypatch)
    results = await asyncio.gather(*(research.search_sources("Guidance", []) for _ in range(4)))
    assert len(results) == 4
    assert requests.count("test-slot-1") == 4
    assert requests.count("test-slot-2") == 4
    assert set(requests) == {"test-slot-1", "test-slot-2"}


def test_numbered_key_configuration_trims_deduplicates_and_rejects_ambiguous_first_key(monkeypatch):
    configure_four_keys(monkeypatch)
    monkeypatch.setenv("PARALLEL_API_KEY", " test-slot-1\n")
    monkeypatch.setenv("PARALLEL_API_KEY2", "test-slot-1")
    monkeypatch.setenv("PARALLEL_API_KEY3", "  ")
    assert research.configured_parallel_keys() == ("test-slot-1", "test-slot-4")
    monkeypatch.setenv("PARALLEL_API_KEY", "different-secret")
    with pytest.raises(RuntimeError, match="either PARALLEL_API_KEY or PARALLEL_API_KEY1") as caught:
        research.configured_parallel_keys()
    assert "different-secret" not in str(caught.value)
