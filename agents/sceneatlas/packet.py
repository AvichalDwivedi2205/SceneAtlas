"""Deterministic SceneAtlas preparation packet and immutable source manifest."""
from __future__ import annotations

from datetime import datetime, timezone
from html import escape
from io import BytesIO
from typing import Any

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

INK = colors.HexColor("#171a14")
MOSS = colors.HexColor("#48613b")
BRASS = colors.HexColor("#a9781d")
CLAY = colors.HexColor("#a44338")
PALE = colors.HexColor("#f2f1e9")
MUTED = colors.HexColor("#62695d")
LINE = colors.HexColor("#c8ccbf")


def _clean(value: Any) -> str:
    return escape(str(value or "")).replace("\n", "<br/>")


def _money(amount: int | None, currency: str) -> str:
    if amount is None:
        return "Unquoted"
    return f"{currency} {amount / 100:,.2f}"


def build_manifest(task: dict[str, Any]) -> dict[str, Any]:
    entities = task.get("entities", [])
    run = task["run"]
    plan_id = run.get("targetId")
    plan = next((e for e in entities if e.get("_id") == plan_id and e.get("kind") == "plan"), None)
    if not plan:
        raise ValueError("Packet needs a valid plan.")
    choices = [c for c in task.get("choices", []) if c.get("planId") == plan_id]
    by_id = {e["_id"]: e for e in entities}
    selected = []
    unresolved: list[str] = []
    sources: dict[str, dict[str, Any]] = {}
    costs: dict[str, dict[str, Any]] = {}
    requirements: list[dict[str, Any]] = []

    scenes = sorted((e for e in entities if e.get("kind") == "scene"), key=lambda e: e["data"]["number"])
    for scene in scenes:
        choice = next((c for c in choices if c.get("sceneId") == scene["_id"]), None)
        location = by_id.get(choice.get("locationId")) if choice else None
        if not location or location.get("kind") != "location":
            unresolved.append(f"Scene {scene['data']['number']} has no selected location.")
            continue
        selected.append({
            "scene": {"id": scene["_id"], "version": scene["revision"], **scene["data"]},
            "location": {"id": location["_id"], "version": location["revision"], **location["data"]},
            "locked": bool(choice.get("locked")),
        })
        for source in location["data"].get("sources", []):
            sources[source["url"]] = source
        for cost in location["data"].get("costs", []):
            key = cost.get("coverageKey") or f"{location['_id']}:{cost['id']}"
            existing = costs.get(key)
            if existing and (existing.get("amountMinor"), existing.get("currency"), existing.get("basis")) != (cost.get("amountMinor"), cost.get("currency"), cost.get("basis")):
                unresolved.append(f"Conflicting evidence for shared cost: {cost['label']}.")
            else:
                costs[key] = {**cost, "locationId": location["_id"], "locationName": location["data"]["name"]}
            if cost.get("amountMinor") is None:
                unresolved.append(f"Unquoted cost: {cost['label']} at {location['data']['name']}.")
            if cost.get("source"):
                sources[cost["source"]["url"]] = cost["source"]
        for req in location["data"].get("requirements", []):
            requirements.append({**req, "locationId": location["_id"], "locationName": location["data"]["name"]})
            if req.get("status") != "sourced":
                unresolved.append(f"{location['data']['name']}: {req['title']} is {req['status']}.")
            for source in req.get("sources", []):
                sources[source["url"]] = source
        unresolved.append(f"Availability remains unverified: {location['data']['name']}.")

    questions = [
        {"id": e["_id"], "version": e["revision"], **e["data"]}
        for e in entities if e.get("kind") == "question"
    ]
    for question in questions:
        if question.get("resolution") != "answered":
            unresolved.append(f"Open question: {question['prompt']}")
    answers = [{"id": e["_id"], "version": e["revision"], **e["data"]} for e in entities if e.get("kind") == "answer"]
    schedule = next((e for e in entities if e.get("kind") == "schedule" and e["data"].get("planId") == plan_id), None)
    if not schedule:
        unresolved.append("No proposed shooting order exists for this plan.")
    elif schedule.get("stale"):
        unresolved.append("Proposed shooting order is stale.")
    if schedule:
        unresolved.extend(schedule["data"].get("conflicts", []))

    known = sum(c["amountMinor"] * c.get("quantity", 1) for c in costs.values() if c.get("amountMinor") is not None and c.get("basis") in {"published", "quote"})
    estimated = sum(c["amountMinor"] * c.get("quantity", 1) for c in costs.values() if c.get("amountMinor") is not None and c.get("basis") == "estimate")
    versions = [{"id": e["_id"], "kind": e["kind"], "revision": e["revision"], "updatedAt": e["updatedAt"]} for e in entities]
    return {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "documentStatus": "draft",
        "externalStatus": "not_submitted",
        "plan": {"id": plan["_id"], "version": plan["revision"], **plan["data"]},
        "assignments": selected,
        "schedule": {"id": schedule["_id"], "version": schedule["revision"], **schedule["data"]} if schedule else None,
        "costs": {"knownMinor": known, "estimatedMinor": estimated, "currency": plan["data"]["currency"], "items": list(costs.values())},
        "requirements": requirements,
        "answers": answers,
        "questions": questions,
        "sources": list(sources.values()),
        "unresolved": list(dict.fromkeys(unresolved)),
        "recordVersions": versions,
        "disclaimer": "Preparation draft only. No filing, payment, signature, booking, availability, permit, or approval is represented.",
    }


