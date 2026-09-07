#!/usr/bin/env python3
"""Assemble real recorded SceneAtlas shots into a silent hackathon master."""

import argparse
import json
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


def run(args):
    subprocess.run([str(value) for value in args], check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("evidence", type=Path)
    parser.add_argument("--output", type=Path, default=Path("artifacts/demo-video"))
    args = parser.parse_args()
    evidence = json.loads(args.evidence.read_text())
    if evidence.get("status") != "passed" or not evidence.get("recording"):
        raise ValueError("A completed real recording is required")
    root = args.output.resolve()
    chapters = root / "chapters"
    assets = root / "edit-assets"
    chapters.mkdir(parents=True, exist_ok=True)
    assets.mkdir(parents=True, exist_ok=True)
    font = "/System/Library/Fonts/Supplemental/Arial.ttf"
    bold = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
    sources = {item["page"]: item["path"] for item in evidence["videos"]}
    segments = {item["id"]: item for item in evidence["segments"]}
    scale = evidence["scale"]
    breakdown = next(r for r in evidence["runs"] if r["boardId"] == scale["boardId"] and r["kind"] == "scenes")
    elapsed = round(breakdown["elapsedSeconds"])
    elapsed_label = f"Breakdown: about {elapsed // 60}m {elapsed % 60:02d}s | waiting time cut"
    sequence = [
        ("scale-wide", 8, "FULL-SCRIPT SCALE", f"{scale['pages']} pages. {scale['scenes']} connected scene cards.", "A full screenplay becomes one connected production workspace."),
        ("scale-upload", 8, "START WITH THE SCREENPLAY", "Recorded full PDF upload", "Upload the entire screenplay to a private board."),
        ("scale-confirm-scope", 10, "PRODUCER STAYS IN CONTROL", "Choose the entire screenplay", "The agent asks which scenes to break down. Your answer stays attached."),
        ("scale-breakdown-start", 6, "VISIBLE WORK IN PROGRESS", "Real cloud processing | waiting time cut", "The board shows the work happening in the background."),
        ("scale-count", 7, "COMPLETE BREAKDOWN", elapsed_label, "All pages were read and every scene was checked against the source inventory."),
        ("scale-last-scene", 5, "FIND ANY SCENE", "Jump directly to the final scene", "Use the scene index to reach the end of the script."),
        ("producer-input", 12, "FOCUSED PLANNING EXAMPLE", "Coastal Rehearsal | original one-scene production", "Now follow one original coastal scene through planning. Confirm the crew and equipment before research."),
        ("research-start", 8, "RESEARCH REAL LOCATIONS", "Live search | waiting time cut", "SceneAtlas researches locations against the scene and confirmed production needs."),
        ("location-result", 7, "A LOCATION WITH EVIDENCE", "Creative fit, costs, and access questions", "The result explains why a real location fits the scene."),
        ("location-evidence", 10, "CHECK THE SOURCE", "Evidence and provider provenance stay visible", "Open its source evidence. Unknown availability and costs remain explicit."),
        ("location-lock", 10, "MAKE A PRODUCTION DECISION", "Select a location and lock the choice", "Choose the location for this plan and lock it while the rest of the plan evolves."),
        ("schedule-before", 8, "BUILD THE SHOOTING PLAN", "Producer-approved timing estimates | provisional schedule", "The chosen location feeds a proposed shooting order."),
        ("revision-input", 16, "ONE CHANGE, CLEAR CONSEQUENCES", "Move the production start to 09:00", "The cast needs a later start. Change the day's start time and review affected outputs."),
        ("revision-regenerate", 6, "REFRESH AFFECTED WORK", "Regenerate the dependent schedule", "Regenerate the schedule using the new confirmed input."),
        ("revision-apply", 9, "REVIEW AND APPLY", "Later schedule, same locked location and saved answers", "Apply the revised result. The schedule moves later; setup time, the locked location, and earlier answers stay intact."),
        ("collaboration", 12, "WORK TOGETHER", "Two authenticated people on the same board", "A second teammate adds a production update. It reaches the shared board without a reload."),
        ("packet-start", 5, "PREPARE THE HANDOFF", "Current plan to preparation packet | waiting time cut", "Prepare the handoff from the current plan."),
        ("packet-download", 12, "DOWNLOAD THE RESULT", "Preparation draft | sources and unresolved items included", "Download the preparation PDF with sources, decisions, and unresolved questions."),
    ]
    outputs = []
    notes = ["# SceneAtlas voiceover timing", "", "Silent 2:55 master. Cues below are optional talking points, not recorded narration.", "", "The scale test and original one-scene planning example are explicitly separated. All footage comes from the hosted app. Waiting periods are cut and labeled. Visual holds may repeat the final frame of a shot; interaction speed is unchanged.", "", "| Time | Shot | Voiceover cue |", "| --- | --- | --- |"]
    timeline = []
    total = 0
    def stamp(value):
        return f"{int(value) // 60}:{int(value) % 60:02d}"
    for index, (identifier, duration, title, subtitle, cue) in enumerate(sequence):
        segment = segments[identifier]
        # Preserve the key click when it occurs at the start of a shot. Other
        # shots keep the ending assertion and remove setup navigation.
        available = segment["end"] - segment["start"]
        used = min(available, duration)
        start = segment["start"] if identifier in {"scale-last-scene", "revision-apply"} else max(segment["start"], segment["end"] - duration)
        header = Image.new("RGBA", (1920, 1080), (0, 0, 0, 0)) if identifier == "scale-wide" else Image.new("RGB", (1920, 58), "#131610")
        draw = ImageDraw.Draw(header)
        draw.rectangle((0, 0, 1920, 57), fill="#131610")
        draw.text((52, 14), f"SCENEATLAS   /   {title}", font=ImageFont.truetype(bold, 20), fill="#dca83c")
        subtitle_font = ImageFont.truetype(font, 15)
        width = draw.textlength(subtitle, font=subtitle_font)
        draw.text((1868 - width, 17), subtitle, font=subtitle_font, fill="#edf0e2")
        if identifier == "scale-wide":
            # Editorial result callout occupies the empty canvas margin; the
            # actual 202-card graph remains fully visible beside it.
            draw.text((144, 310), "DEMO RESULT", font=ImageFont.truetype(bold, 18), fill="#9ba58f")
            draw.text((144, 350), str(scale["pages"]), font=ImageFont.truetype(bold, 88), fill="#dca83c")
            draw.text((330, 410), "pages", font=ImageFont.truetype(font, 28), fill="#edf0e2")
            draw.text((144, 478), str(scale["scenes"]), font=ImageFont.truetype(bold, 88), fill="#edf0e2")
            draw.text((330, 538), "scene cards", font=ImageFont.truetype(font, 26), fill="#9ba58f")
            draw.line((144, 627, 500, 627), fill="#dca83c", width=2)
            draw.text((144, 657), "One screenplay.\nOne shared workspace.", font=ImageFont.truetype(font, 25), fill="#edf0e2", spacing=10)
        header_path = assets / f"{index:02d}-header.png"
        header.save(header_path)
        dest = chapters / f"{index + 1:02d}-{identifier}.mp4"
        filters = (
            "[0:v]setpts=PTS-STARTPTS,fps=30,"
            "scale=1816:1022:flags=lanczos,setsar=1,pad=1920:1080:52:58:color=0x131610[screen];"
            "[screen][1:v]overlay=0:0,"
            f"tpad=stop_mode=clone:stop_duration={max(0, duration - used) + 0.1},trim=duration={duration}"
        )
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{start:.3f}", "-t", f"{used:.3f}", "-i", sources[segment["page"]], "-loop", "1", "-i", header_path, "-filter_complex", filters, "-frames:v", duration * 30, "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", dest])
        outputs.append(dest)
        notes.append(f"| {stamp(total)}–{stamp(total + duration)} | {title.title()} | {cue} |")
        timeline.append({"id": identifier, "start": total, "end": total + duration, "source": sources[segment["page"]], "sourceIn": start, "sourceDuration": used, "freezeSeconds": max(0, duration - used)})
        total += duration
        print(f"Edited {identifier}: {total}s", flush=True)

    # Render the actual downloaded document, not a recreated paperwork mockup.
    pdf = args.evidence.parent / f"{evidence['pass']}-preparation-packet.pdf"
    run(["pdftoppm", "-f", "1", "-singlefile", "-scale-to", "1500", "-png", pdf, assets / "packet-page"])
    document = chapters / "19-downloaded-document.mp4"
    frame = Image.new("RGB", (1920, 1080), "#131610")
    pdf_image = Image.open(assets / "packet-page.png").convert("RGB")
    pdf_image = pdf_image.resize((round(pdf_image.width * 970 / pdf_image.height), 970), Image.Resampling.LANCZOS)
    frame.paste(pdf_image, ((1920 - pdf_image.width) // 2, 80))
    draw = ImageDraw.Draw(frame)
    title = "THE DOWNLOADED PREPARATION PACKET"
    title_font = ImageFont.truetype(bold, 26)
    draw.text(((1920 - draw.textlength(title, font=title_font)) / 2, 22), title, font=title_font, fill="#dca83c")
    frame.save(assets / "document.png")
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-i", assets / "document.png", "-t", "7", "-r", "30", "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", document])
    outputs.append(document)
    notes.append(f"| {stamp(total)}–{stamp(total + 7)} | Downloaded PDF | This is a preparation draft for review. External permission and unverified items still need confirmation. |")
    total += 7

    close = chapters / "20-close.mp4"
    search_stack = "Parallel + Exa fallback" if any(s["provider"] == "exa" for s in evidence["focus"]["sources"]) else "Parallel"
    close_lines = [
        ("SceneAtlas", bold, 100, "0xedf0e2", 270),
        ("From screenplay to shared production plan.", font, 36, "0xdca83c", 410),
        ("Scenes. Sources. Decisions. Together.", font, 25, "0x9ba58f", 490),
        (f"Google ADK + Gemini  |  {search_stack}  |  Convex + Clerk", font, 21, "0x9ba58f", 675),
        ("sceneatlas-black.vercel.app", bold, 29, "0xedf0e2", 740),
    ]
    frame = Image.new("RGB", (1920, 1080), "#131610")
    draw = ImageDraw.Draw(frame)
    draw.line((825, 225, 1095, 225), fill="#dca83c", width=3)
    for index, (text, face, size, color, y) in enumerate(close_lines):
        face = ImageFont.truetype(face, size)
        draw.text(((1920 - draw.textlength(text, font=face)) / 2, y), text, font=face, fill=color.replace("0x", "#"))
    frame.save(assets / "close.png")
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-i", assets / "close.png", "-t", "9", "-r", "30", "-vf", "fade=t=in:st=0:d=0.35,fade=t=out:st=8.65:d=0.35", "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", close])
    outputs.append(close)
    notes.append(f"| {stamp(total)}–{stamp(total + 9)} | SceneAtlas | SceneAtlas keeps the screenplay, research, and team decisions connected through the handoff. |")
    total += 9
    if total != 175:
        raise ValueError(f"Unexpected master duration {total}")
    concat = assets / "concat.txt"
    concat.write_text("\n".join(f"file '{p}'" for p in outputs) + "\n")
    master = root / "sceneatlas-silent.mp4"
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concat, "-c", "copy", "-movflags", "+faststart", master])
    (root / "timing.md").write_text("\n".join(notes) + "\n")
    (root / "edit-timeline.json").write_text(json.dumps(timeline, indent=2))
    print(master)


if __name__ == "__main__":
    main()
