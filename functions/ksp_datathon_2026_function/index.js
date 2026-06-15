'use strict';

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Groq = require('groq-sdk');
const jwt = require('jsonwebtoken');
const catalyst = require('zcatalyst-sdk-node');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

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

const app = express();
app.use(cors());
app.use(express.json());

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
  const token = req.headers['x-auth-token'];
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

// POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  const user = USERS[email];
  if (!user || user.password !== password)
    return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '8h' });

  logAudit({ email, role: user.role }, 'LOGIN');
  res.json({ token, role: user.role, name: user.name, permissions: ROLE_PERMISSIONS[user.role] });
});

// POST /api/chat  — proxies to Catalyst QuickML RAG
app.post('/api/chat', authMiddleware, async (req, res) => {
  const { query, conversationHistory, language, detectedLanguage } = req.body;

  if (!query) return res.status(400).json({ error: 'Query is required' });

  // Language: voice detection is a hint; primary rule is always mirror the query language.
  const langHint = detectedLanguage ? ` The user's voice-detected language is ${detectedLanguage}.` : '';

  const roleContext = `You are KNOWHERE, an intelligent crime analytics assistant for Karnataka State Police.
The user is a ${req.user.role} named ${req.user.name}.
Their permissions are: ${ROLE_PERMISSIONS[req.user.role].join(', ')}.
Only answer questions within their permitted scope.
Always cite the FIR number, location, or data source in your response.
CRITICAL: Respond in the exact same language the user wrote their query in. English query → English reply. Kannada script query → Kannada reply. Hindi script query → Hindi reply. Never switch languages.${langHint}
Be precise, professional, and factual. Never speculate beyond the data.`;

  const fullQuery = `${roleContext}\n\nUser Query: ${query}`;

  try {
    // Catalyst SDK handles auth from the serve/deploy context —
    // no manual OAuth tokens (they expire and cause INVALID_OAUTHTOKEN)
    const catalystApp = catalyst.initialize(req);
    const quickml = catalystApp.quickML();
    const ragResponse = await quickml.predict({ query: fullQuery });

    logAudit(req.user, 'QUERY', query);

    res.json({
      answer: ragResponse.answer || ragResponse.response || ragResponse.data?.answer || ragResponse,
      query,
      role: req.user.role,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Catalyst RAG unavailable:', err?.response?.data || err.message);

    // Groq LLM fallback — uses the locally loaded KSP dataset for real answers
    if (!process.env.GROQ_API_KEY) {
      return res.json({
        answer: '[OFFLINE] No Groq API key configured. Cannot answer without Catalyst or Groq.',
        query, role: req.user.role, timestamp: new Date().toISOString(), demo: true,
      });
    }
    try {
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      const relevantFIRs = retrieveRelevantFIRs(query);
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
      return res.json({ answer, query, role: req.user.role, timestamp: new Date().toISOString() });
    } catch (groqErr) {
      console.error('Groq fallback error:', groqErr?.message);
      return res.json({
        answer: `[ERROR] Both Catalyst RAG and Groq LLM are unavailable. Please check server logs.`,
        query, role: req.user.role, timestamp: new Date().toISOString(), demo: true,
      });
    }
  }
});

// GET /api/chat/history  — returns audit log for current user
app.get('/api/chat/history', authMiddleware, (req, res) => {
  const userLogs = auditLog.filter(log => log.user === req.user.email && log.action === 'QUERY');
  res.json({ history: userLogs });
});

// GET /api/audit  — supervisors only
app.get('/api/audit', authMiddleware, (req, res) => {
  if (req.user.role !== 'supervisor')
    return res.status(403).json({ error: 'Access denied. Supervisors only.' });
  res.json({ logs: auditLog });
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

  return alerts.slice(0, 10);
}

// Build all intelligence data from the parsed FIRs
const PARSED_FIRS   = parseFIRs(KSP_FIRS);
let NETWORK_DATA    = buildNetwork(PARSED_FIRS);
let ALERTS          = buildAlerts(PARSED_FIRS);
let TIMELINE_EVENTS = buildTimeline(PARSED_FIRS);
let HEATMAP         = buildHeatmap(PARSED_FIRS);
console.log(`[KNOWHERE] Built intelligence data — ${PARSED_FIRS.length} FIRs · ${NETWORK_DATA.nodes.length} network nodes · ${TIMELINE_EVENTS.length} timeline events · ${ALERTS.length} alerts`);

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
app.get('/api/alerts', authMiddleware, (req, res) => {
  res.json({ alerts: ALERTS, generatedAt: new Date().toISOString() });
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

// POST /api/case-summary — generate structured case brief via LLM (demo fallback)
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

  try {
    const catalystApp = catalyst.initialize(req);
    const quickml = catalystApp.quickML();
    const ragResponse = await quickml.predict({ query: prompt });
    const text = ragResponse.answer || ragResponse.response || ragResponse.data?.answer;
    if (typeof text === 'string' && text.trim()) {
      return res.json({ ...meta, demo: false, raw: text });
    }
    throw new Error('Empty RAG response');
  } catch (err) {
    console.error('Case summary RAG error:', err?.response?.data || err.message);
    res.json({ ...meta, demo: true, sections: DEMO_CASE_BRIEF });
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
