'use strict';

// ── QuickML Knowledge Base (RAG) client ──────────────────────────────────────
// Primary chat path: queries the Catalyst QuickML RAG API, which retrieves from
// the uploaded FIR knowledge base and generates a grounded answer (Qwen 2.5 14B).
//
// Auth: Zoho OAuth refresh-token flow (scope QuickML.deployment.READ). Access
// tokens are cached in-process until just before expiry. The API also requires
// the `CATALYST-ORG` header set to the Catalyst environment id.
//
// Fully config-driven via env; if it isn't configured or the call fails, the
// caller falls back to the existing Groq + Data Store retrieval path, so chat
// keeps working either way.
//
// Required env:
//   QUICKML_RAG_URL      https://api.catalyst.zoho.in/quickml/v1/project/<pid>/rag/answer
//   QUICKML_KB_DOC_IDS   comma-separated KB document id(s) for the uploaded FIRs file
//   CATALYST_ORG_ID      Catalyst environment id (sent as the CATALYST-ORG header)
//   ZOHO_CLIENT_ID       Zoho api-console self-client id
//   ZOHO_CLIENT_SECRET   self-client secret
//   ZOHO_REFRESH_TOKEN   refresh token minted with scope QuickML.deployment.READ
// Optional env:
//   ZOHO_ACCOUNTS_URL    OAuth accounts host (default https://accounts.zoho.in)

const axios = require('axios');

// Read env lazily (not at module load) so it's correct regardless of when
// dotenv populates process.env relative to this require.
function cfg() {
  return {
    accountsUrl: process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.in',
    ragUrl: process.env.QUICKML_RAG_URL,
    orgId: process.env.CATALYST_ORG_ID,
    docIds: (process.env.QUICKML_KB_DOC_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
    clientId: process.env.ZOHO_CLIENT_ID,
    clientSecret: process.env.ZOHO_CLIENT_SECRET,
    refreshToken: process.env.ZOHO_REFRESH_TOKEN,
  };
}

function isConfigured() {
  const c = cfg();
  return Boolean(c.ragUrl && c.orgId && c.docIds.length && c.clientId && c.clientSecret && c.refreshToken);
}

let cachedToken = null;
let cachedExp = 0; // epoch ms

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedExp - 60000) return cachedToken;
  const c = cfg();
  const params = new URLSearchParams({
    refresh_token: c.refreshToken,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    grant_type: 'refresh_token',
  });
  const { data } = await axios.post(`${c.accountsUrl}/oauth/v2/token`, params.toString(), {
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
  const c = cfg();
  const token = await getAccessToken();
  const res = await axios.post(
    c.ragUrl,
    { query, documents: c.docIds },
    {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'CATALYST-ORG': c.orgId,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    }
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`RAG API ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  const d = res.data || {};
  // Confirmed shape on GLM 4.7B Flash (crm-di-glm47b_30b_it, the model that
  // replaced the deprecated Qwen family on 2026-07-31):
  //   { status, response: '<text>', usage, model_usage, retrieved_nodes }
  // GLM can also nest text under choices[0].message.content when tool calling
  // is involved — we never send tools, but parse it as a fallback anyway.
  const answer =
    (typeof d.response === 'string' && d.response) ||
    (typeof d.answer === 'string' && d.answer) ||
    (typeof d.output === 'string' && d.output) ||
    (typeof d.text === 'string' && d.text) ||
    (typeof d.choices?.[0]?.message?.content === 'string' && d.choices[0].message.content) ||
    (d.data && (d.data.response || d.data.answer || d.data.text)) ||
    null;
  if (!answer || typeof answer !== 'string') {
    throw new Error(`RAG API returned no answer text: ${JSON.stringify(d).slice(0, 200)}`);
  }
  return answer.trim();
}

module.exports = { answerFromKB, isConfigured, getAccessToken };
