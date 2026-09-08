"""Authority evidence gaps cannot become an endless producer-question loop."""
import copy
import json
from types import SimpleNamespace

import pytest
from google.adk.events import Event
from google.genai import types

from sceneatlas import agent


@pytest.mark.parametrize("prompt", [
    "How many people will be on set?",
    "Will you use a generator or any fire effects?",
    "What is your budget for permit fees?",
    "Do you have an actual quoted location fee to attach?",
    "Would you accept a monitor contingency estimate?",
])
def test_producer_owned_inputs_remain_questions(prompt):
    question = agent.intake_question("production_input", prompt, "Producer decision", ["requirements"])
    result = {"questions": [question]}
    before = copy.deepcopy(result)
    agent.validate_requirements_questions(result)
    assert result == before


@pytest.mark.asyncio
@pytest.mark.parametrize("always_invalid", [False, True])
@pytest.mark.parametrize("key,prompt", [
    ("park_district_review_fee", "What is the specific review fee for commercial filming at this park?"),
    ("park_activity_level", "Is filming at this park considered 'simple' or 'complex'?"),
])
async def test_authority_question_is_repaired_before_publication(monkeypatch, key, prompt, always_invalid):
    location = {
        "kind": "location", "name": "Fixture beach", "address": "", "description": "Fixture",
        "creativeFit": "Open sand", "restrictions": [], "availability": "unverified", "authority": "Park authority",
        "sources": [{"url": "https://film.ca.gov/state-permits/"}], "requirements": [], "sceneIds": ["scene"], "rejected": False,
        "costs": [{"id": "fee", "label": "Review fee", "amountMinor": None, "currency": "USD", "unit": "application",
                   "quantity": 1, "basis": "unknown", "coverageKey": "fee", "coverageReason": "Quote required", "assumptions": ""}],
    }
    task = {"run": {"_id": "run", "kind": "requirements", "targetId": "location"}, "entities": [
        {"_id": "location", "kind": "location", "data": location},
        {"kind": "question", "data": {"key": "production_activities", "resolution": "answered", "answer": "Four people, handheld camera, no effects."}},
    ]}
    retrievals, model_calls = [], []

    class Backend:
        def __init__(self, *_): pass
        async def post(self, operation):
            assert operation == "context"
            return task

    async def tool(self, *, args, tool_context):
        retrievals.append(self.name)
        if self.name == "search_sources":
            return {"provider": "parallel", "searchId": "search_fixture", "retrievedAt": 1, "results": [
                {"url": "https://film.ca.gov/state-permits/", "title": "Official guidance", "excerpt": "Confirm applicable location requirements."},
            ]}
        assert self.name == "parallel_extract"
        return {"requestedUrls": [], "results": [], "errors": []}

    async def model(self, ctx):
        model_calls.append(ctx.session.state["task_context"].get("validationFeedback"))
        result = {"locations": [copy.deepcopy(location)], "questions": [], "message": "Preparation draft; authority confirmation required."}
        if always_invalid or len(model_calls) == 1:
            result["questions"] = [agent.intake_question(key, prompt, "Not stated in the available official evidence", ["requirements"])]
        else:
            result["locations"][0]["requirements"] = [{
                "title": "Authority confirmation required", "detail": "Applicable classification and review fee remain unverified.",
                "authority": "Park authority", "status": "unresolved", "sources": [], "attachments": [],
                "applicableFacts": ["Four people; handheld camera; no effects"], "externalStatus": "unverified",
            }]
            # A separate real production decision is still published and left open.
            result["questions"] = [agent.intake_question("vehicles", "How many production vehicles will you bring?", "Parking quantity is not confirmed", ["requirements"])]
        yield Event(invocation_id=ctx.invocation_id, author=self.name,
                    content=types.Content(role="model", parts=[types.Part(text=json.dumps(result))]))

    monkeypatch.setattr(agent, "Backend", Backend)
    monkeypatch.setattr(agent, "ToolContext", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(agent.FunctionTool, "run_async", tool)
    monkeypatch.setattr(agent.LlmAgent, "run_async", model)
    ctx = SimpleNamespace(invocation_id="requirements-repair", session=SimpleNamespace(state={}),
                          user_content=types.Content(parts=[types.Part(text='{"runId":"run","attempt":1}')]))
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
        assert len(model_calls) == 2 and "external authority fact" in model_calls[1]["problem"]
        assert [q["data"]["key"] for q in result["questions"]] == ["vehicles"]
        assert result["questions"][0]["data"]["answer"] is None
        assert result["questions"][0]["data"]["resolution"] == "open"
        saved = result["locations"][0]
        assert saved["availability"] == "unverified"
        assert saved["costs"][0]["amountMinor"] is None
        assert saved["requirements"][0]["status"] == "unresolved"
        assert saved["requirements"][0]["externalStatus"] == "unverified"
    assert retrievals == ["search_sources", "parallel_extract"]
