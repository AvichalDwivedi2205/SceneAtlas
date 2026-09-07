import json
import httpx
import pytest
from parallel import AsyncParallel, RateLimitError, AuthenticationError

from sceneatlas import research


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

    client = AsyncParallel(api_key="test-only", http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)))
    monkeypatch.setenv("PARALLEL_API_KEY", "test-only")
    monkeypatch.setattr(research, "AsyncParallel", lambda **_: client)
    result = await research.parallel_search("Find official filming guidance " * 400, ["state filming permits"])
    assert requests[0].url.path == "/v1/search"
    assert len(json.loads(requests[0].content)["objective"]) <= 5000
    assert result["searchId"] == "search-live-contract"
    assert result["retrievedAt"] > 0
    assert result["results"][0]["excerpt"] == "Observed source text"
    await client.close()


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
async def test_exa_fallback_requires_opt_in_and_does_not_hide_auth_failures(monkeypatch):
    calls = []
    response = httpx.Response(429, request=httpx.Request("POST", "https://api.parallel.ai/v1/search"))

    async def limited(*_):
        raise RateLimitError("Rate limit", response=response, body={})

    async def backup(objective, queries, reason):
        calls.append(reason)
        return {"provider": "exa", "searchId": "exa-request", "fallbackReason": reason}

    monkeypatch.setattr(research, "parallel_search", limited)
    monkeypatch.setattr(research, "exa_search", backup)
    monkeypatch.setenv("EXA_FALLBACK_ENABLED", "false")
    with pytest.raises(RuntimeError, match="disabled"):
        await research.search_sources("Test", ["Test"])
    assert calls == []
    monkeypatch.setenv("EXA_FALLBACK_ENABLED", "true")
    assert (await research.search_sources("Test", ["Test"]))["provider"] == "exa"
    assert len(calls) == 1

    async def unauthorized(*_):
        raise AuthenticationError("Invalid key", response=httpx.Response(401, request=response.request), body={})

    monkeypatch.setattr(research, "parallel_search", unauthorized)
    with pytest.raises(AuthenticationError):
        await research.search_sources("Test", ["Test"])
    assert len(calls) == 1


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
async def test_exa_transport_and_normalization_preserve_backup_provenance(monkeypatch):
    requests = []
    url = "https://film.ca.gov/state-permits/"

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={"requestId": "actual-response-id", "results": [{"url": url, "title": "Observed official guidance", "text": "Retrieved permit guidance"}]})

    client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    monkeypatch.setenv("EXA_API_KEY", "test-only")
    monkeypatch.setattr(research.httpx, "AsyncClient", lambda **_: client)
    evidence = await research.exa_search("Find filming guidance", ["State film permits"], "Parallel quota or rate limit reached")
    assert str(requests[0].url) == "https://api.exa.ai/search"
    assert evidence["searchId"] == "exa_actual-response-id"
    result = research.normalize_sources({"locations": [{"sources": [{"url": url}], "costs": [], "requirements": []}]}, evidence)
    source = result["locations"][0]["sources"][0]
    assert source["provider"] == "exa"
    assert source["fallbackReason"] == "Parallel quota or rate limit reached"
    assert source["excerpt"] == "Retrieved permit guidance"
