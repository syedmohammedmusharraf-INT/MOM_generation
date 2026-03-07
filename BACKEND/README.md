# 🧠 MeetMind — Backend

> **Minutes of Meeting (MoM) Generation Pipeline**
> A FastAPI-powered backend that captures meeting audio, transcribes it using Soniox, generates structured MoM documents via OpenAI, and stores everything in AWS S3 + MongoDB.

---

## 📑 Table of Contents

- [Architecture Overview](#architecture-overview)
- [Data Flow](#data-flow)
- [Project Structure](#project-structure)
- [Tech Stack](#tech-stack)
- [Environment Variables](#environment-variables)
- [Getting Started](#getting-started)
- [Docker Deployment](#docker-deployment)
- [API Reference](#api-reference)
- [Core Modules](#core-modules)
- [Utility Scripts](#utility-scripts)
- [Reverse Proxy (Caddy)](#reverse-proxy-caddy)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                         CLIENT (Frontend)                        │
│            React App — Records audio in-browser                  │
└──────────────┬──────────────────────────────────┬────────────────┘
               │  POST /api/upload (audio file)   │  PATCH /api/meetings/{id}
               ▼                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                     FASTAPI  BACKEND  (backend.py)               │
│                                                                  │
│  ┌────────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Upload Handler │  │ Meeting CRUD │  │  File Management     │  │
│  │  /api/upload    │  │ /api/meetings│  │  /api/files          │  │
│  └───────┬────────┘  └──────┬───────┘  └──────────┬───────────┘  │
│          │                  │                     │              │
│          ▼                  ▼                     ▼              │
│  ┌──────────────┐   ┌──────────────┐    ┌──────────────────┐    │
│  │   AWS S3     │   │   MongoDB    │    │   S3 List/Delete │    │
│  │  (Storage)   │   │  (Metadata)  │    │   Operations     │    │
│  └──────────────┘   └──────────────┘    └──────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
               │                                  │
               ▼                                  ▼
┌──────────────────────┐          ┌────────────────────────────────┐
│  SONIOX API          │          │  OpenAI GPT API                │
│  (Transcription)     │          │  (MoM Generation from prompt)  │
│  Speaker Diarization │          │  Multi-language → English HTML │
│  Multi-language      │          │                                │
└──────────────────────┘          └────────────────────────────────┘
```

---

## Data Flow

The system follows a **linear pipeline** from audio capture to final MoM document:

### Step 1 — Audio Upload

```
Browser ──(audio blob)──▶ POST /api/upload ──▶ S3 (new_audio_files/) + MongoDB
```

1. The **frontend** records meeting audio in-browser and sends it as a `multipart/form-data` upload.
2. `backend.py` receives the file, saves it temporarily to disk, then **uploads to AWS S3** under `mom_audio_files/new_audio_files/`.
3. A **MongoDB document** is created in the `meetings` collection with fields: `filename`, `s3_key`, `s3_url`, `status: "uploaded"`, `uploaded_at`.
4. Returns `{ mongo_id, file_url, s3_key }` to the frontend.

### Step 2 — Meeting Details Submission

```
Browser ──(attendees, context, date)──▶ PATCH /api/meetings/{mongo_id}
```

1. The user enters **attendees**, **meeting context**, and **meeting date** on the frontend.
2. The frontend calls `PATCH /api/meetings/{mongo_id}` to update the MongoDB document.
3. The status transitions from `"uploaded"` → `"details_submitted"`.

### Step 3 — Audio Transcription (Soniox)

```
S3 audio URL ──▶ Soniox Async API ──▶ Transcript (multi-language, diarized)
```

1. The **Soniox transcription module** (`app/soniox_test/soniox.py`) submits the public S3 audio URL to the Soniox Async API (`stt-async-v4` model).
2. Features enabled:
   - **Speaker Diarization** — identifies who is speaking.
   - **Multi-language Detection** — auto-detects English, Hindi, Bengali, and other languages.
3. The module **polls** the Soniox API until transcription completes.
4. Raw tokens are fetched and **rendered into a human-readable transcript** with timestamps and speaker labels.

### Step 4 — MoM Generation (OpenAI)

```
Transcript text ──▶ OpenAI GPT (MOM_generation.py prompt) ──▶ Formatted HTML MoM
```

1. The transcript is injected into the **MoM generation prompt** (`app/prompt/MOM_generation.py`).
2. OpenAI translates all non-English content into English and generates a **structured HTML document** with these sections:
   - Meeting Overview
   - Speaker Role Identification (table)
   - Key Discussion Points (grouped by theme)
   - Major Decisions
   - Action Items (table)
   - Next Steps

### Step 5 — Post-processing

```
Processed audio ──▶ S3 (processed_audio_files/) + MongoDB status update
```

1. After transcription, the audio file is **moved** from `new_audio_files/` to `processed_audio_files/` in S3.
2. The MongoDB document status is updated accordingly.

---

## Project Structure

```
BACKEND/
├── backend.py                    # 🚀 Main FastAPI application — all API routes
├── app.py                        # 🎙️ Streamlit audio recorder (standalone UI)
│
├── app/                          # Application modules
│   ├── __init__.py
│   ├── core/                     # Core infrastructure
│   │   ├── __init__.py
│   │   ├── config.py             # Environment variable loader (MONGODB_URI, MONGODB_DB)
│   │   └── database.py           # Motor (async MongoDB) client & connection
│   ├── prompt/
│   │   └── MOM_generation.py     # OpenAI prompt template for generating MoM HTML
│   ├── soniox_test/
│   │   └── soniox.py             # Soniox async transcription — speaker diarization + multi-lang
│   └── api/                      # (Reserved for future route modules)
│
├── Dockerfile                    # Docker image — Python 3.10 + uv + uvicorn
├── docker-compose.yml            # Single-service compose for the backend
├── Caddyfile                     # Caddy reverse proxy config (frontend + backend)
├── .devcontainer/
│   └── devcontainer.json         # VS Code Dev Container configuration
│
├── pyproject.toml                # Python project metadata & dependencies
├── uv.lock                       # Lockfile for uv package manager
├── .python-version               # Python version pin (3.10)
│
├── init_s3.py                    # 🔧 One-time script — applies CORS policy to S3 bucket
├── fetch_oldest_meeting.py       # 🔧 CLI tool — fetches oldest unprocessed meeting from API
├── test_s3_upload.py             # 🔧 Connection test — verifies S3 upload permissions
│
├── .env                          # Environment variables (⚠️ not committed to git)
├── .gitignore                    # Git ignore rules
├── .dockerignore                 # Docker build exclusions
├── client_secret.json            # Google OAuth2 credentials (⚠️ not committed)
├── token.pickle                  # Cached Google auth token (⚠️ not committed)
├── transcript.json               # Sample/cached transcript data
└── outputs/                      # Generated output files directory
```

---

## Tech Stack

| Component         | Technology                                      |
| ----------------- | ----------------------------------------------- |
| **Web Framework** | FastAPI (async, high-performance)                |
| **Server**        | Uvicorn (ASGI)                                   |
| **Database**      | MongoDB Atlas (via Motor async driver)           |
| **Object Storage**| AWS S3                                           |
| **Transcription** | Soniox API (async model `stt-async-v4`)          |
| **AI/LLM**        | OpenAI GPT (MoM document generation)             |
| **Audio UI**      | Streamlit (`st.audio_input` widget)              |
| **Containerization**| Docker + Docker Compose                        |
| **Reverse Proxy** | Caddy                                            |
| **Package Manager**| uv (Astral)                                     |
| **PDF Rendering** | WeasyPrint / pdfkit / wkhtmltopdf                |

---

## Environment Variables

Create a `.env` file in the `BACKEND/` directory with the following variables:

```env
# ── AWS S3 ───────────────────────────────────
AWS_REGION=ap-south-1
S3_BUCKET_NAME=your-bucket-name

# ── MongoDB ──────────────────────────────────
MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/
MONGODB_DB=mom_generation

# ── Soniox (Transcription) ──────────────────
SONIOX_API_KEY=your_soniox_api_key

# ── OpenAI (MoM Generation) ─────────────────
OPENAI_API_KEY=sk-proj-your_openai_key

# ── Optional ─────────────────────────────────
PYAANOTATE_API_KEY=your_pyannote_key
```

> **⚠️ Important:** The `.env` file is listed in `.gitignore` and should **never** be committed to version control.

---

## Getting Started

### Prerequisites

- **Python 3.10+**
- **uv** package manager ([install guide](https://docs.astral.sh/uv/getting-started/installation/))
- **MongoDB Atlas** cluster (or local MongoDB instance)
- **AWS S3** bucket with appropriate IAM permissions
- **Soniox** API key ([console.soniox.com](https://console.soniox.com))
- **OpenAI** API key

### Local Development

```bash
# 1. Navigate to the backend directory
cd BACKEND

# 2. Install dependencies with uv
uv sync

# 3. Set up your .env file (see Environment Variables section above)
cp .env.example .env   # then edit with your values

# 4. (One-time) Apply CORS policy to your S3 bucket
uv run python init_s3.py

# 5. Start the development server
uv run uvicorn backend:app --host localhost --port 3000 --reload
```

The API will be available at **`http://localhost:3000`**.

Interactive Swagger docs: **`http://localhost:3000/docs`**

---

## Docker Deployment

### Build & Run

```bash
# Build the image
docker compose build

# Run the container
docker compose up -d
```

### Dockerfile Breakdown

| Layer | Description |
|-------|-------------|
| **Base** | `python:3.10-slim` |
| **Package Manager** | `uv` copied from the official `ghcr.io/astral-sh/uv:latest` image |
| **Dependencies** | Installed via `uv sync --frozen --no-dev --no-cache` (cache-friendly layer) |
| **Motor/PyMongo** | Explicitly installed via `pip` as a safety net |
| **App Code** | Copied with `.dockerignore` exclusions applied |
| **Entry Point** | `uvicorn backend:app --host 0.0.0.0 --port 3000` |

### docker-compose.yml

```yaml
services:
  backend:
    build: .
    image: mom_audio_capture
    container_name: mom_backend
    ports:
      - "3000:3000"        # Exposed backend port
    env_file:
      - .env               # All secrets loaded from .env
    volumes:
      - .:/app             # Hot-reload source mount
      - /app/.venv         # Prevent host .venv from overriding container venv
    environment:
      - PYTHONUNBUFFERED=1  # Real-time log output
    command: uvicorn backend:app --host 0.0.0.0 --port 3000 --reload
```

---

## API Reference

### Audio Upload

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/upload` | Upload an audio file (multipart). Stores in S3 + creates MongoDB record. Returns `{ status, file_url, s3_key, mongo_id }` |

### Meeting Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/meetings/register` | Register a meeting manually (presigned URL flow fallback) |
| `GET` | `/api/meetings/{mongo_id}` | Retrieve full meeting details by MongoDB ID |
| `PATCH` | `/api/meetings/{mongo_id}` | Update meeting metadata: `attendees`, `context`, `meeting_date` |

**PATCH Request Body:**
```json
{
  "attendees": "Alice, Bob, Charlie",
  "context": "Sprint planning for Q2",
  "meeting_date": "2026-03-07"
}
```

### File Management (S3)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/files` | List all files in `new_audio_files/` and `processed_audio_files/` |
| `GET` | `/api/files/oldest` | Get the oldest unprocessed audio file + linked MongoDB ID |
| `DELETE` | `/api/files/{filename}` | Delete a specific file from S3 (checks both folders) |
| `DELETE` | `/api/files/all` | 🔴 **Nuclear option** — delete ALL audio files from S3 and ALL meeting records from MongoDB |

### Presigned URL (Fallback)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/presign?filename=X&content_type=Y` | Generate a presigned S3 PUT URL for direct browser-to-S3 uploads |

---

## Core Modules

### `backend.py` — Main API Application

The central FastAPI application that exposes all REST endpoints. Key responsibilities:
- **Audio Upload Pipeline:** Receives multipart audio → saves to temp file → uploads to S3 → creates MongoDB document → cleans up temp file.
- **S3 Folder Management:** Lazy-initializes folder placeholders (`mom_audio_files/new_audio_files/`, `mom_audio_files/processed_audio_files/`) on first request.
- **AWS Credentials:** Designed to use **EC2 IAM Role** auto-credentials (no hardcoded keys needed in production).
- **CORS:** Fully open (`allow_origins=["*"]`) for development flexibility.

### `app/core/config.py` — Configuration Loader

Loads environment variables using `python-dotenv`:
- `MONGODB_URI` — MongoDB Atlas connection string
- `MONGODB_DB` — Database name (default: `mom_generation`)

### `app/core/database.py` — Database Connection

Sets up a **singleton** Motor async MongoDB client:
- `client` — `AsyncIOMotorClient` instance (shared across app lifetime)
- `db` — Active database reference
- `get_db()` — Returns the database instance for use in route handlers

### `app/soniox_test/soniox.py` — Audio Transcription

Full Soniox async transcription pipeline:
1. **`create_transcription()`** — Submits audio URL to Soniox API with speaker diarization & multi-language detection enabled
2. **`poll_until_completed()`** — Polls transcription status every 3 seconds until done
3. **`fetch_transcript_tokens()`** — Retrieves raw token data (text, speaker, language, timestamps)
4. **`render_transcript()`** — Formats tokens into readable segments: `[00:15 → 00:32] Speaker 1 [EN] Hello everyone...`
5. **`render_summary_stats()`** — Generates summary: total duration, speaker count, languages detected
6. **`transcribe_from_s3()`** — Orchestrates the entire pipeline end-to-end

**Supported Languages:** English, Hindi, Spanish, French, German, Arabic, Chinese, Portuguese (configurable via `language_hints`).

**CLI Usage:**
```bash
python -m app.soniox_test.soniox --audio_url "https://bucket.s3.region.amazonaws.com/audio.wav"
```

### `app/prompt/MOM_generation.py` — MoM Prompt Template

Contains the **system + user prompt** for OpenAI GPT to generate formal Minutes of Meeting documents. The prompt instructs the LLM to:
- Translate all non-English meeting segments into English
- Generate a **styled HTML document** with 6 structured sections
- Include CSS styling for professional PDF-ready output (tables, headers, decision blocks)

**Output Sections:**
1. Meeting Overview (date, format, participants, objective)
2. Speaker Role Identification (HTML table)
3. Key Discussion Points (grouped by themes)
4. Major Decisions (numbered list with rationale)
5. Action Items (HTML table: Owner, Task, Priority)
6. Next Steps (bullet list)

### `app.py` — Streamlit Audio Recorder

A standalone **Streamlit** web app for recording meeting audio via browser:
- Uses `st.audio_input()` widget for in-browser recording
- Authenticates with **Google Drive** via OAuth2 (for legacy Drive upload flow)
- Uploads recorded `.wav` files to a specified Google Drive folder
- Includes session-state management for sequential recordings

> **Note:** This is a legacy/alternate recording interface. The primary flow uses the React frontend.

---

## Utility Scripts

### `init_s3.py` — S3 CORS Initialization

**Run once** before first use to apply a CORS policy to your S3 bucket, enabling browser-based presigned URL uploads.

```bash
python init_s3.py
```

Applies:
- `AllowedOrigins: ["*"]`
- `AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"]`
- `ExposeHeaders: ["ETag"]`
- `MaxAgeSeconds: 3600`

### `fetch_oldest_meeting.py` — Meeting Fetcher

CLI tool to query the backend API and retrieve the **oldest unprocessed** audio file along with its meeting metadata from MongoDB.

```bash
python fetch_oldest_meeting.py
```

**Flow:**
1. `GET /api/files/oldest` → gets `file_url` + `mongo_id`
2. `GET /api/meetings/{mongo_id}` → gets `attendees`, `context`, `meeting_date`
3. Returns a complete payload ready for the transcription + MoM generation pipeline

### `test_s3_upload.py` — S3 Connection Test

Verifies that the backend can successfully upload files to the configured S3 bucket.

```bash
python test_s3_upload.py
```

Creates and uploads a dummy text file to `new_audio_files/`, then cleans up the local copy.

---

## Reverse Proxy (Caddy)

The `Caddyfile` configures **Caddy** as a reverse proxy for both frontend and backend services:

```
:80 {
    reverse_proxy frontend:5173          # React dev server
    reverse_proxy /api/* backend:8000    # FastAPI backend
}
```

- All `/api/*` requests are routed to the backend
- All other requests are routed to the frontend
- Supports automatic HTTPS when configured with a domain name

---

## S3 Folder Structure

```
S3 Bucket (e.g., vyom-backend-1)
└── mom_audio_files/
    ├── new_audio_files/          # ← Newly uploaded, unprocessed audio
    │   ├── Meeting_2026-03-07.wav
    │   └── ...
    └── processed_audio_files/    # ← Audio that has been transcribed
        ├── Meeting_2026-03-06.wav
        └── ...
```

---

## MongoDB Schema

### `meetings` Collection

| Field          | Type       | Description                                     |
| -------------- | ---------- | ----------------------------------------------- |
| `_id`          | `ObjectId` | Auto-generated MongoDB document ID              |
| `filename`     | `string`   | Original audio file name                        |
| `s3_key`       | `string`   | Full S3 object key (path)                       |
| `s3_url`       | `string`   | Public S3 URL for the audio file                |
| `status`       | `string`   | `"uploaded"` → `"details_submitted"` → `"processed"` |
| `uploaded_at`  | `datetime` | UTC timestamp of upload                         |
| `updated_at`   | `datetime` | UTC timestamp of last update                    |
| `attendees`    | `string`   | Comma-separated list of meeting participants    |
| `context`      | `string`   | Meeting purpose/context description             |
| `meeting_date` | `string`   | Date of the meeting                             |

---

## License

Internal project — not for public distribution.
