from copy import deepcopy
from io import BytesIO

import pytest

from pypdf import PdfReader

from sceneatlas.packet import build_manifest, build_packet


def task_fixture():
    source = {"url": "https://film.ca.gov/state-permits/", "title": "Official permits", "excerpt": "State filming permit guidance.", "retrievedAt": 1, "provider": "official", "cached": False}
    return {
        "run": {"targetId": "plan"},
        "choices": [{"planId": "plan", "sceneId": "scene", "locationId": "location", "locked": True}],
        "entities": [
            {"_id": "plan", "kind": "plan", "revision": 2, "updatedAt": 2, "stale": False, "data": {"kind": "plan", "name": "Budget plan", "budgetMode": "fixed", "budgetMinor": 100_000, "currency": "USD", "priority": "cost", "idealShoot": "One day", "dates": ["2026-10-17"], "timezone": "America/Los_Angeles", "dayStart": 480, "dayEnd": 1080, "setupMinutes": 15, "moveMinutes": 30, "timingBasis": "confirmed"}},
            {"_id": "scene", "kind": "scene", "revision": 1, "updatedAt": 1, "stale": False, "data": {"kind": "scene", "number": 1, "heading": "EXT. BEACH - DAY", "pageStart": 1, "pageEnd": 3, "durationMinutes": 90, "durationBasis": "estimate", "windows": [{"date": "2026-10-17", "start": 480, "end": 1080}]}},
            {"_id": "location", "kind": "location", "revision": 3, "updatedAt": 3, "stale": False, "data": {"kind": "location", "name": "State Beach", "address": "Malibu, CA", "creativeFit": "Open coast", "availability": "unverified", "sceneIds": ["scene"], "sources": [source], "costs": [
                {"id": "app", "label": "Application", "amountMinor": 2500, "currency": "USD", "unit": "application", "quantity": 1, "basis": "published", "coverageKey": "one-app", "coverageReason": "One application", "source": source},
                {"id": "app-copy", "label": "Application", "amountMinor": 2500, "currency": "USD", "unit": "application", "quantity": 1, "basis": "published", "coverageKey": "one-app", "coverageReason": "Same application", "source": source},
                {"id": "site", "label": "Site fee", "amountMinor": None, "currency": "USD", "unit": "day", "quantity": 1, "basis": "unknown", "coverageKey": "site-day", "coverageReason": "Quote needed"},
            ], "requirements": [{"title": "Film permit", "detail": "Prepare permit", "authority": "California Film Commission", "status": "sourced", "sources": [source], "attachments": ["Insurance"], "externalStatus": "unverified"}]}},
            {"_id": "schedule", "kind": "schedule", "revision": 1, "updatedAt": 4, "stale": False, "data": {"kind": "schedule", "planId": "plan", "entries": [{"sceneId": "scene", "sceneNumber": 1, "locationId": "location", "locationName": "State Beach", "date": "2026-10-17", "start": 540, "end": 630, "durationBasis": "estimate", "reason": "Morning"}], "conflicts": [], "provisional": True, "moves": 0, "days": 1, "explanation": "Proposed"}},
        ],
    }


def test_manifest_deduplicates_shared_costs_and_keeps_unknowns():
    manifest = build_manifest(task_fixture())
    assert manifest["costs"]["knownMinor"] == 2500
    assert len(manifest["costs"]["items"]) == 2
    assert any("Unquoted cost" in item for item in manifest["unresolved"])
    assert any("Availability remains unverified" in item for item in manifest["unresolved"])
    assert manifest["externalStatus"] == "not_submitted"


def test_same_url_fee_and_requirement_passages_survive_manifest_and_pdf_once():
    task = task_fixture()
    location = task["entities"][2]["data"]
    requirement_source = {**location["sources"][0], "provider": "parallel", "searchId": "search_permit_passage",
        "excerpt": "Commercial filming requires a park film permit.", "retrievedAt": 1788917318814}
    fee_source = {**requirement_source, "searchId": "search_fee_passage", "retrievedAt": 1788917320766,
        "excerpt": "Vehicle Day Use: $12.00. Prices are subject to change."}
    location["sources"] = [deepcopy(requirement_source)]
    for cost in location["costs"][:2]:
        cost.update(label="Vehicle Day Use", amountMinor=1200, unit="day", coverageKey="vehicle-day", coverageReason="One passenger car")
    location["costs"][0]["source"] = fee_source
    location["costs"][1]["source"] = dict(reversed(list(fee_source.items())))
    location["requirements"][0]["sources"] = [requirement_source, deepcopy(requirement_source)]

    content, manifest = build_packet(task)

    assert manifest["sources"] == [requirement_source, fee_source]
    text = "\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(content)).pages)
    evidence = " ".join(text.split("Evidence index", 1)[1].split())
    for source in (requirement_source, fee_source):
        assert evidence.count(source["excerpt"]) == 1
        assert evidence.count(source["searchId"]) == 1
    assert "01:28:38.814 UTC" in evidence
    assert "01:28:40.766 UTC" in evidence


