"""
Soniox Async Transcription — S3 Public URL
Features: Speaker Diarization + Timestamps + Multi-language Support
"""

import os
import time
import json
import requests
from datetime import timedelta
from typing import Optional

SONIOX_API_BASE_URL = "https://api.soniox.com"


# ─────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────

def format_time(ms: int) -> str:
    """Convert milliseconds to HH:MM:SS format."""
    td = timedelta(milliseconds=ms)
    total_seconds = int(td.total_seconds())
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours > 0:
        return f"{hours:02}:{minutes:02}:{seconds:02}"
    return f"{minutes:02}:{seconds:02}"


def get_authenticated_session() -> requests.Session:
    """Create an authenticated requests session using SONIOX_API_KEY."""
    api_key = os.environ.get("SONIOX_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Missing SONIOX_API_KEY.\n"
            "Set it with: export SONIOX_API_KEY=<your_api_key>\n"
            "Get your key at: https://console.soniox.com"
        )
    session = requests.Session()
    session.headers["Authorization"] = f"Bearer {api_key}"
    return session


# ─────────────────────────────────────────────
# SONIOX API CALLS
# ─────────────────────────────────────────────

def create_transcription(session: requests.Session, audio_url: str) -> str:
    """Submit an async transcription job for a public audio URL."""
    config = {
        # Async model — use stt-async-v4 for file/URL transcription
        "model": "stt-async-v4",

        # ── Speaker Diarization ──────────────────────────────────────────
        # Identifies who is speaking. Each token gets a "speaker" field.
        "enable_speaker_diarization": True,

        # ── Multi-language Support ───────────────────────────────────────
        # Detects the language of each token automatically.
        "enable_language_identification": True,

        # Hint the expected languages for better accuracy.
        # Add or remove language codes based on your audio content.
        # Full list: https://soniox.com/docs/stt/concepts/language-hints
        "language_hints": ["en", "hi", "es", "fr", "de", "ar", "zh", "pt"],

        # ── Audio Source ─────────────────────────────────────────────────
        "audio_url": audio_url,
    }

    print(f"Submitting transcription for: {audio_url}")
    res = session.post(f"{SONIOX_API_BASE_URL}/v1/transcriptions", json=config)
    res.raise_for_status()

    transcription_id = res.json()["id"]
    print(f"Transcription job created. ID: {transcription_id}")
    return transcription_id


def poll_until_completed(session: requests.Session, transcription_id: str, poll_interval: int = 3) -> None:
    """Poll the transcription status until it's completed or errored."""
    print("Waiting for transcription to complete", end="", flush=True)
    while True:
        res = session.get(f"{SONIOX_API_BASE_URL}/v1/transcriptions/{transcription_id}")
        res.raise_for_status()
        data = res.json()
        status = data["status"]

        if status == "completed":
            print(" Done!")
            return
        elif status == "error":
            raise RuntimeError(f"Transcription failed: {data.get('error_message', 'Unknown error')}")
        else:
            print(".", end="", flush=True)
            time.sleep(poll_interval)


def fetch_transcript_tokens(session: requests.Session, transcription_id: str) -> list:
    """Fetch the transcript tokens from a completed transcription."""
    res = session.get(f"{SONIOX_API_BASE_URL}/v1/transcriptions/{transcription_id}/transcript")
    res.raise_for_status()
    return res.json().get("tokens", [])


# ─────────────────────────────────────────────
# TRANSCRIPT RENDERING
# ─────────────────────────────────────────────

def render_transcript(tokens: list) -> str:
    """
    Render tokens into a readable transcript grouped by speaker segments.
    Each segment shows:
      - Timestamp range [MM:SS → MM:SS]
      - Speaker label
      - Detected language (with change indicators)
      - Spoken text
    """
    lines = []
    current_speaker = None
    current_language = None
    segment_tokens = []

    def flush_segment():
        nonlocal current_speaker, current_language
        if not segment_tokens:
            return

        # Build text, noting language switches inline
        text_parts = []
        seg_lang = None
        for t in segment_tokens:
            lang = t.get("language")
            if lang and lang != seg_lang:
                if seg_lang is not None:
                    text_parts.append(f" [→ {lang.upper()}] ")
                seg_lang = lang
            text_parts.append(t.get("text", ""))

        text = "".join(text_parts).strip()
        if not text:
            return

        start_ms = segment_tokens[0].get("start_ms", 0)
        end_ms = segment_tokens[-1].get("end_ms", 0)
        start_fmt = format_time(start_ms)
        end_fmt = format_time(end_ms)

        speaker_label = f"Speaker {current_speaker}" if current_speaker else "Unknown"
        lang_label = f" [{seg_lang.upper()}]" if seg_lang else ""

        lines.append(
            f"[{start_fmt} → {end_fmt}] {speaker_label}{lang_label}\n"
            f"  {text}\n"
        )
        segment_tokens.clear()

    for token in tokens:
        speaker = token.get("speaker")
        language = token.get("language")

        # New speaker → flush previous segment and start new one
        if speaker != current_speaker:
            flush_segment()
            current_speaker = speaker
            current_language = language

        segment_tokens.append(token)

    flush_segment()  # flush the last segment

    return "\n".join(lines)


