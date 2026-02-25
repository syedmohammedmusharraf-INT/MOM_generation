# 📝 MoM-AI — Minutes of Meeting Generator

An end-to-end system that **captures meeting audio**, **transcribes it**, and **generates structured Minutes of Meeting** using AI. Built with a React frontend and a FastAPI + Python backend.

---

## 📂 Project Structure

```
mom_generation_new/
│
├── BACKEND/                    # Python FastAPI backend
│   ├── app/                    # Core application package
│   │   ├── api/                # API route handlers
│   │   ├── core/               # Config, settings, constants
│   │   ├── prompt/             # LLM prompt templates for MoM generation
│   │   ├── utils/              # Helper utilities (audio processing, S3, etc.)
│   │   └── soniox_test/        # Soniox transcription testing
│   ├── backend.py              # Main FastAPI application entry point
│   ├── app.py                  # Streamlit app (legacy UI)
│   ├── init_s3.py              # S3 bucket initialization script
│   ├── Dockerfile              # Docker build config
│   ├── docker-compose.yml      # Docker Compose for deployment
│   ├── Caddyfile               # Caddy reverse proxy config (HTTPS)
│   ├── pyproject.toml          # Python dependencies (uv/pip)
│   └── .env                    # Environment variables (not in git)
│
├── FRONTEND_UPDATED/           # React + Vite frontend (active)
│   ├── public/                 # Static assets (favicon, icons)
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Index.tsx       # Main layout — stepper, topbar, routing
│   │   │   ├── RecorderPage.tsx# Audio recorder — Web Audio API pipeline
│   │   │   ├── DetailsPage.tsx # Meeting details form (attendees, context)
│   │   │   └── ConfirmationPage.tsx # Success page after submission
│   │   ├── components/         # Reusable UI components (TimerDisplay, etc.)
│   │   ├── hooks/              # Custom React hooks
│   │   ├── lib/                # Utility functions
│   │   ├── index.css           # Global styles + design system
│   │   └── main.tsx            # React entry point
│   ├── index.html              # HTML shell
│   ├── vite.config.ts          # Vite configuration
│   ├── package.json            # Node.js dependencies
│   └── .env                    # Frontend env vars (not in git)
│
└── FRONTEND/                   # Legacy Streamlit-based frontend (deprecated)
```

---

## ⚙️ Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 18, TypeScript, Vite, TailwindCSS |
| **Backend** | Python 3.10+, FastAPI, Uvicorn |
| **Audio Pipeline** | Web Audio API (GainNode, DynamicsCompressor, BiquadFilter) |
| **Transcription** | Soniox API |
| **AI / LLM** | OpenAI GPT |
| **Storage** | AWS S3 (presigned URL uploads) |
| **Database** | MongoDB (via Motor async driver) |
| **Deployment** | Docker, Docker Compose, Caddy (HTTPS) |

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** ≥ 18 & **npm** (for frontend)
- **Python** ≥ 3.10 & **uv** (for backend)
- **Docker** & **Docker Compose** (optional, for containerized deployment)

---

### 1. Backend Setup

```bash
cd BACKEND

# Create a .env file with required variables
cp .env.example .env
# Edit .env and fill in:
#   SONIOX_API_KEY=...
#   OPENAI_API_KEY=...
#   AWS_ACCESS_KEY_ID=...
#   AWS_SECRET_ACCESS_KEY=...
#   AWS_REGION=...
#   S3_BUCKET_NAME=...
#   MONGO_URI=...

# Install dependencies
uv sync

# Run the server
uv run uvicorn backend:app --host 0.0.0.0 --port 3000 --reload
```

**Or with Docker:**

```bash
cd BACKEND
docker compose up --build
```

The backend runs on **http://localhost:3000**.

---

### 2. Frontend Setup

```bash
cd FRONTEND_UPDATED

# Create a .env file
echo "VITE_BACKEND_URL=http://localhost:3000" > .env

# Install dependencies
npm install

# Start dev server
npm run dev
```

The frontend runs on **http://localhost:5173**.

---

## 🎙️ Audio Capture Pipeline

The recorder uses the **Web Audio API** for high-quality, far-field audio capture:

```
Microphone → High-Pass Filter (150Hz) → Gain Node (1×–10×) → Compressor → Makeup Gain → MediaRecorder
```

| Node | Purpose |
|------|---------|
| **High-Pass Filter** | Cuts low-freq rumble from AC, fans, footsteps |
| **Gain Node** | User-adjustable boost (slider: 1×–10×) for room distance |
| **Compressor** | Normalizes dynamic range — boosts quiet speech, clamps loud |
| **Makeup Gain** | +3.5 dB lift after compression |

**Audio settings:**
- Sample rate: 48 kHz
- Codec: Opus (WebM container)
- Bitrate: 256 kbps
- Echo cancellation, noise suppression, and auto gain control enabled

---

## 📤 Upload Flow

1. Audio is recorded in-browser using `MediaRecorder`
2. Frontend requests a **presigned S3 URL** from the backend
3. File is uploaded **directly to S3** from the browser (no backend bottleneck)
4. Frontend registers the upload metadata with the backend (MongoDB)

---

## 🔐 Environment Variables

### Backend (`.env`)

| Variable | Description |
|----------|-------------|
| `SONIOX_API_KEY` | Soniox transcription API key |
| `OPENAI_API_KEY` | OpenAI API key for MoM generation |
| `AWS_ACCESS_KEY_ID` | AWS credentials for S3 |
| `AWS_SECRET_ACCESS_KEY` | AWS credentials for S3 |
| `AWS_REGION` | AWS region (e.g., `ap-south-1`) |
| `S3_BUCKET_NAME` | S3 bucket for audio storage |
| `MONGO_URI` | MongoDB connection URI |

### Frontend (`.env`)

| Variable | Description |
|----------|-------------|
| `VITE_BACKEND_URL` | Backend API base URL |

---

## 📝 License

Internal project — all rights reserved.
