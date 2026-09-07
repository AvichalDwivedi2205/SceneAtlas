import json
import io
from types import SimpleNamespace

import pytest
from google.adk.agents import LlmAgent
from google.adk.events import Event
from google.genai import types

from sceneatlas.agent import SceneAtlasAgent, validate_draft
from sceneatlas.screenplay import (
    BATCH_CHARACTERS, BATCH_SEGMENTS, SEGMENT_CHARACTERS,
    assemble_scenes, batch_key, index_scenes, scene_batches, selected_scenes,
    validate_enrichment, extract_pages,
)


def test_dense_100_page_pdf_exceeds_old_text_limit_without_losing_final_page():
    from reportlab.pdfgen import canvas
    output = io.BytesIO()
    pdf = canvas.Canvas(output)
    for page in range(1, 101):
        pdf.setFont("Courier", 9)
        pdf.drawString(55, 790, f"INT. ARCHIVE {page} - DAY")
        for line in range(45):
            pdf.drawString(55, 770 - line * 15, f"PAGE {page} LINE {line}: Mara compares a paper map with the brass marker on the table.")
        pdf.showPage()
    pdf.save()
    pages = extract_pages(output.getvalue(), "application/pdf")
    assert len(pages) == 100
    assert sum(len(p["text"]) for p in pages) > 250_000
    assert "PAGE 100 LINE 44" in pages[-1]["text"]
    scenes = index_scenes(pages)
    assert len(scenes) == 100 and scenes[-1].page_end == 100


def enrichment(batch):
    return {"segments": [{"number": s["number"], "part": s["part"], "setting": "Archive",
                          "interiorExterior": "INT", "timeOfDay": "DAY", "needs": ["Paper maps"]} for s in batch]}


def test_numbered_slugs_continuations_and_exact_page_seams():
    pages = [
        {"page": 1, "text": "TITLE PAGE"},
        {"page": 2, "text": "1 A RIVER.                 1\nWater covers a brass marker.\n2 INT. ARCHIVE - DAY       2\nMara opens a map."},
        {"page": 3, "text": "2 INT. ARCHIVE - DAY (CONT'D) 2\nShe finds a second mark.\n3 OMITTED                 3\n4 EXT. BRIDGE - NIGHT      4\nThe marker is gone."},
        {"page": 4, "text": "Mara studies the final footprint.\nFADE OUT."},
    ]
    scenes = index_scenes(pages)
    assert len(scenes) == 3
    assert [(s.page_start, s.page_end) for s in scenes] == [(2, 2), (2, 3), (3, 4)]
    assert "final footprint" in scenes[-1].text
    result = assemble_scenes(scenes, [enrichment(b) for b in scene_batches(scenes)])
    validate_draft(result, pages)
    assert all(s["durationMinutes"] is None and s["durationBasis"] == "unknown" for s in result["scenes"])


def test_long_scenes_are_fully_partitioned_without_sampling_or_duplicate_parts():
    pages = [{"page": p, "text": ("INT. ARCHIVE - DAY\n" if p == 1 else "") + f"Clue on page {p}. " * 180} for p in range(1, 101)]
    scene = index_scenes(pages)[0]
    batches = scene_batches([scene])
    segments = [segment for batch in batches for segment in batch]
    assert len(segments) > 10
    assert "".join(s["text"] for s in segments) == scene.text
    assert scene.page_end == 100
    for batch in batches:
        assert len(batch) <= BATCH_SEGMENTS
        assert sum(len(s["text"]) for s in batch) <= BATCH_CHARACTERS
        assert all(len(s["text"]) <= SEGMENT_CHARACTERS for s in batch)


def test_missing_duplicate_or_fabricated_segment_cannot_be_saved():
    scenes = index_scenes([{"page": 1, "text": "INT. ROOM - DAY\nMara walks.\nEXT. BRIDGE - NIGHT\nIvo waits."}])
    batch = scene_batches(scenes)[0]
    result = enrichment(batch)
    validate_enrichment(result, batch)
    for invalid in [result["segments"][:1], [result["segments"][0]] * 2, [{**s, "number": 99} for s in result["segments"]]]:
        with pytest.raises(ValueError, match="incomplete or duplicated"):
            validate_enrichment({"segments": invalid}, batch)


def test_selection_is_explicit_and_cache_tracks_every_part_and_confirmed_input():
    scenes = index_scenes([{"page": 1, "text": "\n".join(f"EXT. LOCATION {i} - DAY\nAction {i}." for i in range(10))}])
    assert len(selected_scenes(scenes, "Entire screenplay")) == 10
    assert [s.number for s in selected_scenes(scenes, "Scenes 1, 3-5")] == [1, 3, 4, 5]
    for invalid in ["Selected scenes", "Scenes 0, 3", "Scenes 5-3", "Scenes 1-99", "maybe first few"]:
        assert selected_scenes(scenes, invalid) is None
    batch = scene_batches(scenes)[0]
    key = batch_key(batch, [], "model")
    assert len({key, batch_key(batch, [{"answer": "different"}], "model"), batch_key(batch, [], "new-model"), batch_key(batch[:-1], [], "model")}) == 4


@pytest.mark.asyncio
async def test_interrupted_breakdown_resumes_saved_batches_and_publishes_only_when_complete(monkeypatch):
    pages = [{"page": p, "text": f"INT. ARCHIVE {p} - DAY\nMara finds map {p}."} for p in range(1, 19)]
    task = {"run": {"kind": "scenes", "targetId": "script"}, "entities": [{"kind": "question", "data": {
        "key": "scene_scope", "answer": "Entire screenplay", "resolution": "answered", "blocks": ["scenes"]}}]}
    saved, calls = {}, []
    fail = True

    class Backend:
        async def post(self, operation, data):
            if operation == "sceneBatch":
                return saved.get(data["key"])
            saved[data["key"]] = data["result"]
            return {"saved": True}

    async def model(self, ctx):
        batch = ctx.session.state["task_context"]["sceneSegments"]
        calls.append(batch[0]["number"])
        if fail and len(calls) == 2:
            raise RuntimeError("Temporary provider interruption")
        yield Event(invocation_id=ctx.invocation_id, author=self.name, content=types.Content(role="model", parts=[types.Part(text=json.dumps(enrichment(batch)))]))

    monkeypatch.setattr(LlmAgent, "run_async", model)
    agent = SceneAtlasAgent()
    ctx = SimpleNamespace(invocation_id="test", session=SimpleNamespace(state={}))
    emitted = []
    with pytest.raises(RuntimeError, match="interruption"):
        async for event in agent._screenplay(ctx, Backend(), task, pages):
            emitted.append(event)
    assert len(saved) == 1
    assert not any("sceneatlasResult" in (p.text or "") for event in emitted for p in (event.content.parts if event.content else []))
    fail = False
    events = [event async for event in agent._screenplay(ctx, Backend(), task, pages)]
    result = json.loads(events[-1].content.parts[0].text)["sceneatlasResult"]
    assert calls == [1, 7, 7, 13]
    assert len(saved) == 3
    assert [s["number"] for s in result["scenes"]] == list(range(1, 19))
    assert any("Resumed saved batch 1 / 3" in e.actions.state_delta.get("activity", "") for e in events)
    validate_draft(result, pages)
