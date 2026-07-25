# KNOWHERE — KSP Crime Intelligence Platform

> Built for **KSP Datathon 2026** · Karnataka State Police

### 🔗 Live app — **https://knowhere-zvumaxeo.onslate.in/**

KNOWHERE lets police officers query FIR records in plain language, visualise criminal networks, track case timelines, monitor district threat levels, and generate case briefs as PDFs — running end to end on **Zoho Catalyst**.

---

## ⚠️ Demo Access — Read This First

**This platform does not accept real user sign-ups.** There is no registration flow, and no real officer accounts exist. Authentication runs on three fixed demo accounts representing the three clearance levels.

**You do not need to type any credentials.** On the login screen there are three **access cards** below the login form — click one and it signs you in instantly with that role.

| Access card | Clearance | Email | Password |
|---|---|---|---|
| **INVESTIGATOR ACCESS** | Level 1 | `investigator@ksp.gov.in` | `inv123` |
| **ANALYST ACCESS** | Level 2 | `analyst@ksp.gov.in` | `ana123` |
| **SUPERVISOR ACCESS** | Level 3 | `supervisor@ksp.gov.in` | `sup123` |

You can also type the email/password manually if you prefer. Either way you get a signed JWT valid for 24 hours.

👉 **Start with SUPERVISOR ACCESS** — it's Clearance Level 3 and unlocks every panel, including the Threat Heatmap and the Audit Log.

> **If the app loads to a blank dashboard or every panel errors,** your browser is holding an expired session. Open DevTools → Console, run `localStorage.removeItem('knowhere_auth')`, reload, and sign in again.

---

## How to Use the App

### 1. Sign in
Open **https://knowhere-zvumaxeo.onslate.in/** and click an access card (start with **SUPERVISOR ACCESS**). You'll land on the dashboard: navigation on the left, main panel in the centre, live alert rail on the right.

### 2. Chat Intelligence — ask questions in plain language
Type a question and press Enter. Every answer cites the FIR numbers it came from.

Try:
- `drug trafficking cases in Bengaluru`
- `Tell me about the Black Cobra gang`
- `Which repeat offenders have multiple open cases?`

**Ask in your own language** — Kannada, Hindi, Tamil, Telugu or Malayalam all work, and the reply comes back in the same language:
- `ಬೆಂಗಳೂರಿನಲ್ಲಿ ಮಾದಕ ವಸ್ತು ಪ್ರಕರಣಗಳು` (Kannada)
- `बेंगलुरु में साइबर अपराध के मामले` (Hindi)

**🎤 Voice** — click the mic, allow access, and speak your question. It's transcribed with automatic language detection and dropped into the input box.

**🔊 Listen** — every reply has a speaker button that reads it aloud in the matching language.

### 3. Generate a Case Brief PDF
After you've asked at least one question, click **GENERATE CASE BRIEF**. In about 8 seconds a formatted PDF opens in a new tab — KSP letterhead, classification stamp, your officer name, persons of interest, timeline, recommended leads and a risk assessment.

*If nothing opens, check for a blocked-popup icon in the address bar — it falls back to downloading the file.*

### 4. Network Analysis — see how cases connect
A force-directed graph of 76 nodes and 104 edges linking accused, incidents, victims and locations.
- **Scroll** to zoom, **drag** to pan, or use the **+ / − / fit** buttons
- **Hover** a node to highlight its connections
- **Click** a node for details — role, linked cases, last seen, district
- **Search** a name (try `Khalid`) to isolate that person's network

### 5. Crime Timeline
65 case events from Jan 2025 to Jun 2026 in chronological order. Filter by **FIR filed**, **arrest**, or **court/conviction**.

### 6. Threat Heatmap *(Analyst + Supervisor)*
All 31 Karnataka districts as colour-coded tiles by threat level, from live open-FIR counts. **Click any district** to jump to chat with a question about it pre-filled.

### 7. Anomaly Feed
Eight active alerts — repeat offenders, gang activity, cross-district cases, narcotics, high-risk open cases, cybercrime. These are recomputed **server-side every hour** by a scheduled job, not in your browser.

### 8. Audit Log *(Supervisor only)*
Every authenticated action — logins, queries, panel views, brief generation — with timestamp, officer and role. Look for `system@cron` entries: those are the hourly background job logging its own runs.

### What each role can see
| Panel | Investigator | Analyst | Supervisor |
|---|:--:|:--:|:--:|
| Chat Intelligence | ✅ | ✅ | ✅ |
| Network Analysis | ✅ | ✅ | ✅ |
| Crime Timeline | ✅ | ✅ | ✅ |
| Anomaly Feed | ✅ | ✅ | ✅ |
| Threat Heatmap | — | ✅ | ✅ |
| Audit Log | — | — | ✅ |

Access control is enforced on the **server**, not just hidden in the UI — a lower-clearance token calling a restricted route gets a `403`.

---

## Built on Zoho Catalyst

