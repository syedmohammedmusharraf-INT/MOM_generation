"""
fetch_oldest_meeting.py
────────────────────────────────────────────────────────────
Fetches the oldest unprocessed audio file from S3 (via the
backend API) along with its associated meeting details
(attendees, context, meeting_date) stored in MongoDB.

Usage:
    python fetch_oldest_meeting.py
"""

import requests
import json

# ── Configuration ─────────────────────────────────────────
BACKEND_URL = "http://localhost:3000"   # change to your server URL if remote


def fetch_oldest_meeting():
    """
    Step 1 : GET /api/files/oldest  → file_url + mongo_id
    Step 2 : GET /api/meetings/{mongo_id} → attendees, context, meeting_date
    """

    # ── STEP 1: Get oldest S3 file ────────────────────────
    print("📡 Fetching oldest audio file...")
    resp = requests.get(f"{BACKEND_URL}/api/files/oldest", timeout=10)
    resp.raise_for_status()

    oldest = resp.json()

    if oldest.get("status") == "empty":
        print("📭 No files found in S3 to process.")
        return None

    file_url  = oldest["file_url"]
    mongo_id  = oldest.get("mongo_id")
    filename  = oldest["filename"]
    s3_key    = oldest["s3_key"]

    print(f"✅ Found file   : {filename}")
    print(f"   S3 URL       : {file_url}")
    print(f"   Mongo ID     : {mongo_id or 'N/A (no MongoDB doc found)'}")

    # ── STEP 2: Get meeting details from MongoDB ──────────
    meeting_details = None

    if mongo_id:
        print(f"\n📋 Fetching meeting details for ID: {mongo_id}...")
        detail_resp = requests.get(
            f"{BACKEND_URL}/api/meetings/{mongo_id}",
            timeout=10
        )
        detail_resp.raise_for_status()
        meeting_details = detail_resp.json()

        attendees    = meeting_details.get("attendees")
        context      = meeting_details.get("context")
        meeting_date = meeting_details.get("meeting_date")
        status       = meeting_details.get("status")

        print(f"\n── Meeting Details ─────────────────────────────")
        print(f"   Status       : {status}")
        print(f"   Attendees    : {attendees or 'Not provided'}")
        print(f"   Context      : {context or 'Not provided'}")
        print(f"   Meeting Date : {meeting_date or 'Not provided'}")
        print(f"────────────────────────────────────────────────")
    else:
        print("⚠️  No MongoDB document linked to this file.")
        print("   (File was likely uploaded directly to S3, not via /api/upload)")

    # ── Result object you can use in the next step ────────
    return {
        "filename":      filename,
        "s3_key":        s3_key,
        "file_url":      file_url,
        "mongo_id":      mongo_id,
        "attendees":     meeting_details.get("attendees")    if meeting_details else None,
        "context":       meeting_details.get("context")      if meeting_details else None,
        "meeting_date":  meeting_details.get("meeting_date") if meeting_details else None,
    }


# ── Entry point ───────────────────────────────────────────
if __name__ == "__main__":
    result = fetch_oldest_meeting()

    if result:
        print("\n📦 Final payload for MoM generation:")
        print(json.dumps(result, indent=2, default=str))
