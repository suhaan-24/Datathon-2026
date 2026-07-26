'use strict';

/**
 * Seeding and querying for the official KSP normalized schema (26 tables).
 *
 * Runs inside the deployed function because the Catalyst SDK needs a request
 * context; `catalyst ds:import` is not an option (it requires a Stratus bucket).
 *
 * Every read is a plain ZCQL SELECT joined in JS rather than a single large SQL
 * join: ZCQL caps LIMIT at 300 rows, so wide joins over CaseMaster x Accused x
 * Victim would truncate silently. Fetching each table once (all are well under
 * 300 rows) and joining in memory is both correct and fewer round trips.
 */

const fs = require('fs');
const path = require('path');

// Insert order respects foreign-key dependencies.
const SEED_ORDER = [
  'State', 'District', 'UnitType', 'Unit', 'Rank', 'Designation', 'Employee',
  'CaseCategory', 'GravityOffence', 'CrimeHead', 'CrimeSubHead', 'Act', 'Section',
  'CrimeHeadActSection', 'CasteMaster', 'ReligionMaster', 'OccupationMaster',
  'CaseStatusMaster', 'Court',
  'CaseMaster', 'ComplainantDetails', 'ActSectionAssociation', 'Victim',
  'AccusedPerson', 'ArrestSurrender', 'ChargesheetDetails',
];

const CASE_STATUS = { UNDER_INVESTIGATION: 1, CHARGE_SHEETED: 2, CLOSED: 3, UNDETECTED: 4 };

function loadSeedData() {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, 'seed-data.json'), 'utf8'));
}

/** Reports which schema tables exist, so seeding fails loudly before writing. */
async function checkTables(catalystApp) {
  const present = [], missing = [];
  for (const name of SEED_ORDER) {
    try {
      await catalystApp.zcql().executeZCQLQuery(`SELECT ROWID FROM ${name} LIMIT 1`);
      present.push(name);
    } catch {
      missing.push(name);
    }
  }
  return { present, missing };
}

async function insertChunked(table, rows, size = 100) {
  let n = 0;
  for (let i = 0; i < rows.length; i += size) {
    await table.insertRows(rows.slice(i, i + size));
    n += Math.min(size, rows.length - i);
  }
  return n;
}

/** Deletes existing rows so re-seeding is idempotent. ZCQL caps LIMIT at 300. */
async function clearTable(catalystApp, name) {
  const table = catalystApp.datastore().table(name);
  let removed = 0;
  for (;;) {
    const rows = await catalystApp.zcql().executeZCQLQuery(`SELECT ROWID FROM ${name} LIMIT 300`);
    const ids = rows.map(r => r[name]?.ROWID).filter(Boolean);
    if (!ids.length) break;
    for (let i = 0; i < ids.length; i += 100) {
      await table.deleteRows(ids.slice(i, i + 100));
    }
    removed += ids.length;
    if (ids.length < 300) break;
  }
  return removed;
}

/** Seeds every table in FK-safe order. Returns per-table counts. */
async function seedAll(catalystApp, { clear = true } = {}) {
  const data = loadSeedData();
  const { missing } = await checkTables(catalystApp);
  if (missing.length) {
    const err = new Error(`Missing tables: ${missing.join(', ')}`);
    err.missing = missing;
    throw err;
  }

  const result = {};
  for (const name of SEED_ORDER) {
    const rows = data[name] || [];
    const table = catalystApp.datastore().table(name);
    const deleted = clear ? await clearTable(catalystApp, name) : 0;
    const inserted = rows.length ? await insertChunked(table, rows) : 0;
    result[name] = { deleted, inserted };
  }
  return result;
}

// ─────────────────────────── Reads ───────────────────────────

const rowsOf = (res, table) => res.map(r => r[table]).filter(Boolean);

async function selectAll(catalystApp, table) {
  return rowsOf(await catalystApp.zcql().executeZCQLQuery(`SELECT * FROM ${table}`), table);
}

/**
 * Loads the joined case graph once and shapes it into the same FIR objects the
 * legacy builders consume, so buildNetwork/buildTimeline/buildHeatmap/
 * buildAlerts keep producing byte-identical API responses.
 */