def build_packet(task: dict[str, Any]) -> tuple[bytes, dict[str, Any]]:
    manifest = build_manifest(task)
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, rightMargin=.55*inch, leftMargin=.55*inch, topMargin=.68*inch, bottomMargin=.58*inch, title="SceneAtlas Production Preparation Packet", author="SceneAtlas")
    base = getSampleStyleSheet()
    title = ParagraphStyle("Title", parent=base["Title"], fontName="Helvetica-Bold", fontSize=24, leading=26, textColor=INK, alignment=TA_LEFT, spaceAfter=8)
    h1 = ParagraphStyle("H1", parent=base["Heading1"], fontName="Helvetica-Bold", fontSize=16, leading=19, textColor=INK, spaceBefore=16, spaceAfter=8)
    h2 = ParagraphStyle("H2", parent=base["Heading2"], fontName="Helvetica-Bold", fontSize=11, leading=14, textColor=MOSS, spaceBefore=9, spaceAfter=4)
    body = ParagraphStyle("Body", parent=base["BodyText"], fontName="Helvetica", fontSize=8.7, leading=12, textColor=INK, spaceAfter=5)
    tiny = ParagraphStyle("Tiny", parent=body, fontSize=7.2, leading=9, textColor=MUTED)
    warn = ParagraphStyle("Warn", parent=body, textColor=CLAY, leftIndent=8, borderColor=CLAY, borderWidth=1, borderPadding=7, spaceBefore=5, spaceAfter=5)
    right = ParagraphStyle("Right", parent=tiny, alignment=TA_RIGHT)

    def footer(canvas, document):
        canvas.saveState()
        canvas.setStrokeColor(LINE); canvas.line(.55*inch, .42*inch, 7.95*inch, .42*inch)
        canvas.setFont("Helvetica", 7); canvas.setFillColor(MUTED)
        canvas.drawString(.55*inch, .25*inch, "SceneAtlas · preparation draft · not submitted")
        canvas.drawRightString(7.95*inch, .25*inch, f"Page {document.page}")
        canvas.restoreState()

    story: list[Any] = [
        Paragraph("SCENEATLAS / PRODUCTION PREPARATION", tiny),
        Paragraph(_clean(manifest["plan"]["name"]), title),
        Paragraph(f"Generated {_clean(manifest['generatedAt'])} · Record-backed draft", tiny),
        Spacer(1, 10),
        Paragraph(manifest["disclaimer"], warn),
        Paragraph("Current plan", h1),
    ]
    plan = manifest["plan"]
    plan_rows = [[Paragraph("Priority", tiny), Paragraph(_clean(plan["priority"]), body)], [Paragraph("Budget", tiny), Paragraph("No fixed cap" if plan["budgetMode"] == "uncapped" else _money(plan.get("budgetMinor"), plan["currency"]), body)], [Paragraph("Dates", tiny), Paragraph(_clean(", ".join(plan.get("dates", [])) or "Unconfirmed"), body)], [Paragraph("Ideal shoot", tiny), Paragraph(_clean(plan.get("idealShoot") or "Not specified"), body)]]
    story.append(Table(plan_rows, colWidths=[1.1*inch, 6.15*inch], style=TableStyle([("GRID",(0,0),(-1,-1),.4,LINE),("BACKGROUND",(0,0),(0,-1),PALE),("VALIGN",(0,0),(-1,-1),"TOP"),("LEFTPADDING",(0,0),(-1,-1),7),("RIGHTPADDING",(0,0),(-1,-1),7),("TOPPADDING",(0,0),(-1,-1),6),("BOTTOMPADDING",(0,0),(-1,-1),6)])))
    story.append(Paragraph("Scene assignments", h1))
    if not manifest["assignments"]:
        story.append(Paragraph("No complete scene-to-location assignments.", warn))
    for item in manifest["assignments"]:
        s, loc = item["scene"], item["location"]
        story.append(KeepTogether([Paragraph(f"Scene {s['number']} · {_clean(s['heading'])}", h2), Paragraph(f"<b>{_clean(loc['name'])}</b> · {_clean(loc['address'])}<br/>{_clean(loc['creativeFit'])}", body), Paragraph(f"Choice {'locked' if item['locked'] else 'selected, not locked'} · availability unverified", tiny)]))

    story.append(PageBreak())
    story.append(Paragraph("Proposed shooting order", h1))
    schedule = manifest["schedule"]
    if schedule:
        rows = [[Paragraph("Date / time", tiny), Paragraph("Scene", tiny), Paragraph("Location", tiny), Paragraph("Basis", tiny)]]
        for entry in schedule.get("entries", []):
            time_text = f"{entry['start']//60:02d}:{entry['start']%60:02d}–{entry['end']//60:02d}:{entry['end']%60:02d}"
            rows.append([Paragraph(f"{_clean(entry['date'])}<br/>{time_text}", body), Paragraph(str(entry["sceneNumber"]), body), Paragraph(_clean(entry["locationName"]), body), Paragraph(_clean(entry["durationBasis"]), tiny)])
        story.append(Table(rows, colWidths=[1.35*inch,.55*inch,3.35*inch,2*inch], repeatRows=1, style=TableStyle([("BACKGROUND",(0,0),(-1,0),MOSS),("TEXTCOLOR",(0,0),(-1,0),colors.white),("GRID",(0,0),(-1,-1),.35,LINE),("VALIGN",(0,0),(-1,-1),"TOP"),("LEFTPADDING",(0,0),(-1,-1),6),("RIGHTPADDING",(0,0),(-1,-1),6),("TOPPADDING",(0,0),(-1,-1),5),("BOTTOMPADDING",(0,0),(-1,-1),5)])))
        for conflict in schedule.get("conflicts", []): story.append(Paragraph(_clean(conflict), warn))
    else:
        story.append(Paragraph("No proposed shooting order has been prepared.", warn))

    story.append(Paragraph("Cost picture", h1))
    currency = manifest["costs"]["currency"]
    story.append(Table([[Paragraph("Known / quoted", tiny), Paragraph(_money(manifest["costs"]["knownMinor"], currency), right), Paragraph("Estimated additions", tiny), Paragraph(_money(manifest["costs"]["estimatedMinor"], currency), right)]], colWidths=[1.45*inch,1.45*inch,1.7*inch,1.45*inch], style=TableStyle([("GRID",(0,0),(-1,-1),.4,LINE),("BACKGROUND",(0,0),(-1,-1),PALE),("VALIGN",(0,0),(-1,-1),"MIDDLE"),("TOPPADDING",(0,0),(-1,-1),7),("BOTTOMPADDING",(0,0),(-1,-1),7)])))
    cost_rows = [[Paragraph("Item", tiny), Paragraph("Amount", tiny), Paragraph("Basis / coverage", tiny)]]
    for cost in manifest["costs"]["items"]:
        cost_rows.append([Paragraph(f"{_clean(cost['label'])}<br/><font color='#62695d'>{_clean(cost['locationName'])}</font>", body), Paragraph(_money(cost.get("amountMinor"), cost["currency"]), body), Paragraph(f"{_clean(cost['basis'])} · {_clean(cost['coverageReason'])}", tiny)])
    if len(cost_rows) > 1:
        story.append(Table(cost_rows, colWidths=[2.25*inch,1.2*inch,3.8*inch], repeatRows=1, style=TableStyle([("BACKGROUND",(0,0),(-1,0),BRASS),("TEXTCOLOR",(0,0),(-1,0),colors.white),("GRID",(0,0),(-1,-1),.35,LINE),("VALIGN",(0,0),(-1,-1),"TOP"),("TOPPADDING",(0,0),(-1,-1),5),("BOTTOMPADDING",(0,0),(-1,-1),5)])))

    story.append(PageBreak())
    story.append(Paragraph("Requirements and source links", h1))
    for req in manifest["requirements"]:
        links = " · ".join(f'<link href="{escape(s["url"], quote=True)}" color="#48613b">{_clean(s["title"])}</link>' for s in req.get("sources", [])) or "No official source attached"
        form = f'<br/><link href="{escape(req["formUrl"], quote=True)}" color="#a9781d">Official form or guidance</link>' if req.get("formUrl") else ""
        attachments = ", ".join(req.get("attachments", [])) or "None identified"
        story.append(KeepTogether([Paragraph(f"{_clean(req['locationName'])} · {_clean(req['title'])}", h2), Paragraph(f"Status: <b>{_clean(req['status'])}</b> · Authority: {_clean(req['authority'])}<br/>{_clean(req['detail'])}<br/>Attachments: {_clean(attachments)}<br/>{links}{form}", body)]))
    story.append(Paragraph("Open items", h1))
    if manifest["unresolved"]:
        for item in manifest["unresolved"]: story.append(Paragraph(f"• {_clean(item)}", warn))
    else:
        story.append(Paragraph("No unresolved items recorded. Availability and external approval still remain outside SceneAtlas.", body))
    story.append(Paragraph("Evidence index", h1))
    for index, source in enumerate(manifest["sources"], 1):
        story.append(Paragraph(f'{index}. <link href="{escape(source["url"], quote=True)}" color="#48613b">{_clean(source["title"])}</link><br/>{_clean(source["excerpt"])}<br/>Retrieved: {_clean(source["retrievedAt"])} · Provider: {_clean(source["provider"])}', tiny))
    story.append(Spacer(1, 14))
    story.append(Paragraph(f"Manifest preserves {len(manifest['recordVersions'])} source record versions. Download the accompanying JSON for machine-readable provenance.", tiny))
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return buf.getvalue(), manifest
