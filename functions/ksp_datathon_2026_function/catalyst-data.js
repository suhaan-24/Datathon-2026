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

// Catalyst returns booleans as real booleans or as 'true'/'false' strings
// depending on the column and transport; normalise both.
const toBool = (v) => v === true || v === 'true' || v === 1 || v === '1';

// Fetch all FIRs from Data Store and map them back into the in-memory FIR shape
// (the same objects parseFIRs produces), so buildNetwork/buildTimeline/
// buildHeatmap can consume Data Store rows unchanged.
async function fetchFIRs(catalystApp) {
  const rows = await catalystApp.zcql().executeZCQLQuery(`SELECT * FROM ${TABLES.FIRS}`);
  const firs = rows.map(x => x[TABLES.FIRS]).filter(Boolean).map(r => ({
    number: r.fir_number,
    date: r.fir_date,
    dateISO: r.date_iso || null,
    station: r.police_station,
    district: r.district,
    crimeType: r.crime_type,
    accused: String(r.accused || '').split(';').map(s => s.trim()).filter(Boolean),
    victim: r.victim,
    location: r.location,
    status: r.status,
    isOpen: toBool(r.is_open),
    officer: r.officer,
    eventType: r.event_type,
    isCrossDistrict: toBool(r.is_cross_district),
    isBlackCobra: toBool(r.is_black_cobra),
  }));
  if (!firs.length) throw new Error('FIRs table empty or missing');
  return firs;
}

// Short-lived cache so the panel routes don't re-query ZCQL on every request.
let firCache = null;
let firCacheAt = 0;
const FIR_CACHE_MS = 60000;

async function getFIRs(catalystApp) {
  if (firCache && Date.now() - firCacheAt < FIR_CACHE_MS) return firCache;
  const firs = await fetchFIRs(catalystApp);
  firCache = firs;
  firCacheAt = Date.now();
  return firs;
}

function invalidateFIRCache() {
  firCache = null;
  firCacheAt = 0;
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
// ZCQL rejects a LIMIT above 300, so clamp to stay under the cap.
async function readAudit(catalystApp, limit = 300) {
  const capped = Math.min(Math.max(1, limit), 300);
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${TABLES.AUDIT} ORDER BY CREATEDTIME DESC LIMIT ${capped}`
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

// ── Seeding ──────────────────────────────────────────────────────────────────
// Populates the FIRs and Accused tables from the parsed dataset. Used instead of
// `catalyst ds:import`, which requires a Stratus bucket to stage the CSV.
// Inserts are chunked because the bulk-insert API caps rows per call.

async function insertChunked(table, rows, size = 100) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += size) {
    const batch = rows.slice(i, i + size);
    await table.insertRows(batch);
    inserted += batch.length;
  }
  return inserted;
}

function firToRow(f) {
  const accused = f.accused.join('; ');
  return {
    fir_number: f.number,
    fir_date: f.date,
    date_iso: f.dateISO || '',
    police_station: f.station,
    district: f.district,
    crime_type: f.crimeType,
    accused,
    victim: f.victim,
    location: f.location,
    status: f.status,
    is_open: f.isOpen,
    officer: f.officer,
    event_type: f.eventType,
    is_cross_district: f.isCrossDistrict,
    is_black_cobra: f.isBlackCobra,
    search_text: [f.number, f.district, f.station, f.crimeType, f.victim, f.location, f.status, f.officer, accused]
      .filter(Boolean).join(' '),
  };
}

function accusedRowsFrom(firs) {
  const byName = {};
  for (const f of firs) {
    for (const name of f.accused) (byName[name] ||= { name, firs: [] }).firs.push(f);
  }
  return Object.values(byName).map(a => {
    const last = [...a.firs].sort((x, y) => (y.dateISO || '').localeCompare(x.dateISO || ''))[0];
    return {
      name: a.name,
      fir_count: a.firs.length,
      is_repeat_offender: a.firs.length >= 2,
      fir_numbers: a.firs.map(f => f.number).join('; '),
      last_district: last?.district || '',
      last_seen: last?.dateISO || '',
    };
  });
}

// Wipes and repopulates FIRs + Accused. Returns per-table counts.
async function seedFromFIRs(catalystApp, firs) {
  const ds = catalystApp.datastore();
  const result = {};

  for (const [tableName, rows] of [
    [TABLES.FIRS, firs.map(firToRow)],
    [TABLES.ACCUSED, accusedRowsFrom(firs)],
  ]) {
    const table = ds.table(tableName);
    // Clear existing rows so re-seeding stays idempotent
    const existing = await catalystApp.zcql().executeZCQLQuery(`SELECT ROWID FROM ${tableName}`);
    const ids = existing.map(x => x[tableName]?.ROWID).filter(Boolean);
    for (let i = 0; i < ids.length; i += 100) {
      await table.deleteRows(ids.slice(i, i + 100));
    }
    result[tableName] = { deleted: ids.length, inserted: await insertChunked(table, rows) };
  }
  return result;
}

module.exports = {
  TABLES, firRowToContext, retrieveFIRContext, insertAudit, readAudit, readAlerts, writeAlerts,
  seedFromFIRs, fetchFIRs, getFIRs, invalidateFIRCache,
};
