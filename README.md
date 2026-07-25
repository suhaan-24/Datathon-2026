# KNOWHERE — KSP Crime Intelligence Platform

> Built for **KSP Datathon 2026** · Karnataka State Police

KNOWHERE lets Karnataka Police officers query FIR data in natural language, visualise criminal networks, track case timelines, and monitor district threat levels — running end to end on **Zoho Catalyst**.

---

## Built on Zoho Catalyst

The platform doesn't just *run* on Catalyst — its core data and AI paths depend on Catalyst services:

| Catalyst service | What it does here |
|---|---|
| **QuickML Knowledge Base** | RAG chat. FIR documents are indexed in the KB; English queries are answered by Qwen 2.5 14B grounded in them |
| **Data Store** | `FIRs` (65) · `Accused` (124) · `AuditLog` · `Alerts` — the live source of truth |
| **ZCQL** | Powers the network graph, timeline, heatmap and alert aggregation |
| **SmartBrowz** | Renders the case brief server-side into a real, downloadable PDF |
| **Cron** | Hourly job recomputes anomaly alerts into the `Alerts` table |
| **Serverless (Advanced I/O)** | Hosts the Express API |
| **Slate** | Hosts the React frontend |

`synthetic_ksp_data.txt` is only a **seed source and offline fallback** — at runtime the app reads from Data Store.

---

## Features

### Chat Intelligence
- Natural-language queries over 65 FIRs, with FIR numbers cited in every answer
- **Two deliberate retrieval paths:**
  - English → **Catalyst QuickML Knowledge Base** (`retrieval: quickml-kb`, ~5s)
  - Kannada / Hindi / Tamil / Telugu / Malayalam → **Data Store ZCQL + Groq** (~2s), translating for retrieval and replying in the officer's language
  - *Why:* the KB indexes English documents and is unreliable generating Indian-language output (measured 60s + 500 error against a 30s function limit)
- **Voice input** via MediaRecorder → Groq Whisper large-v3, with language detection
- **Text-to-speech** on replies, script-aware voice selection
- Replies render Markdown (headings, bold, lists) rather than raw markup

### Case Brief PDF
- Generates a structured brief from the conversation and renders it via **SmartBrowz** into a KSP-letterhead PDF (watermark, classification stamp, officer and case metadata)

### Network Analysis
- D3 force-directed graph — **76 nodes, 104 edges**, built from Data Store via ZCQL
- Accused · Incident · Victim · Location, with zoom/pan/fit, hover highlighting, node details, and search-to-subgraph

### Crime Timeline
- **65 chronological events** (40 FIR filed · 14 arrest · 11 court), filterable by type

### Threat Heatmap
- All **31 Karnataka districts** as tiles (4 critical · 6 elevated · 21 no-data), derived from live open-FIR counts. Click a district to query it in chat.

### Anomaly Alerts
- **8 de-duplicated alerts** — repeat offenders, gang activity, cross-district cases, narcotics, high-risk open cases, cybercrime
- Computed server-side by the Catalyst Cron job, not in the browser

### Role-Based Access
| Role | Access |
|---|---|
| `investigator` | Chat, Network, Timeline, Alerts |
| `analyst` | + Threat Heatmap |
| `supervisor` | + Audit Log, admin routes |

### Audit Trail
- Every authenticated action (login, query, panel view, brief, transcription) is written to the Data Store `AuditLog` table
- Includes `system@cron` entries proving the scheduled job is running
- Visible only to `supervisor`

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, D3.js v7 |
| Styling | Pure CSS variables — no framework |
| Backend | Node.js 18, Express 5 |
| AI — Chat | Catalyst QuickML KB (Qwen 2.5 14B) · Groq LLaMA 3.3-70b |
| AI — Voice | Groq Whisper large-v3 |
| Auth | JWT (HS256, 24h expiry) + role-based middleware |
| Platform | Zoho Catalyst |

---

## Project Structure

