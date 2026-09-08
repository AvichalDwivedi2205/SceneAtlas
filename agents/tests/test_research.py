import json
import httpx
import pytest
from parallel import AsyncParallel, APIConnectionError, APIStatusError, AuthenticationError, BadRequestError, PermissionDeniedError

from sceneatlas import research


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
    (402, "quota or rate limit", 1),
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
