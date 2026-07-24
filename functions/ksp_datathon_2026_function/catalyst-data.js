'use strict';

// ── Catalyst Data Store integration ──────────────────────────────────────────
// Retrieval, audit, and alert reads backed by Catalyst Data Store + ZCQL.
// Every function is fallback-safe: if a table isn't provisioned yet the call
// throws (or, for writes, is swallowed), and the caller drops back to the
// in-memory pipeline — so the app keeps working before the tables exist and
// automatically upgrades to the platform path once they do.

const TABLES = { FIRS: 'FIRs', ACCUSED: 'Accused', AUDIT: 'AuditLog', ALERTS: 'Alerts' };

// Render a Data Store FIR row into the same text schema the LLM prompt expects,
// so the generation step is identical whether retrieval came from Data Store or
// the in-memory index.
function firRowToContext(r) {
  return [
    `FIR Number: ${r.fir_number}`,
    `Date: ${r.fir_date}`,
    `Police Station: ${r.police_station}`,
    `District: ${r.district}`,
    `Crime Type: ${r.crime_type}`,
    `Accused Name(s): ${r.accused}`,
    `Victim Name: ${r.victim}`,
    `Location of Incident: ${r.location}`,
    `Status: ${r.status}`,
    `Assigned Officer: ${r.officer}`,
  ].join('\n');
}

// Hybrid retrieval: ZCQL pulls candidate FIR rows out of Data Store, then the
// keyword re-ranker scores them before they go to the LLM. Throws if the table
// is missing/empty so the caller can fall back to the in-memory index.
async function retrieveFIRContext(catalystApp, query, topN = 8) {
  const rows = await catalystApp.zcql().executeZCQLQuery(`SELECT * FROM ${TABLES.FIRS}`);
  const firs = rows.map(x => x[TABLES.FIRS]).filter(Boolean);
  if (!firs.length) throw new Error('FIRs table empty or missing');

  const terms = String(query || '').toLowerCase().split(/\W+/).filter(t => t.length > 2);
  const scored = firs.map(r => {
    const hay = String(r.search_text || firRowToContext(r)).toLowerCase();
    const score = terms.reduce((s, t) => s + (hay.split(t).length - 1), 0);
    return { r, score };
  }).sort((a, b) => b.score - a.score);

  const top = scored.filter(x => x.score > 0).slice(0, topN);
  const chosen = top.length ? top : scored.slice(0, 3);
  return chosen.map(x => firRowToContext(x.r)).join('\n\n---\n\n');
}

// Best-effort audit write to Data Store. Never throws to the caller.
async function insertAudit(catalystApp, entry) {
  try {
    await catalystApp.datastore().table(TABLES.AUDIT).insertRow({
      user_email: entry.user,
      role: entry.role,
      action: entry.action,
      query: entry.query || '',
      logged_at: entry.timestamp,
    });
    return true;
  } catch {
    return false;
  }
}

// Read audit rows from Data Store (supervisor view). Throws if unavailable.
async function readAudit(catalystApp, limit = 500) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${TABLES.AUDIT} ORDER BY CREATEDTIME DESC LIMIT ${limit}`
  );
  return rows
    .map(x => x[TABLES.AUDIT])
    .filter(Boolean)
    .map(r => ({ timestamp: r.logged_at, user: r.user_email, role: r.role, action: r.action, query: r.query || null }));
}

// Read alerts from the Cron-populated Alerts table. Throws if unavailable/empty.
async function readAlerts(catalystApp) {
  const rows = await catalystApp.zcql().executeZCQLQuery(`SELECT * FROM ${TABLES.ALERTS} ORDER BY CREATEDTIME DESC`);
  const alerts = rows.map(x => x[TABLES.ALERTS]).filter(Boolean);
  if (!alerts.length) throw new Error('Alerts table empty');
  return alerts.map((r, i) => ({
    id: i + 1,
    severity: r.severity,
    district: r.district,
    type: r.alert_type,
    message: r.message,
    change: r.change_label,
    minutesAgo: r.minutes_ago != null ? Number(r.minutes_ago) : 0,
  }));
}

// Replace the Alerts table with a freshly computed batch (used by the Cron job).
async function writeAlerts(catalystApp, alerts) {
  const table = catalystApp.datastore().table(TABLES.ALERTS);
  const existing = await catalystApp.zcql().executeZCQLQuery(`SELECT ROWID FROM ${TABLES.ALERTS}`);
  const ids = existing.map(x => x[TABLES.ALERTS]?.ROWID).filter(Boolean);
  if (ids.length) await table.deleteRows(ids);
  if (alerts.length) {
    await table.insertRows(alerts.map(a => ({
      severity: a.severity,
      district: a.district,
      alert_type: a.type,
      message: a.message,
      change_label: a.change,
      minutes_ago: a.minutesAgo,
    })));
  }
  return alerts.length;
}

module.exports = { TABLES, firRowToContext, retrieveFIRContext, insertAudit, readAudit, readAlerts, writeAlerts };
