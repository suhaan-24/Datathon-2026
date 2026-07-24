'use strict';

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Groq = require('groq-sdk');
const jwt = require('jsonwebtoken');
const catalyst = require('zcatalyst-sdk-node');
const fs = require('fs');
const path = require('path');
const store = require('./catalyst-data');
const quickmlRag = require('./quickml-rag');
require('dotenv').config();

// Catalyst's Node 18 runtime predates the global `File` class (added in Node 20),
// which groq-sdk's Groq.toFile() requires for audio uploads.
if (typeof globalThis.File === 'undefined') {
  globalThis.File = require('node:buffer').File;
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET missing from .env');

// Load and index synthetic dataset at startup for local-dev Groq fallback
let KSP_FIRS = []; // array of { header, text } blocks
try {
  const datasetPath = path.resolve(__dirname, 'synthetic_ksp_data.txt');
  const raw = fs.readFileSync(datasetPath, 'utf8');
  // Split on FIR boundary lines
  KSP_FIRS = raw.split(/\n(?=FIR Number:)/).map(block => block.trim()).filter(Boolean);
  console.log(`[KNOWHERE] Indexed ${KSP_FIRS.length} FIR records from dataset`);
} catch {
  console.warn('[KNOWHERE] synthetic_ksp_data.txt not found — Groq fallback will have no dataset context');
}

// Simple keyword retrieval: score each FIR block against query terms, return top N
function retrieveRelevantFIRs(query, topN = 8) {
  if (!KSP_FIRS.length) return '';
  const terms = query.toLowerCase().split(/\W+/).filter(t => t.length > 2);
  const scored = KSP_FIRS.map(block => {
    const lower = block.toLowerCase();
    const score = terms.reduce((s, t) => s + (lower.split(t).length - 1), 0);
    return { block, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topN).filter(x => x.score > 0);
  // If nothing matched, return a broad sample so the model knows the schema
  const results = top.length ? top : scored.slice(0, 3);
  return results.map(x => x.block).join('\n\n---\n\n');
}

// The KSP dataset is English/Latin-script only, so keyword retrieval above can't
// match Kannada/Hindi/etc. queries. For non-Latin queries, do a cheap translation
// pass first so retrieval searches on English terms (district names, locations, ...).
const hasNonLatin = (text) => /[^\x00-\x7F]/.test(text);

async function translateToEnglish(groq, text) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: 'Translate the user message to English. Use current official Karnataka district names (Bengaluru, Mysuru, Mangaluru, Kalaburagi, Belagavi, Hubballi-Dharwad, Tumakuru, Ballari, Shivamogga, Vijayapura), not older British-era names (Bangalore, Mysore, Mangalore, Gulbarga, Belgaum, Hubli, Tumkur, Bellary, Shimoga, Bijapur). Reply with ONLY the translation, no commentary.' },
        { role: 'user', content: text },
      ],
      temperature: 0,
      max_tokens: 200,
    });
    return completion.choices[0]?.message?.content?.trim() || text;
  } catch {
    return text;
  }
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.text({ type: 'text/plain', limit: '10mb' }));
// Browsers only send a CORS preflight (OPTIONS) for "non-simple" requests —
// Catalyst's gateway answers OPTIONS itself without forwarding to this function,
// so the frontend avoids preflight entirely by posting JSON as text/plain.
app.use((req, res, next) => {
  if (typeof req.body === 'string' && req.body) {
    try { req.body = JSON.parse(req.body); } catch { req.body = {}; }
  }
  next();
});

// When run directly with `node index.js`, accept the same
// /server/<function>/ prefixed paths that `catalyst serve` exposes,
// so the frontend proxy works identically in both run modes.
const FN_PREFIX = '/server/ksp_datathon_2026_function';
app.use((req, res, next) => {
  if (req.url.startsWith(FN_PREFIX)) {
    req.url = req.url.slice(FN_PREFIX.length) || '/';
  }
  next();
});

// ─── MOCK USERS (replace with Catalyst Auth later) ────────────────────────────
const USERS = {
  'investigator@ksp.gov.in': { password: 'inv123', role: 'investigator', name: 'Rajesh Kumar' },
  'analyst@ksp.gov.in':      { password: 'ana123', role: 'analyst',      name: 'Priya Sharma' },
  'supervisor@ksp.gov.in':   { password: 'sup123', role: 'supervisor',   name: 'DCP Mohan Rao' },
};

// ─── ROLE PERMISSIONS ─────────────────────────────────────────────────────────
const ROLE_PERMISSIONS = {
  investigator: ['query_fir', 'query_accused', 'query_victim', 'query_location'],
  analyst:      ['query_fir', 'query_accused', 'query_victim', 'query_location', 'query_trends', 'query_hotspots'],
  supervisor:   ['query_fir', 'query_accused', 'query_victim', 'query_location', 'query_trends', 'query_hotspots', 'query_network', 'query_financial'],
};

// ─── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token || (req.body && req.body.token);
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const user = jwt.verify(token, JWT_SECRET);
    if (!USERS[user.email]) return res.status(401).json({ error: 'Invalid token' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── AUDIT LOG ────────────────────────────────────────────────────────────────
const auditLog = [];
function logAudit(user, action, query) {
  auditLog.push({
    timestamp: new Date().toISOString(),
    user: user.email,
    role: user.role,
    action,
    query: query || null,
  });
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'KNOWHERE API is running', version: '1.0.0' });
});

// GET /api/health — service + Groq connectivity check (public, no auth needed)
app.get('/api/health', async (req, res) => {
  const timestamp = new Date().toISOString();
  const dataset = PARSED_FIRS.length;

  let groqStatus;
  if (!process.env.GROQ_API_KEY) {
    groqStatus = 'missing_key';
  } else {
    try {
      // Lightweight authenticated GET — verifies the key without spending tokens
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      await groq.models.list();
      groqStatus = 'connected';
    } catch (err) {
      console.warn('[HEALTH] Groq check failed:', err?.status, err?.message);
      groqStatus = 'invalid_key';
    }
  }

  const status = groqStatus === 'connected' && dataset > 0 ? 'ok' : 'error';
  res.json({ status, groq: groqStatus, dataset, timestamp });
});

// POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  const user = USERS[email];
  if (!user || user.password !== password)
    return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '24h' });

  logAudit({ email, role: user.role }, 'LOGIN');
  res.json({ token, role: user.role, name: user.name, permissions: ROLE_PERMISSIONS[user.role] });
});

// POST /api/chat  — proxies to Catalyst QuickML RAG
app.post('/api/chat', authMiddleware, async (req, res) => {
  const { query, conversationHistory, language, detectedLanguage } = req.body;

  if (!query) return res.status(400).json({ error: 'Query is required' });

  const auditEntry = {
    user: req.user.email, role: req.user.role, action: 'QUERY', query,
    timestamp: new Date().toISOString(),
  };

  // ── Primary path: Catalyst QuickML Knowledge Base (managed RAG over the FIR
  //    docs). Falls through to the Groq + Data Store path on any failure. ──
  if (quickmlRag.isConfigured()) {
    try {
      const answer = await quickmlRag.answerFromKB(query);
      logAudit(req.user, 'QUERY', query);
      try { store.insertAudit(catalyst.initialize(req), auditEntry); } catch { /* best-effort */ }
      return res.json({ answer, query, role: req.user.role, timestamp: new Date().toISOString(), retrieval: 'quickml-kb' });
    } catch (kbErr) {
      console.error('QuickML RAG unavailable, falling back:', kbErr?.message);
    }
  }

  // No Groq key → answer straight from the parsed FIRs (offline mode).
  if (!process.env.GROQ_API_KEY) {
    logAudit(req.user, 'QUERY', query);
    return res.json({
      answer: buildDemoAnswer(query),
      query, role: req.user.role, timestamp: new Date().toISOString(), demo: true,
    });
  }

  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const retrievalQuery = hasNonLatin(query) ? await translateToEnglish(groq, query) : query;

    // ── Retrieval: Catalyst Data Store (ZCQL candidates + keyword re-rank),
    //    with an in-memory fallback so chat works before the tables exist. ──
    let relevantFIRs;
    let retrievalSource = 'in-memory';
    try {
      const catalystApp = catalyst.initialize(req);
      relevantFIRs = await store.retrieveFIRContext(catalystApp, retrievalQuery);
      retrievalSource = 'catalyst-datastore';
      store.insertAudit(catalystApp, auditEntry); // best-effort; never throws
    } catch {
      relevantFIRs = retrieveRelevantFIRs(retrievalQuery);
    }

    const systemPrompt = `You are KNOWHERE, an intelligent crime analytics assistant for Karnataka State Police.
The user is a ${req.user.role} named ${req.user.name}.
Their permissions are: ${ROLE_PERMISSIONS[req.user.role].join(', ')}.
Only answer questions within their permitted scope.
Always cite the FIR number, district, police station, or accused name from the data in your response.
${detectedLanguage ? `The user spoke in ${detectedLanguage}. Respond in the same language.` : 'If the user writes in Kannada, respond in Kannada. Otherwise respond in English.'}
Be precise, professional, and factual. Never speculate beyond the data.
Answer only from the KSP crime records shown below.

=== RETRIEVED KSP CRIME RECORDS ===
${relevantFIRs}
=== END OF RECORDS ===`;

    const messages = [{ role: 'system', content: systemPrompt }];
    if (Array.isArray(conversationHistory)) {
      for (const m of conversationHistory.slice(-6)) {
        messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text });
      }
    }
    messages.push({ role: 'user', content: query });

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.2,
      max_tokens: 1024,
    });

    const answer = completion.choices[0]?.message?.content || 'No response from model.';
    logAudit(req.user, 'QUERY', query);
    return res.json({ answer, query, role: req.user.role, timestamp: new Date().toISOString(), retrieval: retrievalSource });
  } catch (groqErr) {
    console.error('Chat generation error:', groqErr?.message);
    // Groq unreachable (e.g. expired key) — answer from the parsed FIRs so chat
    // never dead-ends for the officer.
    logAudit(req.user, 'QUERY', query);
    return res.json({
      answer: buildDemoAnswer(query),
      query, role: req.user.role, timestamp: new Date().toISOString(), demo: true,
    });
  }
});

// GET /api/chat/history  — returns audit log for current user
app.get('/api/chat/history', authMiddleware, (req, res) => {
  const userLogs = auditLog.filter(log => log.user === req.user.email && log.action === 'QUERY');
  res.json({ history: userLogs });
});

// GET /api/audit  — supervisors only
app.get('/api/audit', authMiddleware, async (req, res) => {
  if (req.user.role !== 'supervisor')
    return res.status(403).json({ error: 'Access denied. Supervisors only.' });
  // Prefer the durable Catalyst Data Store audit trail; fall back to the
  // in-memory log if the AuditLog table isn't provisioned yet.
  try {
    const logs = await store.readAudit(catalyst.initialize(req));
    return res.json({ logs, source: 'catalyst-datastore' });
  } catch {
    return res.json({ logs: auditLog, source: 'in-memory' });
  }
});

// GET /api/roles  — returns role info
app.get('/api/roles', (req, res) => {
  res.json({ roles: Object.keys(ROLE_PERMISSIONS), permissions: ROLE_PERMISSIONS });
});

// ─── DATASET PARSING & DERIVED INTELLIGENCE DATA ─────────────────────────────

const MONTHS = { January:0,February:1,March:2,April:3,May:4,June:5,July:6,August:7,September:8,October:9,November:10,December:11 };

// Dataset district names → heatmap tile names
const DISTRICT_ALIAS = { 'Mangaluru': 'Dakshina Kannada', 'Hubballi-Dharwad': 'Dharwad' };

