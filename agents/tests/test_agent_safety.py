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


def test_research_generation_uses_url_references_instead_of_repeating_evidence():
    from sceneatlas.result_schema import workflow_schema
    location = workflow_schema("research")["properties"]["locations"]["items"]["properties"]
    for reference in [location["sources"]["items"], location["costs"]["items"]["properties"]["source"], location["requirements"]["items"]["properties"]["sources"]["items"]]:
        assert reference == {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"], "additionalProperties": False}


def test_scene_generation_retains_card_text_limits():
    from sceneatlas.agent import SceneAtlasAgent
    specialist = next(a for a in SceneAtlasAgent().sub_agents if a.name == "scenes_specialist")
    segment = specialist.generate_content_config.response_json_schema["properties"]["segments"]["items"]["properties"]
    assert segment["needs"]["items"]["maxLength"] == 200
    assert segment["setting"]["maxLength"] == 300
    assert segment["timeOfDay"]["maxLength"] == 100


def test_specialist_request_does_not_inherit_earlier_batch_drafts():
    from types import SimpleNamespace
    from google.adk.models.llm_request import LlmRequest
    from google.genai import types
    from sceneatlas.agent import isolate_model_input
    request = LlmRequest(contents=[types.Content(role="model", parts=[types.Part(text="EARLIER_BATCH_DRAFT")])],
        config=types.GenerateContentConfig(system_instruction="Authoritative current batch and validation feedback"))
    isolate_model_input(SimpleNamespace(state={}), request)
    assert "EARLIER_BATCH_DRAFT" not in request.model_dump_json()
    assert request.config.system_instruction == "Authoritative current batch and validation feedback"
    assert len(request.contents) == 1 and request.contents[0].role == "user"


def test_answered_question_cannot_put_its_owner_back_into_an_invisible_wait():
    from sceneatlas.agent import validate_new_questions
    entities = [{"kind": "question", "ownerId": "location-a", "data": {
        "key": "monitor_required", "resolution": "answered", "answer": "Keep monitor assignment unknown; use a contingency estimate."}}]
    repeated = {"questions": [{"ownerId": "location-a", "data": {"key": "monitor_required"}}]}
    with pytest.raises(ValueError, match="already answered"):
        validate_new_questions(repeated, entities)
    repeated["questions"][0]["ownerId"] = "location-b"
    validate_new_questions(repeated, entities)
    entities[0]["data"]["resolution"] = "open"
    repeated["questions"][0]["ownerId"] = "location-a"
    validate_new_questions(repeated, entities)


@pytest.mark.asyncio
@pytest.mark.parametrize("conflicts", [[], ["Confirm shooting dates."]])
async def test_complete_calculated_schedule_does_not_reask_confirmed_inputs(monkeypatch, conflicts):
    import json
    from types import SimpleNamespace
    from google.genai import types
    from google.adk.events import Event
    from sceneatlas import agent
    schedule = {"kind": "schedule", "planId": "plan", "entries": [] if conflicts else [{
        "sceneId": "scene", "sceneNumber": 1, "locationId": "location", "locationName": "Illustrative beach",
        "date": "2026-11-16", "start": 555, "end": 615, "durationBasis": "estimate", "reason": "Fits confirmed window."}],
        "conflicts": conflicts, "provisional": True, "moves": 0, "days": 0 if conflicts else 1,
        "explanation": "Proposed order. Location availability and permission remain unverified."}
    class FakeBackend:
        def __init__(self, *_): pass
        async def post(self, operation):
            assert operation == "context"
            return {"run": {"_id": "run", "kind": "schedule", "targetId": "plan"}, "schedule": schedule, "entities": []}
    calls = []
    async def generate(self, ctx):
        calls.append(self.name)
        yield Event(author=self.name, invocation_id=ctx.invocation_id,
            content=types.Content(role="model", parts=[types.Part(text='{"message":"Review the missing production inputs.","questions":[]}')]))
    monkeypatch.setattr(agent, "Backend", FakeBackend)
    monkeypatch.setattr(agent.LlmAgent, "run_async", generate)
    ctx = SimpleNamespace(invocation_id="schedule-test", session=SimpleNamespace(state={}),
        user_content=types.Content(parts=[types.Part(text='{"runId":"run","attempt":1}')]))
    events = [e async for e in agent.SceneAtlasAgent()._run_async_impl(ctx)]
    result = json.loads(events[-1].content.parts[0].text)["sceneatlasResult"]
    assert result["schedule"]["entries"] == schedule["entries"]
    assert result["schedule"]["provisional"] is True
    assert calls == (["schedule_specialist"] if conflicts else [])


def test_research_requires_real_production_area_on_legacy_boards():
    from sceneatlas.agent import missing_intake
    assert missing_intake({"entities": []}, "research")[0]["data"]["key"] == "search_area"
    assert [q["data"]["key"] for q in missing_intake({"entities": [{"kind": "question", "data": {"key": "search_area", "resolution": "answered", "answer": "Los Angeles County"}}]}, "research")] == ["fee_estimate_policy"]


@pytest.mark.asyncio
@pytest.mark.parametrize("always_invalid", [False, True])
@pytest.mark.parametrize("extract_status", [200, 402, 429, 401])
async def test_invalid_research_quantity_is_repaired_without_repeating_retrieval(monkeypatch, always_invalid, extract_status):
    import json
    import httpx
    from types import SimpleNamespace
    from google.adk.agents import LlmAgent
    from google.adk.events import Event
    from google.genai import types
    from parallel import AuthenticationError, RateLimitError
    from sceneatlas import agent
    from sceneatlas.research import ParallelCreditsExhausted

    task = {"run": {"_id": "run", "kind": "research", "targetId": "scene"}, "entities": [
        {"_id": "scene", "kind": "scene", "data": {"kind": "scene", "setting": "Beach", "needs": ["Open sand"], "candidateCount": 1}},
        {"kind": "question", "data": {"key": "search_area", "answer": "Los Angeles County", "resolution": "answered"}},
        {"kind": "question", "data": {"key": "fee_estimate_policy", "answer": "Keep unquoted fees unknown", "resolution": "answered"}},
    ]}
    model_calls, searches, extractions = [], [], []
    source_url = "https://film.ca.gov/state-permits/"
    search_evidence = {"provider": "parallel", "searchId": "search_test", "retrievedAt": 1, "results": [{"url": source_url, "title": "Official", "excerpt": "Observed search evidence"}]}
    extracted_evidence = {"extractId": "extract_test", "retrievedAt": 2, "requestedUrls": [source_url], "results": [{"url": source_url, "title": "Official", "excerpts": ["Observed page evidence"]}], "errors": []}

    class Backend:
        def __init__(self, *_):
            pass

        async def post(self, operation):
            assert operation == "context"
            return task

    async def tool(self, *, args, tool_context):
        if self.name == "search_sources":
            searches.append(args)
            return search_evidence
        assert self.name == "parallel_extract"
        extractions.append(args)
        if extract_status == 402:
            raise ParallelCreditsExhausted("All configured Parallel keys have insufficient available credits")
        if extract_status != 200:
            response = httpx.Response(extract_status, request=httpx.Request("POST", "https://api.parallel.ai/v1/extract"))
            error_type = RateLimitError if extract_status == 429 else AuthenticationError
            raise error_type("Fixture extract failure", response=response, body={})
        return extracted_evidence

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
    if extract_status == 401:
        with pytest.raises(AuthenticationError):
            await collect()
        assert model_calls == []
        assert not any("sceneatlasResult" in (p.text or "") for e in events for p in (e.content.parts if e.content else []))
    elif always_invalid:
        with pytest.raises(ValueError, match="three attempts"):
            await collect()
        assert len(model_calls) == 3
        assert not any("sceneatlasResult" in (p.text or "") for e in events for p in (e.content.parts if e.content else []))
    else:
        await collect()
        result = json.loads(events[-1].content.parts[0].text)["sceneatlasResult"]
        assert result["locations"][0]["costs"][0]["quantity"] == 1
        assert result["locations"][0]["costs"][0]["amountMinor"] is None
        assert result["locations"][0]["sources"][0]["provider"] == "parallel"
        assert result["locations"][0]["sources"][0]["excerpt"] == "Observed search evidence"
        assert len(model_calls) == 2 and model_calls[1]
    assert len(searches) == 1
    assert "Los Angeles County" in searches[0]["objective"]
    assert extractions == [{"urls": [source_url]}]
    assert task["searchEvidence"] == search_evidence
    traces = [event.actions.state_delta["research"] for event in events if event.actions.state_delta.get("research")]
    assert [(trace["operation"], trace["phase"]) for trace in traces] == [
        ("search", "request"), ("search", "complete"), ("extract", "request"), ("extract", "complete" if extract_status == 200 else "failed")]
    assert traces[0]["objective"] == searches[0]["objective"]
    assert traces[1]["requestId"] == "search_test" and traces[1]["retrievedAt"] == 1 and traces[1]["cached"] is False
    assert traces[2]["urls"] == [source_url]
    if extract_status == 200:
        assert task["extractedEvidence"] == extracted_evidence
        assert traces[3]["requestId"] == "extract_test" and traces[3]["retrievedAt"] == 2 and traces[3]["cached"] is False
        assert traces[3]["urls"] == [source_url]
    elif extract_status in {402, 429}:
        assert task["extractedEvidence"]["results"] == []
        assert "using retrieved search excerpts" in task["extractedEvidence"]["errors"][0]
        assert any(e.actions.state_delta.get("activity") == "Page extraction unavailable · reviewing search excerpts" for e in events)
