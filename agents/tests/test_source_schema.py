"""Provider references are bounded choices, isolated per model request."""
from copy import deepcopy
from types import SimpleNamespace

import jsonschema
import pytest
from google.adk.models.llm_request import LlmRequest
from google.genai import types

from sceneatlas.agent import isolate_model_input
from sceneatlas.result_schema import grounded_workflow_schema, workflow_schema


OFFICIAL = "https://film.ca.gov/state-permits/"
VISITOR = "https://example.com/beach"


def location_properties(shape):
    return shape["properties"]["locations"]["items"]["properties"]


def test_only_observed_urls_are_available_and_requirement_sources_are_official():
    shape = grounded_workflow_schema("research", {"results": [{"url": OFFICIAL}, {"url": VISITOR}]})
    location = location_properties(shape)
    reference = location["sources"]["items"]
    jsonschema.validate({"url": VISITOR}, reference)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({"url": "https://example.com/unretrieved-link-from-page"}, reference)
    requirement_reference = location["requirements"]["items"]["properties"]["sources"]["items"]
    jsonschema.validate({"url": OFFICIAL}, requirement_reference)
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({"url": VISITOR}, requirement_reference)


def test_saved_target_sources_are_available_only_for_requirements_refresh():
    previous = {"sources": [{"url": OFFICIAL}], "costs": [{"source": {"url": VISITOR}}], "requirements": []}
    requirements = location_properties(grounded_workflow_schema("requirements", {}, previous))
    assert requirements["sources"]["items"]["properties"]["url"]["enum"] == [OFFICIAL, VISITOR]
    research = location_properties(grounded_workflow_schema("research", {}, previous))
    assert research["sources"]["maxItems"] == 0


def test_missing_evidence_does_not_offer_a_fake_url_or_supported_requirement():
    location = location_properties(grounded_workflow_schema("requirements", {}))
    assert location["sources"]["maxItems"] == 0
    assert "source" not in location["costs"]["items"]["properties"]
    requirement = location["requirements"]["items"]["properties"]
    assert requirement["sources"]["maxItems"] == 0
    assert requirement["status"]["enum"] == ["unresolved"]
    assert "formUrl" not in requirement
    assert requirement["attachments"]["maxItems"] == 0


def test_request_specific_sources_cannot_mutate_shared_specialist_configuration():
    shared = types.GenerateContentConfig(response_json_schema=workflow_schema("research"))
    original = deepcopy(shared.model_dump())
    requests = []
    for url in [OFFICIAL, VISITOR]:
        task = {"run": {"kind": "research", "targetId": "scene"}, "entities": [], "searchEvidence": {"results": [{"url": url}]}}
        request = LlmRequest(config=shared)
        isolate_model_input(SimpleNamespace(state={"task_context": task}), request)
        requests.append(request)
        assert location_properties(request.config.response_json_schema)["sources"]["items"]["properties"]["url"]["enum"] == [url]
    assert shared.model_dump() == original
    assert requests[0].config is not requests[1].config
    assert location_properties(requests[0].config.response_json_schema)["sources"]["items"]["properties"]["url"]["enum"] == [OFFICIAL]
