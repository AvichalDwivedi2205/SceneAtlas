from io import BytesIO

from pypdf import PdfReader

from sceneatlas.packet import build_manifest, build_packet


def task_fixture():
    source = {"url": "https://film.ca.gov/state-permits/", "title": "Official permits", "excerpt": "State filming permit guidance.", "retrievedAt": 1, "provider": "official", "cached": False}
    return {
        "run": {"targetId": "plan"},
        "choices": [{"planId": "plan", "sceneId": "scene", "locationId": "location", "locked": True}],
        "entities": [
            {"_id": "plan", "kind": "plan", "revision": 2, "updatedAt": 2, "stale": False, "data": {"kind": "plan", "name": "Budget plan", "budgetMode": "fixed", "budgetMinor": 100_000, "currency": "USD", "priority": "cost", "idealShoot": "One day", "dates": ["2026-10-17"]}},
            {"_id": "scene", "kind": "scene", "revision": 1, "updatedAt": 1, "stale": False, "data": {"kind": "scene", "number": 1, "heading": "EXT. BEACH — DAY"}},
            {"_id": "location", "kind": "location", "revision": 3, "updatedAt": 3, "stale": False, "data": {"kind": "location", "name": "State Beach", "address": "Malibu, CA", "creativeFit": "Open coast", "availability": "unverified", "sources": [source], "costs": [
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
