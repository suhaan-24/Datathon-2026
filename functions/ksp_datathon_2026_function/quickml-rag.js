'use strict';

// ── QuickML Knowledge Base (RAG) client ──────────────────────────────────────
// Primary chat path: queries the Catalyst QuickML RAG API, which retrieves from
// the uploaded FIR knowledge base and generates a grounded answer (Qwen 2.5 14B).
//
// Auth: Zoho OAuth refresh-token flow (scope QuickML.deployment.READ). Access
// tokens are cached in-process until just before expiry.
//
// Fully config-driven via env; if it isn't configured or the call fails, the
// caller falls back to the existing Groq + Data Store retrieval path, so chat
// keeps working either way.
//
// Required env:
//   QUICKML_RAG_URL      e.g. https://api.catalyst.zoho.in/quickml/v1/project/<pid>/rag/answer
//   QUICKML_KB_DOC_IDS   comma-separated KB document id(s) for the uploaded FIRs file
//   ZOHO_CLIENT_ID       Zoho API-console self-client id
//   ZOHO_CLIENT_SECRET   self-client secret
//   ZOHO_REFRESH_TOKEN   refresh token minted with scope QuickML.deployment.READ
// Optional env:
//   ZOHO_ACCOUNTS_URL    OAuth accounts host (default https://accounts.zoho.in)

const axios = require('axios');

const ACCOUNTS_URL = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.in';
const RAG_URL = process.env.QUICKML_RAG_URL;
const DOC_IDS = (process.env.QUICKML_KB_DOC_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

let cachedToken = null;
let cachedExp = 0; // epoch ms

function isConfigured() {
  return Boolean(
    RAG_URL && DOC_IDS.length &&
    process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN
  );
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedExp - 60000) return cachedToken;
  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const { data } = await axios.post(`${ACCOUNTS_URL}/oauth/v2/token`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!data || !data.access_token) {
    throw new Error(`Zoho OAuth refresh failed: ${JSON.stringify(data).slice(0, 200)}`);
  }
  cachedToken = data.access_token;
  cachedExp = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  return cachedToken;
}

// Query the Knowledge Base. Throws if unconfigured or on any API error so the
// caller can fall back to the in-house retrieval + Groq path.
async function answerFromKB(query) {
  if (!isConfigured()) throw new Error('QuickML RAG not configured');
  const token = await getAccessToken();
  const res = await axios.post(
    RAG_URL,
    { query, documents: DOC_IDS },
    {
      headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
      validateStatus: () => true,
    }
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`RAG API ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  const d = res.data || {};
  // Response envelope isn't documented — accept the common shapes and refine
  // once we see a real response.
  const answer =
    (typeof d.answer === 'string' && d.answer) ||
    (typeof d.response === 'string' && d.response) ||
    (typeof d.output === 'string' && d.output) ||
    (typeof d.text === 'string' && d.text) ||
    (typeof d.result === 'string' && d.result) ||
    (Array.isArray(d.result) && d.result.join('\n')) ||
    (d.data && (d.data.answer || d.data.response || d.data.text)) ||
    null;
  if (!answer || typeof answer !== 'string') {
    throw new Error(`RAG API returned no answer text: ${JSON.stringify(d).slice(0, 200)}`);
  }
  return answer.trim();
}

module.exports = { answerFromKB, isConfigured, getAccessToken };