const ALL_KA_DISTRICTS = [
  'Bagalkote','Ballari','Belagavi','Bengaluru Rural','Bengaluru Urban','Bidar',
  'Chamarajanagara','Chikkaballapura','Chikkamagaluru','Chitradurga','Dakshina Kannada',
  'Davanagere','Dharwad','Gadag','Hassan','Haveri','Kalaburagi','Kodagu','Kolar',
  'Koppal','Mandya','Mysuru','Raichur','Ramanagara','Shivamogga','Tumakuru','Udupi',
  'Uttara Kannada','Vijayanagara','Vijayapura','Yadgir',
];

function parseDate(str) {
  const m = str.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (!m || MONTHS[m[2]] === undefined) return null;
  return new Date(+m[3], MONTHS[m[2]], +m[1]).toISOString().slice(0, 10);
}

function parseFIRs(blocks) {
  const firs = [];
  for (const block of blocks) {
    if (!block.startsWith('FIR Number:')) continue;
    const line = (field) => {
      const re = new RegExp(`^${field}:\\s*(.+)$`, 'm');
      const m = block.match(re);
      return m ? m[1].trim() : '';
    };
    const number = line('FIR Number');
    if (!number.startsWith('KSP/')) continue;

    const districtRaw = line('District');
    const districtPrimary = districtRaw.replace(/\s*[\(;—].*/, '').trim();
    const district = DISTRICT_ALIAS[districtPrimary] || districtPrimary;

    const crimeTypeRaw = line('Crime Type');
    const crimeType = crimeTypeRaw.replace(/\s*[\(—].*/, '').trim();

    const accusedRaw = line('Accused Name\\(s\\)');
    const accused = accusedRaw.split(/[,;]/)
      .map(a => a.replace(/\s*\([^)]*\)/g, '').trim())
      .filter(a => a.length > 2 && !['N/A','Unknown','International','Five accused','Seven accused','online'].some(x => a.toLowerCase().includes(x.toLowerCase())));

    const statusRaw = line('Status');
    const isOpen = /^Open/i.test(statusRaw);
    let eventType = 'fir';
    if (/convicted/i.test(statusRaw)) eventType = 'court';
    else if (/arrested|in custody/i.test(statusRaw) && !/at large|absconding/i.test(statusRaw)) eventType = 'arrest';

    firs.push({
      number,
      date: line('Date'),
      dateISO: parseDate(line('Date')),
      station: line('Police Station').replace(/\s*\(.*/, '').trim(),
      district,
      crimeType,
      accused,
      victim: line('Victim Name'),
      location: line('Location of Incident'),
      status: statusRaw,
      isOpen,
      officer: line('Assigned Officer'),
      eventType,
      isCrossDistrict: /cross-district/i.test(districtRaw),
      isBlackCobra: /black cobra/i.test(block),
    });
  }
  return firs;
}

function buildHeatmap(firs) {
  const byDist = {};
  for (const fir of firs) {
    if (!byDist[fir.district]) byDist[fir.district] = { open: 0, total: 0, crimes: {} };
    byDist[fir.district].total++;
    if (fir.isOpen) byDist[fir.district].open++;
    byDist[fir.district].crimes[fir.crimeType] = (byDist[fir.district].crimes[fir.crimeType] || 0) + 1;
  }
  const result = Object.entries(byDist).map(([district, d]) => {
    const topCrime = Object.entries(d.crimes).sort((a,b) => b[1]-a[1])[0]?.[0] || '—';
    const level = d.open >= 5 ? 'critical' : d.open >= 3 ? 'elevated' : d.open >= 1 ? 'normal' : 'nodata';
    const trend = d.open > d.total * 0.6 ? 'up' : d.open < d.total * 0.3 ? 'down' : 'flat';
    return { district, level, activeFirs: d.open, topCrime, trend };
  });
  const covered = new Set(result.map(r => r.district));
  for (const d of ALL_KA_DISTRICTS) {
    if (!covered.has(d)) result.push({ district: d, level: 'nodata', activeFirs: 0, topCrime: '—', trend: 'flat' });
  }
  return result;
}

function buildTimeline(firs) {
  return firs
    .filter(f => f.dateISO)
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO))
    .map((fir, i) => {
      const accusedStr = fir.accused.length
        ? fir.accused.slice(0, 2).join(', ') + (fir.accused.length > 2 ? ` +${fir.accused.length - 2} more` : '')
        : 'Unknown';
      const victimPart = fir.victim && fir.victim !== 'N/A' ? ` Victim: ${fir.victim.split('(')[0].trim()}.` : '';
      return {
        id: i + 1,
        type: fir.eventType,
        date: `${fir.dateISO}T09:00`,
        district: fir.district,
        ps: fir.station,
        fir: fir.number,
        officer: fir.officer,
        description: `${fir.crimeType} — Accused: ${accusedStr}.${victimPart} ${fir.status.split('—')[0].trim()}.`,
      };
    });
}