@pytest.mark.parametrize("field,value", [("retrievedAt", 2), ("searchId", "search_second"), ("cached", True)])
def test_same_passage_with_distinct_retrieval_provenance_is_not_deduplicated(field, value):
    task = task_fixture()
    location = task["entities"][2]["data"]
    original = {**location["sources"][0], "searchId": "search_first"}
    variant = {**original, field: value}
    location["sources"] = [original, deepcopy(original)]
    for cost in location["costs"][:2]:
        cost["source"] = variant
    location["requirements"][0]["sources"] = [deepcopy(original)]

    assert build_manifest(task)["sources"] == [original, variant]


def test_packet_is_readable_and_marks_draft():
    task = task_fixture()
    for cost in task["entities"][2]["data"]["costs"][:2]:
        cost["quantity"] = 6
    task["entities"].append({"_id": "crew", "kind": "question", "revision": 1, "updatedAt": 1, "data": {"kind": "question", "prompt": "Confirmed crew and equipment", "answer": "Four people, handheld camera, no drones.", "resolution": "answered"}})
    content, manifest = build_packet(task)
    assert content.startswith(b"%PDF-")
    reader = PdfReader(BytesIO(content))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    assert len(reader.pages) >= 3
    assert "Budget plan" in text
    assert "preparation draft" in text.lower()
    assert "not submitted" in text.lower()
    assert "Four people, handheld camera, no drones." in text
    assert "USD 150.00" in text
    assert "Rate" in text and "quantity" in text
    assert manifest["schemaVersion"] == 1


def test_packet_totals_keep_quantity_conflicts_and_other_currencies_visible():
    task = task_fixture()
    costs = task["entities"][2]["data"]["costs"]
    costs[0]["quantity"] = 6
    costs.append({**costs[0], "id": "foreign", "coverageKey": "foreign", "currency": "CAD"})
    manifest = build_manifest(task)
    assert manifest["costs"]["knownMinor"] == 15000
    assert any("Conflicting evidence for shared cost" in item for item in manifest["unresolved"])
    assert any("Currency conversion required" in item for item in manifest["unresolved"])


def add_excluded_scene(task):
    scene = deepcopy(task["entities"][1])
    scene["_id"] = "excluded"
    scene["data"].update(number=202, heading="INT. EXCLUDED LOCATION - NIGHT", durationMinutes=None, windows=[])
    location = deepcopy(task["entities"][2])
    location["_id"] = "excluded-location"
    location["data"].update(name="Excluded location", sceneIds=["excluded"])
    for cost in location["data"]["costs"]:
        cost["coverageKey"] = "excluded-" + cost["coverageKey"]
    task["entities"].extend([scene, location, {
        "_id": "excluded-question", "kind": "question", "revision": 1, "updatedAt": 1,
        "scope": {"kind": "scene", "sceneId": "excluded"},
        "data": {"kind": "question", "prompt": "Excluded casting decision", "resolution": "open", "blocks": ["packet"]},
    }])
    task["choices"].append({"planId": "plan", "sceneId": "excluded", "locationId": "excluded-location", "locked": True})


def test_selected_packet_omits_excluded_choices_costs_questions_and_versions():
    task = task_fixture()
    task["entities"][0]["data"]["sceneScope"] = {"mode": "selected", "sceneIds": ["scene"]}
    before = build_manifest(task)
    add_excluded_scene(task)
    content, manifest = build_packet(task)
    assert manifest["sourceVersion"] == before["sourceVersion"]
    assert manifest["scope"]["includedSceneIds"] == ["scene"]
    assert [item["scene"]["id"] for item in manifest["assignments"]] == ["scene"]
    assert [item["sceneId"] for item in manifest["schedule"]["entries"]] == ["scene"]
    assert manifest["costs"]["knownMinor"] == 2500
    assert all(not item["id"].startswith("excluded") for item in manifest["recordVersions"])
    text = "\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(content)).pages)
    assert "Selected scenes" in text and "1 included" in text
    assert "Excluded" not in text and "202" not in text.replace("2026", "")


