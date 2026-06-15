# KNOWHERE — KSP Crime Intelligence Platform

> Built for **KSP Datathon 2026** · Karnataka State Police

KNOWHERE is a full-stack crime intelligence platform that lets Karnataka Police officers query FIR data in natural language, visualise criminal networks, track case timelines, and monitor district-level threat levels — all driven by a synthetic dataset of 50 real-looking Karnataka FIRs.

---

## Features

### Chat Intelligence
- Natural language queries against 50 FIRs using **Groq LLaMA 3.3-70b** (RAG — keyword-ranked FIR retrieval, top 8 blocks sent to LLM)
- **Voice input** via MediaRecorder → Groq Whisper large-v3 transcription with automatic language detection
- **Text-to-Speech** playback on every bot reply, auto-detects Kannada / Hindi / English script and sets the correct voice
- Responds in the same language the officer used — English query → English reply, Kannada → Kannada, Hindi → Hindi
- Role-aware responses based on the logged-in officer's clearance level

### Network Analysis
- D3.js force-directed criminal link graph — **76 nodes, 104 edges**
- Node types: Accused · Incident · Victim · Location
- Scroll-to-zoom, drag-to-pan, +/−/fit buttons, auto-fit on load
- Hover highlights connected edges and dims unrelated nodes
- Click any node for a detail panel (role, linked cases, last seen, district)
- Search bar dims non-matching nodes to reveal subgraphs

### Crime Timeline
- Chronological view of **65 case events** from Jan 2025 → Jun 2026
- Event types: FIR Filed · Arrest · Court/Conviction
- Filterable by event type

### Threat Heatmap
- Interactive Karnataka state map — all **31 districts** as clickable tiles
- Threat levels: Critical · Elevated · Normal · No Data
- Derived from live open-FIR counts in the dataset
- Click a district to jump to Chat and query that district automatically

### Anomaly Alert Feed
- **9 dataset-derived alerts** covering repeat offenders, gang activity, cross-district cases, drug trafficking, high-risk open cases, and cybercrime
- Always-visible right rail + full-page panel view
- Refreshes every 30 seconds

### Role-Based Access
| Role | Access |
|---|---|
| `investigator` | Chat, Network, Timeline, Alerts |
| `analyst` | + Threat Heatmap |
| `supervisor` | + Audit Log |

### Audit Log
- Every authenticated API action is logged with timestamp, officer name, role, and query
- Visible only to the `supervisor` role

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite (SWC), D3.js v7 |
| Styling | Pure CSS variables — no Tailwind, no component library |
| Backend | Node.js, Express 5 |
| AI — Chat | Groq LLaMA 3.3-70b-versatile |
| AI — Voice | Groq Whisper large-v3 |
| Auth | JWT (jsonwebtoken, HS256, 8h expiry) |
| Platform | Zoho Catalyst (serverless function + client hosting) |
| Voice I/O | Web Speech API (TTS) · MediaRecorder API (capture) |

---

## Project Structure

```
KSP-Datathon-2026/
├── functions/
│   └── ksp_datathon_2026_function/
│       ├── index.js          # Entire backend — auth, API routes, AI, parsers
│       ├── package.json
│       └── .gitignore        # .env excluded
├── knowhere/                 # React + Vite frontend
│   ├── src/
│   │   ├── App.jsx
│   │   ├── index.css         # All styling (~1200 lines, dark theme)
│   │   └── components/
│   │       ├── LoginPage.jsx
│   │       ├── Dashboard.jsx
│   │       ├── ChatPanel.jsx       # Voice, TTS, multilingual chat
│   │       ├── NetworkPanel.jsx    # D3 force graph with pan/zoom
│   │       ├── TimelinePanel.jsx
│   │       ├── HeatmapPanel.jsx    # 31-district Karnataka map
│   │       ├── AlertFeed.jsx
│   │       └── AuditPanel.jsx
│   └── vite.config.js        # Proxies /api → localhost:3000
├── synthetic_ksp_data.txt    # 50 synthetic FIRs (942 lines)
├── .gitignore
└── README.md
```

---

## The Dataset

`synthetic_ksp_data.txt` — 50 FIRs covering January 2025 to June 2026, generated specifically for this platform.

**Coverage:** 10 districts · Bengaluru Urban, Bengaluru Rural, Mysuru, Mangaluru, Hubballi-Dharwad, Belagavi, Kalaburagi, Tumakuru, Ballari, Shivamogga

**Crime types:** Robbery · Drug Trafficking · Gang Activity · Cybercrime · Murder · Kidnapping · Assault · Burglary · Vehicle Theft · Fraud · Extortion · POCSO

**Designed patterns:**
- 7 repeat offenders appearing across multiple districts
- The **Black Cobra syndicate** — a named organised crime network with FIRs in 3 districts
- 2 explicit cross-district investigations
- A cross-reference index at the end of the file

Each FIR contains: FIR Number, Date, Police Station, District, Crime Type, Accused, Victim, Location of Incident, Modus Operandi, Status, Assigned Officer, and a detailed narrative Brief Description.

---

## API Routes

| Method | Route | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | Public | Returns signed JWT |
| POST | `/api/chat` | Token | RAG chat via Groq LLaMA |
| POST | `/api/transcribe` | Token | Audio → Groq Whisper → transcript + language |
| GET | `/api/network` | Token | Criminal link graph (`?query=` for subgraph) |
| GET | `/api/alerts` | Token | 9 dataset-derived anomaly alerts |
| GET | `/api/timeline` | Token | 65 chronological case events |
| GET | `/api/heatmap` | Token | 31 Karnataka districts with threat levels |
| POST | `/api/case-summary` | Token | Structured case brief from conversation |
| GET | `/api/audit` | Supervisor | Full in-memory audit log |

---

## Running Locally

**Prerequisites:** Node.js 18+, a [Groq API key](https://console.groq.com)

### 1. Backend

```bash
cd functions/ksp_datathon_2026_function
npm install
```

Create `.env`:
```
GROQ_API_KEY=your_groq_api_key_here
JWT_SECRET=your_strong_random_secret_here
```

```bash
node index.js
# API running on http://localhost:3000
```

### 2. Frontend

```bash
cd knowhere
npm install
npm run dev
# App running on http://localhost:5173
```

Vite proxies `/api/*` to `localhost:3000` automatically.

### Demo Credentials

| Email | Password | Role |
|---|---|---|
| `investigator@ksp.gov.in` | `inv123` | Investigator |
| `analyst@ksp.gov.in` | `ana123` | Analyst |
| `supervisor@ksp.gov.in` | `sup123` | Supervisor |

---

## Deployment

The platform is built for **Zoho Catalyst**:
- Backend runs as a Catalyst Node.js serverless function
- Frontend is hosted on Catalyst's client hosting (static build)
- Use `catalyst deploy` after configuring your Catalyst project credentials

---

## Intelligence Data at a Glance

```
Dataset      65 parsed FIRs · 10 districts · Jan 2025 – Jun 2026
Network      76 nodes (32 accused · 18 incidents · 14 victims · 12 locations)
             104 edges (accused→incident · co-accused · incident→victim · incident→location)
Timeline     65 events (40 FIR filed · 14 arrest · 11 court/conviction)
Heatmap      31 districts (4 critical · 6 elevated · 21 no-data)
Alerts       9 active (repeat offenders · gang · cross-district · narcotics · high-risk)
```
