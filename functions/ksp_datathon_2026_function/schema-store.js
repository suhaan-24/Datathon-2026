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

// The physical tables in Data Store were created by hand and two names differ
// from the schema's spelling. Seed data and code keep the schema-correct names;
// this maps them to what actually exists. Fix the console names and delete the
// entry to bring them back in line.
const PHYSICAL_NAME = {
  ComplainantDetails: 'ComplaintDetails',
  ActSectionAssociation: 'ActSectionAssociastion',
  // ZCQL resolves table names case-insensitively, but datastore().table() does
  // not — using the wrong case made deleteRows a no-op, so re-seeding appended
  // duplicates instead of replacing. Match the console's exact casing.
  ChargesheetDetails: 'ChargeSheetDetails',
};
const physical = (name) => PHYSICAL_NAME[name] || name;

// Likewise, several columns were created with slightly different spellings.
// Code and seed data use the schema's names; these map them to the physical
// column on write and back again on read, so nothing downstream has to care.
// Correct the console spellings and delete the entry to bring them in line.
const COLUMN_ALIAS = {
  Employee: { BloodGroupID: 'BloodGoupID' },
  CrimeHead: { CrimeGroupName: 'CrimeGoupName' },
  CaseMaster: { CrimeRegisteredDate: 'CrimeRegisterdDate', CaseStatusID: 'CaseStatusiD' },
  ComplainantDetails: { ComplainantID: 'ComplaitID', ComplainantName: 'ComplaintName' },
  ActSectionAssociation: { ActOrderID: 'ActOrderId' },
  ArrestSurrender: {
    ArrestSurrenderStateId: 'ArrestSurrenderSateID',
    ArrestSurrenderDistrictId: 'ArrestSurrenderDistrictID',
    IsComplainantAccused: 'IsComplaintAccused',
  },
};

/** schema column names -> physical column names, for writing. */
function toPhysicalRow(tableName, row) {
  const map = COLUMN_ALIAS[tableName];
  if (!map) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[map[k] || k] = v;
  return out;
}

/** physical column names -> schema column names, for reading. */
function toSchemaRow(tableName, row) {
  const map = COLUMN_ALIAS[tableName];
  if (!map || !row) return row;
  const reverse = Object.fromEntries(Object.entries(map).map(([schema, phys]) => [phys, schema]));
  const out = {};
  for (const [k, v] of Object.entries(row)) out[reverse[k] || k] = v;
  return out;
}

const CASE_STATUS = { UNDER_INVESTIGATION: 1, CHARGE_SHEETED: 2, CLOSED: 3, UNDETECTED: 4 };

function loadSeedData() {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, 'seed-data.json'), 'utf8'));
}

/** Reports which schema tables exist, so seeding fails loudly before writing. */
async function checkTables(catalystApp) {
  const present = [], missing = [];
  for (const name of SEED_ORDER) {
    try {
      await catalystApp.zcql().executeZCQLQuery(`SELECT ROWID FROM ${physical(name)} LIMIT 1`);
      present.push(name);
    } catch {
      missing.push(name);
    }
  }
  return { present, missing };
}

// Data Store rejects an explicit null on some columns ("Invalid input value for
// column name") while accepting it on others, depending on how the column was
// defined. Omitting the key entirely is equivalent and works uniformly.
function stripNulls(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

async function insertChunked(table, rows, size = 100, tableName = null) {
  let n = 0;
  for (let i = 0; i < rows.length; i += size) {
    await table.insertRows(rows.slice(i, i + size).map(r => toPhysicalRow(tableName, stripNulls(r))));
    n += Math.min(size, rows.length - i);
  }
  return n;
}

/** Deletes existing rows so re-seeding is idempotent. ZCQL caps LIMIT at 300. */
async function clearTable(catalystApp, name) {
  const phys = physical(name);
  const table = catalystApp.datastore().table(phys);
  let removed = 0;
  for (;;) {
    const rows = await catalystApp.zcql().executeZCQLQuery(`SELECT ROWID FROM ${phys} LIMIT 300`);
    const ids = rows.map(r => r[phys]?.ROWID).filter(Boolean);
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
    const table = catalystApp.datastore().table(physical(name));
    const deleted = clear ? await clearTable(catalystApp, name) : 0;
    try {
      const inserted = rows.length ? await insertChunked(table, rows, 100, name) : 0;
      result[name] = { deleted, inserted };
    } catch (err) {
      // Data Store reports column errors without naming the table or column, so
      // attach the context needed to actually fix it.
      const e = new Error(`${name}: ${err?.message}`);
      e.table = name;
      e.physicalTable = physical(name);
      e.sampleRow = rows[0];
      e.partial = result;
      throw e;
    }
  }
  return result;
}

/** Inserts a single row into one table — used to isolate column errors. */
async function probeTable(catalystApp, name) {
  const data = loadSeedData();
  const rows = data[name] || [];
  if (!rows.length) return { ok: false, error: 'no seed rows' };
  const table = catalystApp.datastore().table(physical(name));
  const results = [];
  // Try the row whole, then column-by-column, to find which column is rejected.
  try {
    await table.insertRow(toPhysicalRow(name, stripNulls(rows[0])));
    return { ok: true, note: 'full row accepted' };
  } catch (err) {
    results.push({ stage: 'full row', error: err?.message });
  }
  for (const [col, val] of Object.entries(rows[0])) {
    try {
      await table.insertRow(toPhysicalRow(name, stripNulls({ [col]: val })));
      results.push({ col, value: val, ok: true });
    } catch (err) {
      results.push({ col, value: val, ok: false, error: err?.message });
    }
  }
  return { ok: false, sampleRow: rows[0], results };
}

// ─────────────────────────── Reads ───────────────────────────

const rowsOf = (res, table) => res.map(r => r[table]).filter(Boolean);

async function selectAll(catalystApp, table) {
  const phys = physical(table);
  const rows = rowsOf(await catalystApp.zcql().executeZCQLQuery(`SELECT * FROM ${phys}`), phys);
  return rows.map(r => toSchemaRow(table, r));
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

  // Gang and cross-district flags come from the case narrative held in
  // BriefFacts, exactly as the flat-file parser read them, so alert counts stay
  // identical to the pre-migration app.

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
      // Legacy parity: the flat-file parser tested only the District field line
      // for "cross-district", not the whole narrative — matching that keeps the
      // cross-district alert count identical.
      isCrossDistrict: /cross-district/i.test(
        (String(c.BriefFacts || '').match(/^District:\s*(.+)$/m) || [, ''])[1]
      ),
      isBlackCobra: /black cobra/i.test(c.BriefFacts || ''),
      briefFacts: c.BriefFacts || '',
    };
  });
}

module.exports = { SEED_ORDER, PHYSICAL_NAME, COLUMN_ALIAS, physical, toPhysicalRow, toSchemaRow, probeTable, CASE_STATUS, loadSeedData, checkTables, seedAll, clearTable, selectAll, fetchCaseGraph };
