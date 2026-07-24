'use strict';
/*
 * Generates Data Store seed CSVs from the SAME parsed FIRs the running backend
 * uses (imports PARSED_FIRS from the function). Output CSVs are ready for:
 *   catalyst ds:import --table FIRs    catalyst-seed/FIRs.csv
 *   catalyst ds:import --table Accused catalyst-seed/Accused.csv
 *
 * Run:  JWT_SECRET=x node catalyst-seed/generate-seed.js
 */
const fs = require('fs');
const path = require('path');

const fn = require('/Users/suhaan/Desktop/KSP-Datathon-2026/functions/ksp_datathon_2026_function/index.js');
const FIRS = fn.PARSED_FIRS;
const OUT = __dirname;

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (headers, rows) =>
  [headers.join(','), ...rows.map(r => headers.map(h => csvCell(r[h])).join(','))].join('\n') + '\n';

// ── FIRs table (denormalised; search_text powers full-text Search / ZCQL LIKE) ──
const firHeaders = [
  'fir_number', 'fir_date', 'date_iso', 'police_station', 'district', 'crime_type',
  'accused', 'victim', 'location', 'status', 'is_open', 'officer', 'event_type',
  'is_cross_district', 'is_black_cobra', 'search_text',
];
const firRows = FIRS.map(f => {
  const accused = f.accused.join('; ');
  const search_text = [
    f.number, f.district, f.station, f.crimeType, f.victim, f.location,
    f.status, f.officer, accused,
  ].filter(Boolean).join(' ');
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
    is_open: f.isOpen ? 'true' : 'false',
    officer: f.officer,
    event_type: f.eventType,
    is_cross_district: f.isCrossDistrict ? 'true' : 'false',
    is_black_cobra: f.isBlackCobra ? 'true' : 'false',
    search_text,
  };
});

// ── Accused table (aggregated for network / persons-of-interest) ──
const byName = {};
for (const f of FIRS) {
  for (const name of f.accused) {
    (byName[name] ||= { name, firs: [] }).firs.push(f);
  }
}
const accusedRows = Object.values(byName).map(a => {
  const sorted = [...a.firs].sort((x, y) => (y.dateISO || '').localeCompare(x.dateISO || ''));
  const last = sorted[0];
  return {
    name: a.name,
    fir_count: a.firs.length,
    is_repeat_offender: a.firs.length >= 2 ? 'true' : 'false',
    fir_numbers: a.firs.map(f => f.number).join('; '),
    last_district: last?.district || '',
    last_seen: last?.dateISO || '',
  };
});
const accusedHeaders = ['name', 'fir_count', 'is_repeat_offender', 'fir_numbers', 'last_district', 'last_seen'];

fs.writeFileSync(path.join(OUT, 'FIRs.csv'), toCsv(firHeaders, firRows));
fs.writeFileSync(path.join(OUT, 'Accused.csv'), toCsv(accusedHeaders, accusedRows));

console.log(`Wrote FIRs.csv       (${firRows.length} rows, ${firHeaders.length} cols)`);
console.log(`Wrote Accused.csv    (${accusedRows.length} rows, ${accusedHeaders.length} cols)`);
console.log(`  repeat offenders:  ${accusedRows.filter(r => r.is_repeat_offender === 'true').length}`);
console.log(`  open FIRs:         ${firRows.filter(r => r.is_open === 'true').length}`);
