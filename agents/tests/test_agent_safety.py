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


@pytest.mark.asyncio
@pytest.mark.parametrize("always_invalid", [False, True])
async def test_invalid_research_quantity_is_repaired_without_repeating_search(monkeypatch, always_invalid):
    import json
    from types import SimpleNamespace
    from google.adk.agents import LlmAgent
    from google.adk.events import Event
    from google.genai import types
    from sceneatlas import agent

    task = {"run": {"_id": "run", "kind": "research", "targetId": "scene"}, "entities": [
        {"_id": "scene", "kind": "scene", "data": {"kind": "scene", "setting": "Beach", "needs": ["Open sand"], "candidateCount": 1}},
        {"kind": "question", "data": {"key": "search_area", "answer": "Los Angeles County", "resolution": "answered"}},
    ]}
    model_calls, searches = [], []

    class Backend:
        def __init__(self, *_):
            pass

        async def post(self, operation):
            assert operation == "context"
            return task

    async def tool(self, *, args, tool_context):
        searches.append(args)
        return {"provider": "exa", "fallbackReason": "Test fixture", "searchId": "exa_test", "retrievedAt": 1, "results": [{"url": "https://film.ca.gov/state-permits/", "title": "Official", "excerpt": "Observed evidence"}]}

    async def model(self, ctx):
        model_calls.append(ctx.session.state["task_context"].get("validationFeedback"))
        result = {"locations": [{"kind": "location", "name": "Fixture beach", "address": "", "description": "Fixture", "creativeFit": "Open sand", "restrictions": [], "availability": "unverified", "authority": "", "sources": [{"url": "https://film.ca.gov/state-permits/"}], "requirements": [], "sceneIds": ["scene"], "rejected": False, "costs": [{"id": "fee", "label": "Unknown fee", "amountMinor": None, "currency": "USD", "unit": "day", "quantity": 0 if always_invalid or len(model_calls) == 1 else 1, "basis": "unknown", "coverageKey": "fee", "coverageReason": "Quote required", "assumptions": ""}]}], "questions": [], "message": "Fixture", "lockConflicts": []}
        yield Event(invocation_id=ctx.invocation_id, author=self.name, content=types.Content(role="model", parts=[types.Part(text=json.dumps(result))]))

    monkeypatch.setattr(agent, "Backend", Backend)
    monkeypatch.setattr(agent, "ToolContext", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(agent.FunctionTool, "run_async", tool)
    monkeypatch.setattr(LlmAgent, "run_async", model)
    ctx = SimpleNamespace(invocation_id="research-repair", session=SimpleNamespace(state={}), user_content=types.Content(parts=[types.Part(text='{"runId":"run","attempt":1}')]))
    events = []
    async def collect():
        async for event in agent.SceneAtlasAgent()._run_async_impl(ctx):
            events.append(event)
    if always_invalid:
        with pytest.raises(ValueError, match="three attempts"):
            await collect()
        assert len(model_calls) == 3
        assert not any("sceneatlasResult" in (p.text or "") for e in events for p in (e.content.parts if e.content else []))
    else:
        await collect()
        result = json.loads(events[-1].content.parts[0].text)["sceneatlasResult"]
        assert result["locations"][0]["costs"][0]["quantity"] == 1
        assert result["locations"][0]["costs"][0]["amountMinor"] is None
        assert len(model_calls) == 2 and model_calls[1]
    assert len(searches) == 1
