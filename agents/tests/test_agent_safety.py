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


def test_extracted_context_is_bounded_recursively():
    bounded = bound_context({"nested": {"content": "x" * 20_000}, "many": list(range(150))})
    assert len(bounded["nested"]["content"]) == 12_000
    assert len(bounded["many"]) == 100