```
KSP-Datathon-2026/
├── functions/
│   └── ksp_datathon_2026_function/
│       ├── index.js                 # API routes, auth, RBAC, data builders
│       ├── catalyst-data.js         # Data Store / ZCQL: retrieval, audit, alerts, seeding
│       ├── quickml-rag.js           # QuickML Knowledge Base client (OAuth + RAG)
│       ├── synthetic_ksp_data.txt   # 65 FIRs — seed source + offline fallback
│       └── .env                     # secrets (git-ignored)
├── knowhere/                        # React + Vite frontend (deployed to Slate)
│   └── src/
│       ├── api.js                   # API base URL
│       ├── index.css                # All styling (dark tactical theme)
│       └── components/              # LoginPage, Dashboard, ChatPanel,
│                                    # NetworkPanel, TimelinePanel,
│                                    # HeatmapPanel, AlertFeed, AuditPanel
├── catalyst-kb/                     # Cleaned dataset uploaded to the QuickML KB
├── tests/smoke.js                   # 73-check live API test suite
└── catalyst.json                    # Catalyst targets: functions + slate
```

---

## API Routes

| Method | Route | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | Public | Service + Groq status, dataset size |
| POST | `/api/auth/login` | Public | Returns signed JWT (24h) |
| POST | `/api/chat` | Token | RAG chat (KB for English, ZCQL+Groq otherwise) |
| POST | `/api/transcribe` | Token | Audio → Whisper → transcript + language |
| POST | `/api/case-summary` | Token | Case brief as a SmartBrowz PDF |
| GET | `/api/network` | Token | Link graph (`?query=` for subgraph) |
| GET | `/api/timeline` | Token | 65 chronological events |
| GET | `/api/heatmap` | Token | 31 districts with threat levels |
| GET | `/api/alerts` | Token | Cron-computed anomaly alerts |
| GET | `/api/audit` | Supervisor | Data Store audit trail |
| POST | `/api/cron/refresh-alerts` | Cron secret | Recomputes the Alerts table |
| POST | `/api/admin/seed` | Supervisor | Re-seeds Data Store from the dataset |
| POST | `/api/admin/create-cron` | Supervisor | Registers the hourly alert job |
| GET/DELETE | `/api/admin/cron*` | Supervisor | Inspect / remove crons |

---

## Running Locally

**Prerequisites:** Node.js 18+, a [Groq API key](https://console.groq.com)

```bash
# Backend
cd functions/ksp_datathon_2026_function
npm install
node index.js          # http://localhost:3000

# Frontend (separate terminal)
cd knowhere
npm install
npm run dev            # http://localhost:5173 — proxies /api to :3000
```

`.env` in the function directory:
```
GROQ_API_KEY=...
JWT_SECRET=...
CRON_SECRET=...
# QuickML Knowledge Base (optional — falls back to ZCQL + Groq without it)
QUICKML_RAG_URL=...
QUICKML_KB_DOC_IDS=...
CATALYST_ORG_ID=...
ZOHO_CLIENT_ID=...
ZOHO_CLIENT_SECRET=...
ZOHO_REFRESH_TOKEN=...
```

Every Catalyst path degrades gracefully: without Data Store it parses the local dataset, without the KB it uses ZCQL + Groq, and without Groq it answers directly from the parsed FIRs.

### Demo Credentials

| Email | Password | Role |
|---|---|---|
| `investigator@ksp.gov.in` | `inv123` | Investigator |
| `analyst@ksp.gov.in` | `ana123` | Analyst |
| `supervisor@ksp.gov.in` | `sup123` | Supervisor |

---

## Deploy

```bash
catalyst deploy --only functions:ksp_datathon_2026_function   # backend
catalyst deploy slate                                          # frontend
```

## Test

```bash
node tests/smoke.js
```

Runs 73 checks against the live deployment: health, login for all roles, JWT
expiry and rejection, RBAC on every protected route, chat in three languages,
PDF generation, all four panels against exact expected counts, the audit trail,
and cron registration plus execution.

---

## Intelligence Data at a Glance

```
Dataset      65 FIRs · 10 districts · Jan 2025 – Jun 2026
Network      76 nodes · 104 edges
Timeline     65 events (40 FIR filed · 14 arrest · 11 court)
Heatmap      31 districts (4 critical · 6 elevated · 21 no-data)
Alerts       8 active, de-duplicated, Cron-refreshed hourly
```