async function fetchCaseGraph(catalystApp) {
  const [cases, accused, victims, units, districts, employees, subHeads, statuses, arrests, chargesheets] =
    await Promise.all([
      selectAll(catalystApp, 'CaseMaster'),
      selectAll(catalystApp, 'AccusedPerson'),
      selectAll(catalystApp, 'Victim'),
      selectAll(catalystApp, 'Unit'),
      selectAll(catalystApp, 'District'),
      selectAll(catalystApp, 'Employee'),
      selectAll(catalystApp, 'CrimeSubHead'),
      selectAll(catalystApp, 'CaseStatusMaster'),
      selectAll(catalystApp, 'ArrestSurrender'),
      selectAll(catalystApp, 'ChargesheetDetails'),
    ]);

  if (!cases.length) throw new Error('CaseMaster empty — schema not seeded');

  const byId = (rows, key) => Object.fromEntries(rows.map(r => [String(r[key]), r]));
  const unitById = byId(units, 'UnitID');
  const districtById = byId(districts, 'DistrictID');
  const employeeById = byId(employees, 'EmployeeID');
  const subHeadById = byId(subHeads, 'CrimeSubHeadID');
  const statusById = byId(statuses, 'CaseStatusID');

  const accusedByCase = {}, victimByCase = {}, arrestByCase = {}, csByCase = {};
  accused.forEach(a => (accusedByCase[a.CaseMasterID] ||= []).push(a.AccusedName));
  victims.forEach(v => (victimByCase[v.CaseMasterID] ||= v.VictimName));
  arrests.forEach(a => (arrestByCase[a.CaseMasterID] ||= a));
  chargesheets.forEach(c => (csByCase[c.CaseMasterID] ||= c));

  // Cross-district and gang flags are recovered from the normalized graph:
  // an accused appearing in cases across >1 district marks those cases
  // cross-district, matching the legacy narrative flag.
  const districtsByAccused = {};
  accused.forEach(a => {
    const c = cases.find(x => String(x.CaseMasterID) === String(a.CaseMasterID));
    if (!c) return;
    const u = unitById[String(c.PoliceStationID)];
    if (!u) return;
    (districtsByAccused[a.AccusedName] ||= new Set()).add(String(u.DistrictID));
  });

  return cases.map(c => {
    const unit = unitById[String(c.PoliceStationID)] || {};
    const district = districtById[String(unit.DistrictID)] || {};
    const status = statusById[String(c.CaseStatusID)] || {};
    const sub = subHeadById[String(c.CrimeMinorHeadID)] || {};
    const emp = employeeById[String(c.PolicePersonID)] || {};
    const names = accusedByCase[c.CaseMasterID] || [];
    const dateISO = String(c.CrimeRegisteredDate || '').slice(0, 10) || null;

    const isOpen = Number(c.CaseStatusID) === CASE_STATUS.UNDER_INVESTIGATION;
    let eventType = 'fir';
    if (Number(c.CaseStatusID) === CASE_STATUS.CLOSED) eventType = 'court';
    else if (arrestByCase[c.CaseMasterID]) eventType = 'arrest';

    return {
      number: c.CaseNo,
      crimeNo: c.CrimeNo,
      date: dateISO,
      dateISO,
      station: unit.UnitName || '',
      district: district.DistrictName || '',
      crimeType: sub.CrimeHeadName || '',
      accused: names,
      victim: victimByCase[c.CaseMasterID] || '',
      location: c.BriefFacts ? String(c.BriefFacts).split('.')[0] : '',
      status: status.CaseStatusName || '',
      isOpen,
      officer: emp.FirstName || '',
      eventType,
      isCrossDistrict: names.some(n => (districtsByAccused[n]?.size || 0) > 1),
      isBlackCobra: /black cobra/i.test(c.BriefFacts || ''),
      briefFacts: c.BriefFacts || '',
    };
  });
}

module.exports = { SEED_ORDER, CASE_STATUS, loadSeedData, checkTables, seedAll, clearTable, selectAll, fetchCaseGraph };