function buildNetwork(firs) {
  const accusedCount = {};
  for (const fir of firs) {
    for (const acc of fir.accused) accusedCount[acc] = (accusedCount[acc] || 0) + 1;
  }
  const repeatOffenders = new Set(Object.entries(accusedCount).filter(([,c]) => c >= 2).map(([n]) => n));

  // All FIRs that touch a repeat offender
  const linkedFIRs = firs.filter(f => f.accused.some(a => repeatOffenders.has(a)));

  // All accused appearing in those FIRs (no cap — show full gang networks)
  const featuredAccused = new Set(linkedFIRs.flatMap(f => f.accused));

  const nodes = [];
  const accId = {}, incId = {}, vicId = {}, locId = {};

  // ── Accused nodes with richer role labels ───────────────────────────────────
  for (const acc of featuredAccused) {
    const id = `A_${acc.replace(/\W+/g, '_')}`;
    accId[acc] = id;
    const firList = firs.filter(f => f.accused.includes(acc));
    const firNumbers = firList.map(f => f.number);
    const lastFir = [...firList].sort((a,b) => (b.dateISO||'').localeCompare(a.dateISO||''))[0];
    const allStatus = firList.map(f => f.status).join(' ');
    let role;
    if (repeatOffenders.has(acc)) {
      role = `Repeat Offender — ${accusedCount[acc]} FIR${accusedCount[acc]>1?'s':''}`;
    } else if (/absconding|at large|wanted/i.test(allStatus)) {
      role = 'Accused — Absconding';
    } else if (/convicted/i.test(allStatus)) {
      role = 'Accused — Convicted';
    } else if (/arrested|in custody|chargesheet/i.test(allStatus)) {
      role = 'Accused — In Custody';
    } else {
      role = 'Accused';
    }
    nodes.push({ id, label: acc, type: 'accused', detail: {
      role, cases: firNumbers,
      lastSeen: lastFir?.dateISO || '—',
      location: lastFir?.district || '—',
    }});
  }

  // ── Incident + Victim + Location nodes ──────────────────────────────────────
  for (const fir of linkedFIRs) {
    const iid = `I_${fir.number.replace(/\W+/g, '_')}`;
    incId[fir.number] = iid;
    const short = fir.number.split('/').slice(-2).join('/');
    nodes.push({ id: iid, label: short, type: 'incident', detail: {
      role: `${fir.crimeType} — ${fir.station}`,
      cases: [fir.number], lastSeen: fir.dateISO || '—', location: fir.district,
    }});

    // Victim node (max 14, skip N/A / institutional)
    const rawVic = fir.victim?.replace(/\s*\([^)]*\)/g, '').split(',')[0].trim() || '';
    if (rawVic && rawVic !== 'N/A' && rawVic.length > 2 && !/institutional|cooperative bank/i.test(rawVic) && !vicId[rawVic] && Object.keys(vicId).length < 14) {
      const vid = `V_${rawVic.replace(/\W+/g, '_').slice(0, 20)}`;
      vicId[rawVic] = vid;
      nodes.push({ id: vid, label: rawVic.split(' ').slice(0, 3).join(' '), type: 'victim', detail: {
        role: `Victim — ${fir.crimeType}`, cases: [fir.number], lastSeen: '—', location: fir.district,
      }});
    }

    // Location node — extract first named place, de-dupe by district+crimeType (max 12)
    if (fir.location && Object.keys(locId).length < 12) {
      const locKey = `${fir.district}|${fir.crimeType}`;
      if (!locId[locKey]) {
        const label = fir.location.split(/,\s*(?:near|opposite|behind|adjacent)/i)[0]
          .split(',')[0].trim().slice(0, 28);
        const lid = `L_${fir.number.replace(/\W+/g, '_')}`;
        locId[locKey] = lid;
        nodes.push({ id: lid, label, type: 'location', detail: {
          role: `Crime scene — ${fir.district}`,
          cases: [fir.number], lastSeen: '—', location: fir.district,
        }});
      }
    }
  }

  // ── Edges ────────────────────────────────────────────────────────────────────
  const edges = [];
  const edgeSet = new Set();
  const addEdge = (s, t) => {
    const k = `${s}→${t}`;
    if (!edgeSet.has(k) && s !== t) { edgeSet.add(k); edges.push({ source: s, target: t }); }
  };

  for (const fir of linkedFIRs) {
    const iid = incId[fir.number];
    if (!iid) continue;

    const linked = fir.accused.filter(a => accId[a]);

    // Accused → Incident
    for (const acc of linked) addEdge(accId[acc], iid);

    // Accused ↔ Accused (co-accused direct edges — reveals gang / network clusters)
    for (let i = 0; i < linked.length; i++) {
      for (let j = i + 1; j < linked.length; j++) {
        addEdge(accId[linked[i]], accId[linked[j]]);
      }
    }

    // Incident → Victim
    const cleanVic = fir.victim?.replace(/\s*\([^)]*\)/g, '').split(',')[0].trim() || '';
    if (vicId[cleanVic]) addEdge(iid, vicId[cleanVic]);

    // Incident → Location
    const locKey = `${fir.district}|${fir.crimeType}`;
    if (locId[locKey]) addEdge(iid, locId[locKey]);
  }

  return { nodes, edges };
}