KNOWHERE doesn't merely *run* on Catalyst — its data and AI paths depend on Catalyst services:

| Catalyst service | What it does here |
|---|---|
| **QuickML Knowledge Base** | RAG chat — FIR documents indexed in the KB, answered by GLM 4.7B Flash grounded in them |
| **Data Store** | `FIRs` (65) · `Accused` (124) · `AuditLog` · `Alerts` — the runtime source of truth |
| **ZCQL** | Powers the network graph, timeline, heatmap and alert aggregation |
| **SmartBrowz** | Renders the case brief server-side into a real PDF |
| **Cron** | Hourly job recomputing anomaly alerts into the `Alerts` table |
| **Serverless (Advanced I/O)** | Hosts the Express API |
| **Slate** | Hosts the React frontend |

`synthetic_ksp_data.txt` is only a **seed source and offline fallback** — at runtime the app reads from Data Store.

### Two deliberate chat paths
- **English → QuickML Knowledge Base** (`retrieval: quickml-kb`, ~5s)
- **Kannada / Hindi / Tamil / Telugu / Malayalam → Data Store ZCQL + Groq** (~2s) — translated for retrieval, answered in the officer's language

*Why:* the Knowledge Base indexes English documents and proved unreliable generating Indian-language output (measured 60s and a 500 error, against a 30s function limit). This split keeps multilingual fast and dependable.

### Graceful degradation
Every Catalyst path has a fallback: without Data Store it parses the local dataset, without the Knowledge Base it uses ZCQL + Groq, and without Groq it answers directly from the parsed FIRs. The app never dead-ends.

### LLM deprecation status ✅
QuickML retires the Qwen model family on **31 July 2026** in favour of **GLM 4.7B Flash**. KNOWHERE needs no migration:
- Live responses report `model_usage.model = crm-di-glm47b_30b_it` — already the GLM 4.7B Flash replacement, not Qwen.
- The guide's payload changes target the **LLM Serving** API (`prompt` / `system_prompt` → `messages`). We use the **RAG** API (`/rag/answer` with `{query, documents}`), which rejects any extra key, so there's no `model` field to change.
- GLM keeps the answer in the top-level `response` field, which is what the client already reads; `choices[0].message.content` is parsed as a fallback.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, D3.js v7 |
| Styling | Pure CSS variables — no framework |
| Backend | Node.js 18, Express 5 |
| AI — Chat | Catalyst QuickML KB (GLM 4.7B Flash) · Groq LLaMA 3.3-70b |
| AI — Voice | Groq Whisper large-v3 |
| Auth | JWT (HS256, 24h) + server-side role middleware |
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
│       └── components/              # LoginPage, Dashboard, ChatPanel, NetworkPanel,
│                                    # TimelinePanel, HeatmapPanel, AlertFeed, AuditPanel
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
| POST | `/api/chat` | Token | RAG chat (KB for English, ZCQL + Groq otherwise) |
| POST | `/api/transcribe` | Token | Audio → Whisper → transcript + language |
| POST | `/api/case-summary` | Token | Case brief as a SmartBrowz PDF |
| GET | `/api/network` | Token | Link graph (`?query=` for a subgraph) |
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

Create `.env` inside `functions/ksp_datathon_2026_function/`:
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

Only `GROQ_API_KEY` and `JWT_SECRET` are required to run locally.

---

## Deploy

```bash
catalyst deploy --only functions:ksp_datathon_2026_function   # backend
catalyst deploy slate                                          # frontend
```

> The Slate `source` in `catalyst.json` is an **absolute path** — the CLI rejects a relative one with *"You are not in a catalyst app directory."* Update that line if you clone this repo elsewhere.

## Test

```bash
node tests/smoke.js
```

73 checks against the live deployment: health, login for all three roles, JWT expiry and rejection, RBAC on every protected route, chat in three languages, PDF generation, all four panels against exact expected counts, the audit trail, and cron registration plus execution.

---

## The Dataset

`synthetic_ksp_data.txt` — 65 synthetic FIRs, Jan 2025 → Jun 2026, written for this platform. No real case data is used.

**10 districts:** Bengaluru Urban · Bengaluru Rural · Mysuru · Mangaluru · Hubballi-Dharwad · Belagavi · Kalaburagi · Tumakuru · Ballari · Shivamogga

**Crime types:** Robbery · Drug Trafficking · Gang Activity · Cybercrime · Murder · Kidnapping · Assault · Burglary · Vehicle Theft · Fraud

**Deliberate patterns to explore:** 7 repeat offenders spanning districts · the **Black Cobra syndicate** across 3 districts · 2 cross-district investigations.

---

## Intelligence Data at a Glance

```
Dataset      65 FIRs · 10 districts · Jan 2025 – Jun 2026
Network      76 nodes · 104 edges
Timeline     65 events (40 FIR filed · 14 arrest · 11 court)
Heatmap      31 districts (4 critical · 6 elevated · 21 no-data)
Alerts       8 active, de-duplicated, Cron-refreshed hourly
```
