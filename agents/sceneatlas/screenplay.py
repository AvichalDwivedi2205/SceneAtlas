"""Page-aware screenplay indexing and bounded, retryable scene enrichment.

The parser owns source identity. Models enrich bounded segments; they never
decide how many scenes were present, renumber them, or supply source excerpts.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
from dataclasses import dataclass, field

from pypdf import PdfReader

MAX_PAGES = 300
MAX_CHARACTERS = 1_200_000
MAX_SCENES = 300
SEGMENT_CHARACTERS = 10_000
BATCH_CHARACTERS = 24_000
BATCH_SEGMENTS = 6
PIPELINE_VERSION = "screenplay-v1"

# Shooting scripts may have scene numbers at either end and revision marks.
HEADING = re.compile(r"^(?:\d+[A-Z]?\s+)?(?:INT\.?\s*[/.-]\s*EXT\.?|EXT\.?\s*[/.-]\s*INT\.?|I/E\.?|INT\.|EXT\.)\s+\S", re.I)
CONTINUED = re.compile(r"\(?CONT(?:['’]D|INUED|D)[.:]?\)?", re.I)
NUMBERED_HEADING = re.compile(r"^(\d+[A-Z]?)\s+(.+?)\s+\1\s*\*?$")


def extract_pages(content: bytes, mime: str) -> list[dict]:
    if len(content) > 50 * 1024 * 1024:
        raise ValueError("Screenplay exceeds 50 MB.")
    if mime == "text/plain":
        pages = [{"page": 1, "text": content.decode("utf-8").strip()}]
    else:
        if not content.startswith(b"%PDF-"):
            raise ValueError("This file is not a readable PDF. Retry with a text-based PDF or paste text.")
        reader = PdfReader(io.BytesIO(content))
        if reader.is_encrypted:
            raise ValueError("Password-protected PDF. Upload an unlocked copy or paste the screenplay.")
        if len(reader.pages) > MAX_PAGES:
            raise ValueError(f"This release supports screenplays up to {MAX_PAGES} pages.")
        pages = []
        for index, page in enumerate(reader.pages):
            # Layout order preserves numbered slugs even when the PDF stores the
            # left/right scene numbers after the heading in its content stream.
            text = "\n".join(line.rstrip() for line in (page.extract_text(extraction_mode="layout") or "").splitlines())
            if not text.strip() and list(page.images):
                raise ValueError(f"Page {index + 1} has an image but no readable text. Export a PDF with selectable text or apply OCR before uploading.")
            pages.append({"page": index + 1, "text": text})
    characters = sum(len(p["text"]) for p in pages)
    if characters < 50:
        raise ValueError("No readable screenplay text found. Scanned PDFs need text extraction first; paste text to continue.")
    if characters > MAX_CHARACTERS:
        raise ValueError(f"Screenplay exceeds {MAX_CHARACTERS:,} extracted characters. Split this unusually dense document into separate workspaces.")
    return pages


@dataclass
class SceneSpan:
    number: int
    heading: str
    page_start: int
    page_end: int
    lines: list[tuple[int, str]] = field(default_factory=list)

    @property
    def text(self) -> str:
        # A new page's number/continued marker can arrive before its next slug.
        # It does not extend the previous scene's source span.
        return "\n".join(line for page, line in self.lines
                         if self.page_start <= page <= self.page_end)

    def segments(self) -> list[dict]:
        # Split even an unusually long scene. Every character belongs to one part.
        text = self.text
        return [{"number": self.number, "part": part + 1, "heading": self.heading,
                 "pageStart": self.page_start, "pageEnd": self.page_end,
                 "text": text[start:start + SEGMENT_CHARACTERS]}
                for part, start in enumerate(range(0, len(text), SEGMENT_CHARACTERS))]


def index_scenes(pages: list[dict]) -> list[SceneSpan]:
    scenes: list[SceneSpan] = []
    current = None
    for page in pages:
        for line in page["text"].splitlines():
            stripped = line.strip()
            numbered = NUMBERED_HEADING.match(stripped)
            numbered_slug = numbered and numbered[2] == numbered[2].upper()
            if numbered_slug and numbered[2].startswith("OMITTED"):
                continue
            if HEADING.match(stripped) or numbered_slug:
                # A repeated continued slug at a page break belongs to the same scene.
                normalized = lambda s: re.sub(r"\W+", "", CONTINUED.sub("", s)).lower()
                continued = current and CONTINUED.search(stripped) and normalized(stripped) == normalized(current.heading)
                if not continued:
                    current = SceneSpan(len(scenes) + 1, stripped, page["page"], page["page"])
                    scenes.append(current)
            if current is not None:
                current.lines.append((page["page"], line))
                if stripped and not re.fullmatch(r"\d+\.?|\(?CONTINUED:?\)?", stripped, re.I):
                    current.page_end = page["page"]
    if not scenes:
        raise ValueError("No screenplay scene headings found. Use a text-based screenplay with INT. / EXT. scene headings; books need adaptation first.")
    if len(scenes) > MAX_SCENES:
        raise ValueError(f"This screenplay contains more than {MAX_SCENES} scenes. Split it into separate workspaces.")
    return scenes


def selected_scenes(scenes: list[SceneSpan], answer: str) -> list[SceneSpan] | None:
    normalized = answer.strip().lower().rstrip(".")
    if normalized in {"entire screenplay", "all scenes", "whole screenplay", "entire script", "all", "full screenplay"}:
        return scenes
    selection = re.sub(r"^(?:selected\s+)?scenes?\s*:?\s*", "", normalized)
    if not re.fullmatch(r"\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*", selection):
        return None
    numbers = set()
    for item in selection.split(","):
        bounds = [int(n.strip()) for n in item.split("-")]
        start, end = bounds[0], bounds[-1]
        if start < 1 or end < start or end > len(scenes):
            return None
        numbers.update(range(start, end + 1))
    return [s for s in scenes if s.number in numbers]


def scene_batches(scenes: list[SceneSpan]) -> list[list[dict]]:
    batches, batch, characters = [], [], 0
    for scene in scenes:
        for segment in scene.segments():
            size = len(segment["text"])
            if batch and (len(batch) >= BATCH_SEGMENTS or characters + size > BATCH_CHARACTERS):
                batches.append(batch)
                batch, characters = [], 0
            batch.append(segment)
            characters += size
    if batch:
        batches.append(batch)
    return batches


def batch_key(batch: list[dict], answers: list[dict], model: str) -> str:
    data = json.dumps([PIPELINE_VERSION, model, batch, answers], sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(data.encode()).hexdigest()


def validate_enrichment(result: dict, batch: list[dict]) -> None:
    from .result_schema import breakdown_schema
    import jsonschema
    jsonschema.validate(result, breakdown_schema())
    expected = {(s["number"], s["part"]) for s in batch}
    actual = [(s["number"], s["part"]) for s in result["segments"]]
    if len(actual) != len(expected) or set(actual) != expected:
        raise ValueError("Scene batch was incomplete or duplicated a source segment. Retry resumes previously saved batches.")


def assemble_scenes(scenes: list[SceneSpan], batches: list[dict]) -> dict:
    parts = {(s["number"], s["part"]): s for batch in batches for s in batch["segments"]}
    results = []
    for scene in scenes:
        enriched = [parts[(scene.number, part["part"])] for part in scene.segments()]
        needs = list(dict.fromkeys(need for part in enriched for need in part["needs"]))
        first = enriched[0]
        results.append({"kind": "scene", "number": scene.number, "heading": scene.heading,
                        "pageStart": scene.page_start, "pageEnd": scene.page_end,
                        "excerpt": scene.text[:1600], "setting": first["setting"],
                        "interiorExterior": first["interiorExterior"], "timeOfDay": first["timeOfDay"],
                        "needs": needs, "durationMinutes": None, "durationBasis": "unknown",
                        "candidateCount": 3, "ranking": "creative", "windows": []})
    return {"scenes": results, "questions": [],
            "message": f"Verified {len(results)} scenes from the selected screenplay scope. Source headings, page spans, and excerpts are preserved; shooting durations and production choices still need confirmation."}