def render_summary_stats(tokens: list) -> str:
    """Generate a summary: speakers found, languages detected, total duration."""
    speakers = sorted(set(t.get("speaker") for t in tokens if t.get("speaker") is not None))
    languages = sorted(set(t.get("language") for t in tokens if t.get("language")))
    duration_ms = max((t.get("end_ms", 0) for t in tokens), default=0)

    lines = [
        "=" * 60,
        "TRANSCRIPT SUMMARY",
        "=" * 60,
        f"Total Duration   : {format_time(duration_ms)}",
        f"Speakers Found   : {len(speakers)} — {', '.join(f'Speaker {s}' for s in speakers)}",
        f"Languages Detected: {', '.join(lang.upper() for lang in languages) if languages else 'N/A'}",
        f"Total Tokens     : {len(tokens)}",
        "=" * 60,
        "",
    ]
    return "\n".join(lines)


# ─────────────────────────────────────────────
# SAVE OUTPUTS
# ─────────────────────────────────────────────

def save_outputs(transcript_text: str, tokens: list, output_dir: str = ".") -> None:
    """Save transcript as .txt and raw tokens as .json."""
    os.makedirs(output_dir, exist_ok=True)

    txt_path = os.path.join(output_dir, "transcript.txt")
    json_path = os.path.join(output_dir, "tokens_raw.json")

    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(transcript_text)
    print(f"Transcript saved → {txt_path}")

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(tokens, f, indent=2, ensure_ascii=False)
    print(f"Raw tokens saved  → {json_path}")


# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────

def transcribe_from_s3(
    audio_url: str,
    save_to_disk: bool = True,
    output_dir: str = "./transcript_output",
) -> str:
    """
    Full pipeline: Submit S3 URL → Poll → Fetch → Render transcript.

    Args:
        audio_url   : Public S3 URL of the audio file.
        save_to_disk: If True, saves transcript.txt and tokens_raw.json.
        output_dir  : Directory to save output files.

    Returns:
        Full transcript as a string.
    """
    session = get_authenticated_session()

    # Step 1: Submit transcription job
    transcription_id = create_transcription(session, audio_url)

    # Step 2: Wait for completion
    poll_until_completed(session, transcription_id)

    # Step 3: Fetch tokens
    tokens = fetch_transcript_tokens(session, transcription_id)

    if not tokens:
        print("Warning: No tokens returned. The audio may be silent or too short.")
        return ""

    # Step 4: Render transcript
    summary = render_summary_stats(tokens)
    transcript = render_transcript(tokens)
    full_output = summary + transcript

    # Step 5: Print to console
    print("\n" + full_output)

    # Step 6: Optionally save to disk
    if save_to_disk:
        save_outputs(full_output, tokens, output_dir)

    return full_output


# ─────────────────────────────────────────────
# ENTRY POINT
# ─────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Transcribe audio from a public S3 URL using Soniox."
    )
    parser.add_argument(
        "--audio_url",
        required=True,
        help="Public S3 URL of the audio file to transcribe.",
    )
    parser.add_argument(
        "--output_dir",
        default="./transcript_output",
        help="Directory to save transcript.txt and tokens_raw.json (default: ./transcript_output)",
    )
    parser.add_argument(
        "--no_save",
        action="store_true",
        help="Don't save output to disk, only print to console.",
    )
    args = parser.parse_args()

    transcribe_from_s3(
        audio_url=args.audio_url,
        save_to_disk=not args.no_save,
        output_dir=args.output_dir,
    )