function buildAlerts(firs) {
  const alerts = [];
  let id = 1;

  // Active repeat offenders
  const openCount = {};
  for (const fir of firs) if (fir.isOpen) for (const a of fir.accused) openCount[a] = (openCount[a] || 0) + 1;
  const activeRepeat = Object.entries(openCount).filter(([,c]) => c >= 2);
  if (activeRepeat.length) alerts.push({ id: id++, severity: 'critical', district: 'Multi-district', type: 'Repeat Offenders', message: `${activeRepeat.length} repeat offenders have open active cases`, change: `+${activeRepeat.length}`, minutesAgo: 12 });

  // Black Cobra gang
  const bcOpen = firs.filter(f => f.isBlackCobra && f.isOpen);
  if (bcOpen.length) alerts.push({ id: id++, severity: 'critical', district: [...new Set(bcOpen.map(f=>f.district))].join(' / '), type: 'Gang Activity', message: `Black Cobra syndicate: ${bcOpen.length} active case${bcOpen.length>1?'s':''} open`, change: 'ACTIVE', minutesAgo: 34 });

  // Cross-district open
  const crossOpen = firs.filter(f => f.isCrossDistrict && f.isOpen);
  if (crossOpen.length) alerts.push({ id: id++, severity: 'warning', district: 'Cross-district', type: 'Cross-District', message: `${crossOpen.length} cross-district case${crossOpen.length>1?'s':''} under active investigation`, change: `×${crossOpen.length}`, minutesAgo: 58 });

  // Top 2 highest open-FIR districts
  const distOpen = {};
  for (const fir of firs) if (fir.isOpen) distOpen[fir.district] = (distOpen[fir.district] || 0) + 1;
  Object.entries(distOpen).sort((a,b)=>b[1]-a[1]).slice(0,2).forEach(([dist,cnt]) => {
    alerts.push({ id: id++, severity: cnt>=5?'critical':'warning', district: dist, type: 'Active FIR Surge', message: `${dist}: ${cnt} open FIR${cnt>1?'s':''} — priority monitoring required`, change: `${cnt} open`, minutesAgo: 45 + id*8 });
  });

  // Drug trafficking
  const drugOpen = firs.filter(f => f.crimeType === 'Drug Trafficking' && f.isOpen);
  if (drugOpen.length) alerts.push({ id: id++, severity: 'warning', district: [...new Set(drugOpen.map(f=>f.district))].slice(0,2).join(' / '), type: 'Narcotics', message: `${drugOpen.length} open drug trafficking cases across ${new Set(drugOpen.map(f=>f.district)).size} districts`, change: `${drugOpen.length} active`, minutesAgo: 87 });

  // High-risk open (Murder/Kidnapping)
  const highRisk = firs.filter(f => f.isOpen && ['Murder','Kidnapping'].includes(f.crimeType));
  if (highRisk.length) alerts.push({ id: id++, severity: 'critical', district: highRisk[0].district, type: 'High-Risk Open', message: `${highRisk.length} open murder/kidnapping case${highRisk.length>1?'s':''} — accused at large`, change: 'HIGH', minutesAgo: 112 });

  // Cybercrime
  const cyberOpen = firs.filter(f => f.crimeType === 'Cybercrime' && f.isOpen);
  if (cyberOpen.length) alerts.push({ id: id++, severity: 'warning', district: 'Multi-district', type: 'Cybercrime', message: `${cyberOpen.length} open cybercrime cases across ${new Set(cyberOpen.map(f=>f.district)).size} districts`, change: `+${cyberOpen.length}`, minutesAgo: 143 });

  // Closed cases — positive note
  const resolved2026 = firs.filter(f => !f.isOpen && f.dateISO >= '2026-01-01').length;
  if (resolved2026) alerts.push({ id: id++, severity: 'normal', district: 'State-wide', type: 'Cases Resolved', message: `${resolved2026} case${resolved2026>1?'s':''} successfully closed in 2026`, change: `-${resolved2026}`, minutesAgo: 203 });

  // Dedup near-duplicate alerts — e.g. two districts each with the same open-FIR
  // count would otherwise surface as two identical-looking "Active FIR Surge" rows.
  // Key on category + magnitude so genuinely distinct alerts are preserved, then
  // renumber ids so they stay contiguous after any drops.
  const seen = new Set();
  return alerts
    .filter(a => {
      const key = `${a.type}|${a.change}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 10)
    .map((a, i) => ({ ...a, id: i + 1 }));
}

// Build all intelligence data from the parsed FIRs
const PARSED_FIRS   = parseFIRs(KSP_FIRS);
let NETWORK_DATA    = buildNetwork(PARSED_FIRS);
let ALERTS          = buildAlerts(PARSED_FIRS);
let TIMELINE_EVENTS = buildTimeline(PARSED_FIRS);
let HEATMAP         = buildHeatmap(PARSED_FIRS);
console.log(`[KNOWHERE] Built intelligence data — ${PARSED_FIRS.length} FIRs · ${NETWORK_DATA.nodes.length} network nodes · ${TIMELINE_EVENTS.length} timeline events · ${ALERTS.length} alerts`);

// ─── OFFLINE ANSWER BUILDER ──────────────────────────────────────────────────
// Keyword-matches the structured PARSED_FIRS and formats an intelligent, cited
// response so /api/chat still returns real intelligence when both Catalyst RAG
// and Groq are unavailable (e.g. an expired GROQ_API_KEY).
function buildDemoAnswer(query) {
  const terms = (query || '').toLowerCase().split(/\W+/).filter(t => t.length > 2);
  const searchable = (f) => [
    f.number, f.district, f.station, f.crimeType, f.victim,
    f.location, f.status, f.officer, ...f.accused,
  ].join(' ').toLowerCase();

  const scored = PARSED_FIRS
    .map(f => {
      const hay = searchable(f);
      const score = terms.reduce((s, t) => s + (hay.split(t).length - 1), 0);
      return { f, score };
    })
    .sort((a, b) => b.score - a.score);

  const top = scored.filter(x => x.score > 0).slice(0, 3);
  const header = `**KNOWHERE — Offline Intelligence Mode**\n_(Live AI model unavailable; answering directly from ${PARSED_FIRS.length} indexed KSP FIR records.)_`;

  if (!top.length) {
    const openCount = PARSED_FIRS.filter(f => f.isOpen).length;
    const districts = [...new Set(PARSED_FIRS.map(f => f.district))];
    const crimeTypes = [...new Set(PARSED_FIRS.map(f => f.crimeType))];
    return `${header}\n\nI could not match your query to specific FIRs, but here is the current dataset overview:\n\n• **${PARSED_FIRS.length} FIRs** on record — **${openCount} open**, ${PARSED_FIRS.length - openCount} closed.\n• Coverage across **${districts.length} districts**: ${districts.join(', ')}.\n• Crime categories: ${crimeTypes.join(', ')}.\n\nTry naming a district (e.g. "Bengaluru Urban"), a crime type (e.g. "drug trafficking"), an FIR number, or an accused name.`;
  }

  const blocks = top.map(({ f }, i) => {
    const accused = f.accused.length ? f.accused.join(', ') : 'Not named';
    const victim = f.victim && f.victim !== 'N/A' ? f.victim.split('(')[0].trim() : '—';
    return `**${i + 1}. FIR ${f.number}** — ${f.crimeType}\n   • District / Station: ${f.district} · ${f.station}\n   • Date: ${f.date || '—'}  |  Status: ${f.status.split('—')[0].trim()}\n   • Accused: ${accused}\n   • Victim: ${victim}\n   • Location: ${f.location || '—'}\n   • Investigating Officer: ${f.officer || '—'}`;
  }).join('\n\n');

  return `${header}\n\nTop ${top.length} matching record${top.length > 1 ? 's' : ''} for "${query}":\n\n${blocks}\n\n_Cite these FIR numbers in your report. Ask a follow-up to narrow by district, crime type, or accused._`;
}

// ─── DEMO CASE BRIEF (references real repeat offenders from dataset) ──────────
const topAccused = Object.entries(
  PARSED_FIRS.flatMap(f=>f.accused).reduce((acc,a)=>{acc[a]=(acc[a]||0)+1;return acc;},{})
).sort((a,b)=>b[1]-a[1]).slice(0,4);

const DEMO_CASE_BRIEF = {
  overview: `KSP Synthetic Intelligence Dataset covers 50 FIRs filed between January 2025 and June 2026 across 10 Karnataka districts. ${PARSED_FIRS.filter(f=>!f.isOpen).length} cases are closed; ${PARSED_FIRS.filter(f=>f.isOpen).length} remain open. Notable patterns include the Black Cobra extortion syndicate (3 FIRs across Bengaluru Urban, Hubballi-Dharwad and Mangaluru), ${topAccused.length} repeat offenders appearing in multiple cases, and 2 active cross-district investigations.`,
  personsOfInterest: topAccused.map(([name, count]) => {
    const firNums = PARSED_FIRS.filter(f=>f.accused.includes(name)).map(f=>f.number);
    const lastFir = PARSED_FIRS.filter(f=>f.accused.includes(name)).sort((a,b)=>(b.dateISO||'').localeCompare(a.dateISO||''))[0];
    return { name, role: `Repeat Offender — ${count} FIR${count>1?'s':''}`, status: lastFir?.isOpen ? `Open case — ${lastFir.district}` : `Last case closed — ${lastFir?.district}` };
  }),
  timeline: PARSED_FIRS.filter(f=>f.dateISO).sort((a,b)=>b.dateISO.localeCompare(a.dateISO)).slice(0,5).map(f=>({ date: f.date, event: `${f.crimeType} (${f.number}) — ${f.district}. ${f.status.split('—')[0].trim()}.` })),
  leads: [
    `${PARSED_FIRS.filter(f=>f.isOpen && f.crimeType==='Drug Trafficking').length} open drug trafficking cases — coordinate with NCB for inter-state network analysis`,
    `Black Cobra gang: Khalid Ibrahim absconding across 3 districts — escalate to SIT`,
    `${PARSED_FIRS.filter(f=>f.isCrossDistrict).length} cross-district cases require unified case management`,
    `Pradeep Kumar Shetty (3 drug FIRs, absconding) — red corner notice recommended`,
  ],
  firNumbers: PARSED_FIRS.filter(f=>f.isBlackCobra).map(f=>`${f.number} (${f.station})`),
  riskAssessment: `HIGH — ${PARSED_FIRS.filter(f=>f.isOpen&&['Murder','Kidnapping'].includes(f.crimeType)).length} open murder/kidnapping cases with accused at large. ${activeRepeatCount()} repeat offenders active across multiple districts. Black Cobra syndicate expanding into coastal extortion. Recommend enhanced inter-district coordination.`,
};

function activeRepeatCount() {
  const oc = {};
  for (const f of PARSED_FIRS) if (f.isOpen) for (const a of f.accused) oc[a]=(oc[a]||0)+1;
  return Object.values(oc).filter(c=>c>=2).length;
}

// GET /api/network?query= — criminal network graph data
app.get('/api/network', authMiddleware, (req, res) => {
  logAudit(req.user, 'NETWORK_VIEW', req.query.query);
  const q = (req.query.query || '').toLowerCase().trim();
  if (!q) return res.json(NETWORK_DATA);

  const ids = new Set(
    NETWORK_DATA.nodes
      .filter(n => n.label.toLowerCase().includes(q) || (n.detail.location || '').toLowerCase().includes(q))
      .map(n => n.id)
  );
  // include direct neighbours of matched nodes
  NETWORK_DATA.edges.forEach(e => {
    if (ids.has(e.source)) ids.add(e.target);
    else if (ids.has(e.target)) ids.add(e.source);
  });
  res.json({
    nodes: NETWORK_DATA.nodes.filter(n => ids.has(n.id)),
    edges: NETWORK_DATA.edges.filter(e => ids.has(e.source) && ids.has(e.target)),
  });
});

// GET /api/alerts — anomaly alert feed
app.get('/api/alerts', authMiddleware, async (req, res) => {
  // Prefer alerts computed server-side by the Cron job and stored in Data Store;
  // fall back to the on-the-fly computed set until the Cron job has populated it.
  try {
    const alerts = await store.readAlerts(catalyst.initialize(req));
    return res.json({ alerts, generatedAt: new Date().toISOString(), source: 'catalyst-datastore' });
  } catch {
    return res.json({ alerts: ALERTS, generatedAt: new Date().toISOString(), source: 'computed' });
  }
});

// GET /api/timeline?case= — investigative timeline events
app.get('/api/timeline', authMiddleware, (req, res) => {
  logAudit(req.user, 'TIMELINE_VIEW', req.query.case);
  res.json({
    caseId: req.query.case || 'KSP-2026-OPS-0047',
    codename: 'OPERATION SAHYADRI',
    events: TIMELINE_EVENTS,
  });
});

// GET /api/heatmap — district threat levels
app.get('/api/heatmap', authMiddleware, (req, res) => {
  res.json({ districts: HEATMAP, updatedAt: new Date().toISOString() });
});

// Server-side case-brief HTML (KSP letterhead) — rendered to PDF by SmartBrowz.
function escapeHtml(str = '') {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Convert the LLM's Markdown brief to clean HTML (headings, bold, lists) so the
// PDF doesn't show raw ## / ** markers.
function mdToHtmlBlock(text) {
  const inline = (t) => escapeHtml(t)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
  let html = '';
  let inList = false;
  for (const line of String(text || '').split('\n')) {
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (bullet || numbered) {
      if (!inList) { html += '<ul class="mdl">'; inList = true; }
      html += `<li>${inline((bullet || numbered)[1])}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (line.trim() === '') continue;
    if (heading) html += `<h3 class="mdh">${inline(heading[1])}</h3>`;
    else html += `<p class="mdp">${inline(line)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

function buildCaseBriefHtml(data, user) {
  const s = data.sections;
  const generated = new Date(data.generatedAt || Date.now());
  const body = data.raw
    ? `<div class="sec">${mdToHtmlBlock(data.raw)}</div>`
    : `
      <div class="sec"><h2>CASE OVERVIEW</h2><div class="prose">${escapeHtml(s.overview)}</div></div>
      <div class="sec"><h2>PERSONS OF INTEREST</h2>
        <table><thead><tr><th>Name</th><th>Role</th><th>Status</th></tr></thead><tbody>
        ${s.personsOfInterest.map(p => `<tr><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.role)}</td><td>${escapeHtml(p.status)}</td></tr>`).join('')}
        </tbody></table>
      </div>
      <div class="sec"><h2>TIMELINE OF EVENTS</h2>
        <table><thead><tr><th>Date</th><th>Event</th></tr></thead><tbody>
        ${s.timeline.map(t => `<tr><td class="nowrap">${escapeHtml(t.date)}</td><td>${escapeHtml(t.event)}</td></tr>`).join('')}
        </tbody></table>
      </div>
      <div class="sec"><h2>RECOMMENDED LEADS</h2>
        <ol>${s.leads.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ol>
      </div>
      <div class="sec"><h2>RELATED FIR NUMBERS</h2>
        <p class="firs">${s.firNumbers.map(f => `<span>${escapeHtml(f)}</span>`).join('')}</p>
      </div>
      <div class="sec"><h2>RISK ASSESSMENT</h2><div class="risk">${escapeHtml(s.riskAssessment)}</div></div>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<title>KNOWHERE Case Brief — ${escapeHtml(data.caseId || '')}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a2e; padding: 20px 26px; position: relative; }
  .watermark { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 0; }
  .watermark span { transform: rotate(-32deg); font-family: Arial, sans-serif; font-size: 42px; font-weight: 800;
    color: rgba(220, 38, 38, 0.13); letter-spacing: 4px; text-align: center; line-height: 1.6;
    border: 4px solid rgba(220, 38, 38, 0.13); padding: 14px 30px; border-radius: 8px; }
  .content { position: relative; z-index: 1; }
  .letterhead { display: flex; align-items: center; justify-content: space-between; border-bottom: 3px double #1e3a8a; padding-bottom: 14px; }
  .lh-left { display: flex; align-items: center; gap: 14px; }
  .shield { width: 46px; height: 54px; background: linear-gradient(160deg, #0ea5e9, #1e3a8a);
    clip-path: polygon(50% 0%, 100% 16%, 100% 56%, 50% 100%, 0% 56%, 0% 16%);
    display: flex; align-items: center; justify-content: center; color: #fff; font-family: Arial, sans-serif; font-weight: 800; font-size: 11px; }
  .lh-org { font-family: Arial, sans-serif; }
  .lh-org b { font-size: 15px; letter-spacing: 1px; color: #1e3a8a; display: block; }
  .lh-org span { font-size: 10px; color: #555; letter-spacing: 2px; text-transform: uppercase; }
  .lh-right { text-align: right; font-family: Arial, sans-serif; }
  .lh-right .wordmark { font-size: 17px; font-weight: 800; letter-spacing: 5px; color: #0e7490; }
  .lh-right .cls-stamp { display: inline-block; margin-top: 6px; border: 2px solid #b91c1c; color: #b91c1c;
    font-size: 10px; font-weight: 800; letter-spacing: 3px; padding: 3px 10px; transform: rotate(-3deg); }
  .meta { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 6px;
    font-family: Arial, sans-serif; font-size: 10.5px; color: #444; padding: 10px 0 4px; border-bottom: 1px solid #ccc; }
  .meta b { color: #111; }
  h1 { font-family: Arial, sans-serif; font-size: 19px; letter-spacing: 2px; color: #1e3a8a; margin: 22px 0 2px; }
  .codename { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 3px; color: #b91c1c; font-weight: 700; margin-bottom: 14px; }
  .sec { margin-top: 20px; page-break-inside: avoid; }
  .sec h2 { font-family: Arial, sans-serif; font-size: 12px; letter-spacing: 2.5px; color: #0e7490; border-bottom: 1px solid #0e7490; padding-bottom: 3px; margin-bottom: 8px; }
  .prose { font-size: 13px; line-height: 1.75; text-align: justify; white-space: pre-wrap; }
  .mdh { font-family: Arial, sans-serif; font-size: 12px; letter-spacing: 2.5px; color: #0e7490; border-bottom: 1px solid #0e7490; padding-bottom: 3px; margin: 20px 0 8px; }
  .mdp { font-size: 13px; line-height: 1.7; text-align: justify; margin: 4px 0; }
  .mdl { padding-left: 22px; font-size: 13px; line-height: 1.7; margin: 4px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { font-family: Arial, sans-serif; font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; text-align: left; background: #eef2f7; color: #1e3a8a; padding: 6px 10px; border: 1px solid #c7d2e0; }
  td { padding: 6px 10px; border: 1px solid #c7d2e0; line-height: 1.5; }
  .nowrap { white-space: nowrap; }
  ol { padding-left: 22px; font-size: 13px; line-height: 1.8; }
  .firs span { display: inline-block; font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; border: 1px solid #1e3a8a; color: #1e3a8a; border-radius: 4px; padding: 2px 10px; margin: 0 8px 6px 0; }
  .risk { border-left: 4px solid #b91c1c; background: #fef2f2; padding: 10px 14px; font-size: 13px; line-height: 1.7; }
  footer { margin-top: 34px; border-top: 1px solid #ccc; padding-top: 8px; display: flex; justify-content: space-between; font-family: Arial, sans-serif; font-size: 9px; color: #888; letter-spacing: 1px; }
</style></head>
<body>
  <div class="watermark"><span>DEMO DATA<br/>NOT FOR OFFICIAL USE</span></div>
  <div class="content">
    <div class="letterhead">
      <div class="lh-left"><div class="shield">KSP</div>
        <div class="lh-org"><b>KARNATAKA STATE POLICE</b><span>Crime Intelligence Division</span></div>
      </div>
      <div class="lh-right"><div class="wordmark">KNOWHERE</div><div class="cls-stamp">CONFIDENTIAL</div></div>
    </div>
    <div class="meta">
      <span>OFFICER: <b>${escapeHtml(user.name)}</b> (${escapeHtml(String(user.role).toUpperCase())})</span>
      <span>CASE ID: <b>${escapeHtml(data.caseId || '—')}</b></span>
      <span>GENERATED: <b>${generated.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</b></span>
    </div>
    <h1>AUTO-GENERATED CASE BRIEF</h1>
    <div class="codename">${escapeHtml(data.codename || '')}</div>
    ${body}
    <footer>
      <span>KNOWHERE — AI-ASSISTED CRIME INTELLIGENCE · KSP DATATHON 2026</span>
      <span>RENDERED SERVER-SIDE BY CATALYST SMARTBROWZ</span>
    </footer>
  </div>
</body></html>`;
}

// POST /api/case-summary — case brief as a real PDF via Catalyst SmartBrowz.
// Content is generated by the LLM (falls back to a structured demo brief); the
// HTML is rendered to a downloadable PDF by SmartBrowz, with a JSON fallback so
// the feature still works if SmartBrowz isn't enabled on the plan.
app.post('/api/case-summary', authMiddleware, async (req, res) => {
  const { conversationHistory, language } = req.body;
  logAudit(req.user, 'CASE_SUMMARY');

  const convo = (conversationHistory || [])
    .map(m => `${m.role === 'user' ? 'Officer' : 'KNOWHERE'}: ${m.text}`)
    .join('\n');

  const prompt = `You are KNOWHERE, a crime analytics assistant for Karnataka State Police.
Generate a structured case brief from the following investigation conversation.
Use exactly these section headers: CASE OVERVIEW, PERSONS OF INTEREST, TIMELINE OF EVENTS, RECOMMENDED LEADS, RELATED FIR NUMBERS, RISK ASSESSMENT.
${language === 'kn' ? 'Respond in Kannada.' : 'Respond in English.'}
Be factual; cite FIR numbers where available.

Conversation:
${convo}`;

  const meta = {
    caseId: 'KSP-2026-OPS-0047',
    codename: 'OPERATION BLACK COBRA',
    officer: req.user.name,
    role: req.user.role,
    generatedAt: new Date().toISOString(),
  };

  // 1. Generate the brief content (LLM → free text; fallback → demo sections).
  let content = null;
  if (process.env.GROQ_API_KEY) {
    try {
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1500,
      });
      const text = completion.choices[0]?.message?.content?.trim();
      if (text) content = { demo: false, raw: text };
    } catch (e) {
      console.error('Case brief LLM error:', e?.message);
    }
  }
  if (!content) content = { demo: true, sections: DEMO_CASE_BRIEF };
  const briefData = { ...meta, ...content };

  // 2. Render to a real PDF via SmartBrowz; fall back to JSON if unavailable.
  try {
    const html = buildCaseBriefHtml(briefData, req.user);
    const catalystApp = catalyst.initialize(req);
    const pdfStream = await catalystApp.smartbrowz().convertToPdf(html, {
      pdf_options: { format: 'A4', print_background: true },
    });
    const chunks = [];
    for await (const chunk of pdfStream) chunks.push(chunk);
    const pdf = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="KNOWHERE-Case-Brief-${meta.caseId}.pdf"`);
    return res.send(pdf);
  } catch (err) {
    const emsg = err?.response?.data ? JSON.stringify(err.response.data) : err?.message;
    console.error('SmartBrowz PDF unavailable, returning JSON:', emsg);
    return res.json(briefData);
  }
});

// ─── VOICE TRANSCRIPTION (Groq Whisper) ───────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // Groq Whisper file limit
});

// Whisper returns ISO codes or language names depending on response shape —
// normalize both to BCP-47 for the chat language pipeline
const WHISPER_LANG_MAP = {
  kn: 'kn-IN', kannada: 'kn-IN',
  en: 'en-IN', english: 'en-IN',
  hi: 'hi-IN', hindi: 'hi-IN',
  ta: 'ta-IN', tamil: 'ta-IN',
  te: 'te-IN', telugu: 'te-IN',
  ml: 'ml-IN', malayalam: 'ml-IN',
};

// POST /api/transcribe — audio blob → Groq Whisper → transcript + language
app.post('/api/transcribe', authMiddleware, upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Audio file is required (field name: audio)' });
  if (!process.env.GROQ_API_KEY) {
    return res.status(503).json({ error: 'Transcription unavailable — GROQ_API_KEY not configured on server' });
  }

  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const transcription = await groq.audio.transcriptions.create({
      file: await Groq.toFile(req.file.buffer, req.file.originalname || 'recording.webm'),
      model: 'whisper-large-v3',
      response_format: 'verbose_json',
    });

    const transcript = (transcription.text || '').trim();
    const rawLang = String(transcription.language || '').toLowerCase();
    const detectedLanguage = WHISPER_LANG_MAP[rawLang] || 'en-IN';

    // mean segment probability as a rough confidence signal
    const segs = transcription.segments || [];
    const confidence = segs.length
      ? Math.round((segs.reduce((s, x) => s + Math.exp(x.avg_logprob ?? 0), 0) / segs.length) * 100) / 100
      : null;

    logAudit(req.user, 'VOICE_TRANSCRIBE', `${detectedLanguage} — ${transcript.slice(0, 80)}`);

    res.json({ transcript, detectedLanguage, confidence });
  } catch (err) {
    console.error('Transcription error:', err?.response?.data || err.message);
    res.status(502).json({ error: 'Transcription failed — check Groq API key and connectivity' });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
// `catalyst serve` requires this module and hosts the exported app itself;
// only bind a port when launched directly with `node index.js`
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`KNOWHERE API running on port ${PORT}`);
  });
}

module.exports = app;

// Exposed for tooling (Data Store seed generation, tests). Requiring this module
// never starts the server or makes network calls, so this is side-effect free.
module.exports.PARSED_FIRS = PARSED_FIRS;
module.exports.parseFIRs = parseFIRs;