def test_explicit_empty_scope_stays_empty_and_cannot_export():
    task = task_fixture()
    task["entities"][0]["data"]["sceneScope"] = {"mode": "selected", "sceneIds": []}
    manifest = build_manifest(task)
    assert manifest["scenes"] == []
    assert manifest["assignments"] == []
    assert manifest["costs"]["items"] == []
    assert manifest["schedule"]["entries"] == []
    with pytest.raises(ValueError, match="Choose scenes"):
        build_packet(task)


def test_missing_scope_keeps_legacy_all_scene_behavior():
    task = task_fixture()
    add_excluded_scene(task)
    manifest = build_manifest(task)
    assert manifest["scope"]["mode"] == "all"
    assert manifest["scope"]["includedSceneCount"] == 2
    assert manifest["costs"]["knownMinor"] == 5000
    assert any("Excluded casting" in item for item in manifest["productionInputsNeeded"])


@pytest.mark.parametrize("scene_ids", [["scene", "scene"], ["missing"]])
def test_invalid_membership_is_rejected(scene_ids):
    task = task_fixture()
    task["entities"][0]["data"]["sceneScope"] = {"mode": "selected", "sceneIds": scene_ids}
    with pytest.raises(ValueError, match="duplicate or unavailable"):
        build_manifest(task)


def test_revised_pdf_records_new_start_and_saved_production_inputs():
    task = task_fixture()
    before = build_manifest(task)
    task["entities"][0]["data"]["dayStart"] = 540
    task["entities"][0]["revision"] += 1
    task["entities"][3]["data"]["entries"][0].update(start=555, end=645)
    task["entities"][3]["revision"] += 1
    content, manifest = build_packet(task)
    text = "\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(content)).pages)
    assert "09:00" in text and "09:15" in text
    assert "Setup: 15 min" in text
    assert "Pages 1-3" in text
    assert "Choice locked" in text
    assert manifest["sourceVersion"] != before["sourceVersion"]
    assert manifest["sourcePlanRevision"] == 3
    assert manifest["sourceScheduleRevision"] == 2


@pytest.mark.parametrize("missing", ["schedule", "timing", "decision", "location"])
def test_required_production_inputs_cannot_be_bypassed(missing):
    task = task_fixture()
    if missing == "schedule":
        task["entities"][3]["stale"] = True
    elif missing == "timing":
        task["entities"][0]["data"]["setupMinutes"] = None
    elif missing == "location":
        task["choices"] = []
    else:
        task["entities"].append({"_id": "question", "kind": "question", "revision": 1, "updatedAt": 1,
            "scope": {"kind": "plan", "planId": "plan"},
            "data": {"kind": "question", "prompt": "Confirm production facts", "resolution": "open", "blocks": ["packet"]}})
    with pytest.raises(ValueError, match="Packet needs production inputs"):
        build_packet(task)


def test_shared_location_facts_and_requirements_are_retained_once():
    task = task_fixture()
    scene = deepcopy(task["entities"][1])
    scene["_id"] = "second"
    scene["data"]["number"] = 2
    task["entities"].append(scene)
    task["entities"][2]["data"]["sceneIds"].append("second")
    task["choices"].append({"planId": "plan", "sceneId": "second", "locationId": "location", "locked": True})
    task["entities"][3]["data"]["entries"].append({**task["entities"][3]["data"]["entries"][0], "sceneId": "second", "sceneNumber": 2, "start": 630, "end": 720})
    task["entities"].append({"_id": "location-question", "ownerId": "location", "kind": "question", "revision": 1, "updatedAt": 1,
        "scope": {"kind": "scene", "sceneId": "excluded"}, "data": {"kind": "question", "prompt": "Selected location equipment", "resolution": "answered", "answer": "Handheld only"}})
    manifest = build_manifest(task)
    assert len(manifest["assignments"]) == 2
    assert len(manifest["requirements"]) == 1
    assert len(manifest["questions"]) == 1
    assert manifest["costs"]["knownMinor"] == 2500


def test_absent_fee_evidence_stays_explicitly_unquoted():
    task = task_fixture()
    task["entities"][2]["data"]["costs"] = []
    _, manifest = build_packet(task)
    assert manifest["costs"]["knownMinor"] == 0
    assert len(manifest["costs"]["items"]) == 1
    assert manifest["costs"]["items"][0]["amountMinor"] is None
    assert manifest["externalFollowups"]


def test_schedule_for_a_different_location_cannot_be_exported():
    task = task_fixture()
    task["entities"][3]["data"]["entries"][0]["locationId"] = "not-selected"
    with pytest.raises(ValueError, match="does not match the selected locations"):
        build_packet(task)
