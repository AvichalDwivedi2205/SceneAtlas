import pytest

from sceneatlas.agent import extract_pages, validate_draft
from sceneatlas.research import bound_context, normalize_sources


def test_text_extraction_and_exact_excerpt_validation():
    pages = extract_pages(b"INT. ROOM - DAY\nMara studies a trail map on the wall.\n" * 2, "text/plain")
    scene = {"kind": "scene", "number": 1, "heading": "INT. ROOM - DAY", "excerpt": "Mara studies a trail map on the wall.", "pageStart": 1, "pageEnd": 1, "setting": "Room", "interiorExterior": "INT", "timeOfDay": "DAY", "needs": [], "durationMinutes": None, "durationBasis": "unknown", "candidateCount": 3, "ranking": "creative", "windows": []}
    validate_draft({"scenes": [scene]}, pages)
    scene["excerpt"] = "Text never present in screenplay"
    with pytest.raises(ValueError, match="could not be matched"):
        validate_draft({"scenes": [scene]}, pages)


def test_research_rejects_fabricated_source_url():
    result = {"locations": [{"sources": [{"url": "https://fake.invalid/a"}], "costs": [], "requirements": []}]}
    evidence = {"searchId": "search-1", "retrievedAt": 1, "results": [{"url": "https://film.ca.gov/state-permits/", "title": "Official", "excerpt": "Observed"}]}
    with pytest.raises(ValueError, match="not returned"):
        normalize_sources(result, evidence)


def test_research_preserves_observed_metadata_and_unknown_cost():
    url = "https://film.ca.gov/state-permits/"
    draft = {"url": url, "title": "model title", "excerpt": "model excerpt", "retrievedAt": 0, "provider": "parallel", "cached": False}
    result = {"locations": [{"sources": [draft.copy()], "costs": [{"basis": "unknown", "amountMinor": 100}], "requirements": [{"status": "sourced", "sources": [draft.copy()], "externalStatus": "unverified"}], "availability": "unverified"}]}
    evidence = {"searchId": "search-1", "retrievedAt": 99, "results": [{"url": url, "title": "Observed title", "excerpt": "Observed excerpt"}]}
    normalized = normalize_sources(result, evidence)
    assert normalized["locations"][0]["sources"][0]["title"] == "Observed title"
    assert normalized["locations"][0]["costs"][0]["amountMinor"] is None


def test_uncited_model_fee_is_unknown_instead_of_a_published_fact():
    result = {"locations": [{"sources": [], "costs": [{"basis": "published", "amountMinor": 99900}], "requirements": []}]}
    normalized = normalize_sources(result, {"results": []})
    cost = normalized["locations"][0]["costs"][0]
    assert cost["basis"] == "unknown"
    assert cost["amountMinor"] is None


def test_extracted_context_is_bounded_recursively():
    bounded = bound_context({"nested": {"content": "x" * 20_000}, "many": list(range(150))})
    assert len(bounded["nested"]["content"]) == 12_000
    assert len(bounded["many"]) == 100

@pytest.mark.asyncio
async def test_progress_events_include_managed_session_invocation(monkeypatch):
    from types import SimpleNamespace
    from google.genai import types
    from sceneatlas import agent

    class FakeBackend:
        def __init__(self, *_):
            pass

        async def post(self, _):
            return {"run": {"kind": "ingest"}}

    monkeypatch.setattr(agent, "Backend", FakeBackend)
    context = SimpleNamespace(invocation_id="invocation-test", user_content=types.Content(parts=[types.Part(text='{"runId":"test","attempt":1}')]))
    stream = agent.SceneAtlasAgent()._run_async_impl(context)
    event = await anext(stream)
    assert event.invocation_id == "invocation-test"
    assert event.actions.state_delta["activity"] == "Reading screenplay"
    await stream.aclose()


def test_model_contract_requires_question_ownership_envelope():
    from pydantic import ValidationError
    from sceneatlas.agent import Draft

    flat_question = {"kind": "question", "prompt": "Which scenes?"}
    with pytest.raises(ValidationError, match="data"):
        Draft.model_validate({"questions": [flat_question]})
    parsed = Draft.model_validate({"questions": [{"data": flat_question, "sceneNumber": 1}]})
    assert parsed.questions[0].sceneNumber == 1
    assert parsed.questions[0].data == flat_question


def test_generation_schema_closes_entities_but_leaves_bounds_to_validation():
    from sceneatlas.result_schema import workflow_schema
    schema = workflow_schema("scenes")
    scene = schema["properties"]["scenes"]["items"]
    assert scene["additionalProperties"] is False
    assert "heading" in scene["required"]
    assert "maximum" not in scene["properties"]["number"]
    question = schema["properties"]["questions"]["items"]
    assert question["required"] == ["data", "sceneNumber"]
    assert question["properties"]["data"]["properties"]["answer"] == {"type": "null"}


def test_research_requires_real_production_area_on_legacy_boards():
    from sceneatlas.agent import missing_intake
    assert missing_intake({"entities": []}, "research")[0]["data"]["key"] == "search_area"
    assert missing_intake({"entities": [{"kind": "question", "data": {"key": "search_area", "resolution": "answered", "answer": "Los Angeles County"}}]}, "research") == []
