'use strict';
/* KNOWHERE live API smoke test — runs against the deployed Catalyst function. */

const BASE = 'https://ksp-datathon-2026-60073723389.development.catalystserverless.in/server/ksp_datathon_2026_function';
const results = [];
let pass = 0, fail = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name} — ${detail}`); }
}

async function req(path, { method = 'GET', token, body, raw = false, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h['x-auth-token'] = token;
  if (body) h['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  if (raw) return { res, buf: Buffer.from(await res.arrayBuffer()), ct };
  let data = null;
  try { data = ct.includes('json') ? await res.json() : await res.text(); } catch { data = null; }
  return { res, data, ct };
}

const login = (email, password) => req('/api/auth/login', { method: 'POST', body: { email, password } });

(async () => {
  console.log('\n=== 1. HEALTH ===');
  {
    const { res, data } = await req('/api/health');
    check('health 200', res.status === 200, `status=${res.status}`);
    check('health groq connected', data?.groq === 'connected', `groq=${data?.groq}`);
    check('health dataset=65', data?.dataset === 65, `dataset=${data?.dataset}`);
  }

  console.log('\n=== 2. LOGIN / AUTH ===');
  const tokens = {};
  for (const [role, email, pw, name] of [
    ['investigator', 'investigator@ksp.gov.in', 'inv123', 'Rajesh Kumar'],
    ['analyst', 'analyst@ksp.gov.in', 'ana123', 'Priya Sharma'],
    ['supervisor', 'supervisor@ksp.gov.in', 'sup123', 'DCP Mohan Rao'],
  ]) {
    const { res, data } = await login(email, pw);
    tokens[role] = data?.token;
    check(`login ${role}`, res.status === 200 && !!data?.token, `status=${res.status} role=${data?.role} name=${data?.name}`);
    check(`login ${role} name correct`, data?.name === name, `got "${data?.name}"`);
    check(`login ${role} permissions present`, Array.isArray(data?.permissions) && data.permissions.length > 0, `${data?.permissions?.length} perms`);
  }
  {
    const { res } = await login('investigator@ksp.gov.in', 'WRONG');
    check('wrong password rejected 401', res.status === 401, `status=${res.status}`);
    const { res: r2 } = await login('nobody@ksp.gov.in', 'x');
    check('unknown user rejected 401', r2.status === 401, `status=${r2.status}`);
    const { res: r3 } = await req('/api/auth/login', { method: 'POST', body: {} });
    check('missing creds rejected 400', r3.status === 400, `status=${r3.status}`);
  }
  {
    const payload = JSON.parse(Buffer.from(tokens.supervisor.split('.')[1], 'base64url').toString());
    const hrs = (payload.exp - payload.iat) / 3600;
    check('JWT expiry is 24h', hrs === 24, `${hrs}h`);
    check('JWT payload shape', !!payload.email && !!payload.role && !!payload.name, JSON.stringify(Object.keys(payload)));
  }
  {
    const { res } = await req('/api/alerts');
    check('no token rejected 401', res.status === 401, `status=${res.status}`);
    const { res: r2 } = await req('/api/alerts', { token: 'garbage.token.here' });
    check('invalid token rejected 401', r2.status === 401, `status=${r2.status}`);
    const expired = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6ImludmVzdGlnYXRvckBrc3AuZ292LmluIiwicm9sZSI6ImludmVzdGlnYXRvciIsIm5hbWUiOiJSYWplc2ggS3VtYXIiLCJpYXQiOjE3ODMzNTE5NjIsImV4cCI6MTc4MzM4MDc2Mn0.CG_jaMJ7BQbxxi8DHLkGLxf2QVCqY_JgHIgst3ZKIhQ';
    const { res: r3 } = await req('/api/alerts', { token: expired });
    check('expired token rejected 401', r3.status === 401, `status=${r3.status}`);
  }

  console.log('\n=== 3. RBAC ===');
  for (const role of ['investigator', 'analyst']) {
    const { res } = await req('/api/audit', { token: tokens[role] });
    check(`audit blocked for ${role} (403)`, res.status === 403, `status=${res.status}`);
    const { res: r2 } = await req('/api/admin/seed', { method: 'POST', token: tokens[role] });
    check(`admin/seed blocked for ${role} (403)`, r2.status === 403, `status=${r2.status}`);
    const { res: r3 } = await req('/api/admin/zcql', { method: 'POST', token: tokens[role], body: { query: 'SELECT * FROM FIRs' } });
    check(`admin/zcql blocked for ${role} (403)`, r3.status === 403, `status=${r3.status}`);
  }
  {
    const { res } = await req('/api/audit', { token: tokens.supervisor });
    check('audit allowed for supervisor', res.status === 200, `status=${res.status}`);
    const { res: r2 } = await req('/api/admin/zcql', { method: 'POST', token: tokens.supervisor, body: { query: 'DELETE FROM FIRs' } });
    check('zcql rejects non-SELECT', r2.status === 400, `status=${r2.status}`);
  }

  console.log('\n=== 4. CHAT ===');
  {
    const t0 = Date.now();
    const { res, data } = await req('/api/chat', { method: 'POST', token: tokens.supervisor, body: { query: 'drug trafficking cases in Bengaluru' } });
    const ms = Date.now() - t0;
    check('chat 200', res.status === 200, `status=${res.status} in ${ms}ms`);
    check('chat uses QuickML KB', data?.retrieval === 'quickml-kb', `retrieval=${data?.retrieval}`);
    check('chat cites FIR numbers', /KSP\/[A-Z-]+\/\d{4}\/\d+/.test(data?.answer || ''), (data?.answer || '').match(/KSP\/[A-Z-]+\/\d{4}\/\d+/g)?.slice(0, 3).join(', ') || 'none found');
    check('chat answer non-trivial', (data?.answer || '').length > 100, `${(data?.answer || '').length} chars`);
  }
  {
    const { data } = await req('/api/chat', { method: 'POST', token: tokens.supervisor, body: { query: 'Tell me about the Black Cobra gang' } });
    const a = data?.answer || '';
    check('chat: Black Cobra grounded', /khalid|black cobra/i.test(a), a.slice(0, 80).replace(/\n/g, ' '));
  }
  {
    const { data } = await req('/api/chat', { method: 'POST', token: tokens.supervisor, body: { query: 'ಬೆಂಗಳೂರಿನಲ್ಲಿ ಮಾದಕ ವಸ್ತು ಪ್ರಕರಣಗಳು' } });
    const a = data?.answer || '';
    const kannada = /[ಀ-೿]/.test(a);
    check('Kannada query answered in Kannada', kannada, kannada ? a.slice(0, 60) : `replied in non-Kannada: ${a.slice(0, 60)}`);
  }
  {
    const { res } = await req('/api/chat', { method: 'POST', token: tokens.supervisor, body: {} });
    check('empty query rejected 400', res.status === 400, `status=${res.status}`);
  }

  console.log('\n=== 5. CASE BRIEF PDF ===');
  {
    const t0 = Date.now();
    const { res, buf, ct } = await req('/api/case-summary', {
      method: 'POST', token: tokens.supervisor, raw: true,
      body: { conversationHistory: [
        { role: 'user', text: 'Tell me about the Black Cobra gang' },
        { role: 'bot', text: 'Khalid Ibrahim leads Black Cobra across FIR KSP/BLR-U/2025/0083 and KSP/MLR/2026/0041.' },
        { role: 'user', text: 'What are the recommended leads?' },
      ] },
    });
    const ms = Date.now() - t0;
    check('case-summary 200', res.status === 200, `status=${res.status} in ${ms}ms`);
    check('returns application/pdf', ct.includes('application/pdf'), `content-type=${ct}`);
    check('valid PDF signature', buf.slice(0, 5).toString() === '%PDF-', buf.slice(0, 8).toString('hex'));
    check('PDF non-trivial size', buf.length > 10000, `${buf.length} bytes`);
    check('has attachment filename', /filename=".*\.pdf"/.test(res.headers.get('content-disposition') || ''), res.headers.get('content-disposition') || 'none');
  }

  console.log('\n=== 6. PANELS ===');
  {
    const { data } = await req('/api/network', { token: tokens.supervisor });
    check('network source = KSP schema', data?.source === 'ksp-schema', `source=${data?.source}`);
    check('network 76 nodes', data?.nodes?.length === 76, `${data?.nodes?.length} nodes`);
    check('network 104 edges', data?.edges?.length === 104, `${data?.edges?.length} edges`);
    const { data: f } = await req('/api/network?query=Khalid', { token: tokens.supervisor });
    check('network filter works', f?.nodes?.length > 0 && f.nodes.length < 76, `${f?.nodes?.length} nodes, ${f?.edges?.length} edges`);
    check('filter includes Khalid Ibrahim', f?.nodes?.some(n => /Khalid/i.test(n.label)), f?.nodes?.find(n => /Khalid/i.test(n.label))?.detail?.role || 'not found');
  }
  {
    const { data } = await req('/api/timeline', { token: tokens.supervisor });
    check('timeline source = KSP schema', data?.source === 'ksp-schema', `source=${data?.source}`);
    check('timeline 65 events', data?.events?.length === 65, `${data?.events?.length} events`);
    check('timeline codename', data?.codename === 'OPERATION SAHYADRI', data?.codename);
    const first = data?.events?.[0];
    check('earliest date 2025-01-14 (TZ bug fixed)', first?.date?.startsWith('2025-01-14'), `${first?.date} (${first?.fir})`);
    const types = {}; (data?.events || []).forEach(e => types[e.type] = (types[e.type] || 0) + 1);
    check('timeline has all 3 event types', Object.keys(types).length === 3, JSON.stringify(types));
    const sorted = (data?.events || []).every((e, i, a) => i === 0 || a[i - 1].date <= e.date);
    check('timeline chronological', sorted, sorted ? 'ordered' : 'OUT OF ORDER');
  }
  {
    const { data } = await req('/api/heatmap', { token: tokens.supervisor });
    check('heatmap source = KSP schema', data?.source === 'ksp-schema', `source=${data?.source}`);
    check('heatmap 31 districts', data?.districts?.length === 31, `${data?.districts?.length} districts`);
    const lv = {}; (data?.districts || []).forEach(d => lv[d.level] = (lv[d.level] || 0) + 1);
    check('heatmap levels 4/6/21', lv.critical === 4 && lv.elevated === 6 && lv.nodata === 21, JSON.stringify(lv));
  }
  {
    const { data } = await req('/api/alerts', { token: tokens.supervisor });
    check('alerts source = Data Store (Cron table)', data?.source === 'catalyst-datastore', `source=${data?.source}`);
    check('alerts count 8', data?.alerts?.length === 8, `${data?.alerts?.length} alerts`);
    const keys = (data?.alerts || []).map(a => `${a.type}|${a.change}`);
    check('no duplicate alerts', new Set(keys).size === keys.length, `${keys.length} alerts, ${new Set(keys).size} unique`);
    const surge = (data?.alerts || []).filter(a => a.type === 'Active FIR Surge');
    check('only one Active FIR Surge', surge.length === 1, `${surge.length} found`);
    const sev = new Set((data?.alerts || []).map(a => a.severity));
    check('alerts have severities', sev.size >= 2, [...sev].join(','));
    check('alert ids contiguous', (data?.alerts || []).every((a, i) => a.id === i + 1), (data?.alerts || []).map(a => a.id).join(','));
  }

  console.log('\n=== 7. AUDIT + CRON ===');
  {
    const { data } = await req('/api/audit', { token: tokens.supervisor });
    check('audit source = Data Store', data?.source === 'catalyst-datastore', `source=${data?.source}`);
    check('audit has rows', (data?.logs?.length || 0) > 0, `${data?.logs?.length} rows`);
    const actions = new Set((data?.logs || []).map(l => l.action));
    check('audit records LOGIN', actions.has('LOGIN'), [...actions].join(','));
    check('audit records QUERY', actions.has('QUERY'), '');
    const cron = (data?.logs || []).filter(l => l.user === 'system@cron');
    check('cron ran (system@cron in audit)', cron.length > 0, `${cron.length} ALERTS_REFRESH entries`);
  }
  {
    const { data } = await req('/api/admin/cron-list', { token: tokens.supervisor });
    const c = data?.crons?.[0];
    check('cron registered', data?.count === 1, `count=${data?.count}`);
    check('cron is Periodic + active', c?.cron_type === 'Periodic' && c?.cron_status === true, `type=${c?.cron_type} status=${c?.cron_status}`);
    check('cron has run successfully', (c?.success_count || 0) > 0, `success=${c?.success_count} failures=${c?.failure_count}`);
    check('cron secret redacted', c?.job_meta?.headers?.['x-cron-secret'] === '<redacted>', JSON.stringify(c?.job_meta?.headers));
  }
  {
    const res = await fetch(BASE + '/api/cron/refresh-alerts', { method: 'POST', headers: { 'x-cron-secret': 'wrong' } });
    check('cron endpoint rejects bad secret', res.status === 401, `status=${res.status}`);
  }

  console.log('\n=== 8. MISC ===');
  {
    const { res } = await req('/api/transcribe', { method: 'POST', token: tokens.supervisor });
    check('transcribe without file → 400', res.status === 400, `status=${res.status}`);
    const { data } = await req('/api/roles');
    check('roles endpoint', Array.isArray(data?.roles) && data.roles.length === 3, (data?.roles || []).join(','));
    const { res: r404 } = await req('/api/does-not-exist', { token: tokens.supervisor });
    check('unknown route 404', r404.status === 404, `status=${r404.status}`);
  }

  console.log(`\n${'='.repeat(60)}\nRESULT: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  if (fail) {
    console.log('\nFAILURES:');
    results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.name}: ${r.detail}`));
  }
})();
