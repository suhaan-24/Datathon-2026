'use strict';

/**
 * Generates normalized seed data for the official KSP schema (26 tables) from
 * the existing 65-FIR narrative dataset, preserving every character name, gang
 * storyline, district and case count for continuity with the recorded demo.
 *
 * Output: scripts/seed-data.json  — consumed by scripts/seed-datastore.js
 * Run:    node scripts/generate-seed-data.js
 *
 * Design notes
 * ------------
 * • Source of truth for cases is parseFIRs() from the running backend, so the
 *   normalized rows and the legacy path describe exactly the same 65 cases.
 * • Sensitive per-person attributes (gender, caste, religion, occupation) are
 *   NOT invented for named individuals. The lookup tables carry the official
 *   category lists so the schema is faithful, but per-person rows reference the
 *   "Not Recorded" entry. Fabricating demographics for realistic-looking named
 *   people is not something synthetic seed data should do.
 * • Data Store enforces no foreign keys, so every ID below is allocated here and
 *   referential integrity is guaranteed by construction.
 */

const fs = require('fs');
const path = require('path');

const FUNC_DIR = path.resolve(__dirname, '..', 'functions', 'ksp_datathon_2026_function');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'seed-generation-only';
const backend = require(path.join(FUNC_DIR, 'index.js'));
const FIRS = backend.PARSED_FIRS;

// The original narrative blocks, keyed by FIR number. BriefFacts keeps the full
// text rather than a summary rebuilt from structured fields: the narrative is
// what carries gang names ("Black Cobra"), cross-district markers and modus
// operandi, which the alert builders and the Knowledge Base documents rely on.
const RAW_BLOCK = {};
try {
  const raw = fs.readFileSync(path.join(FUNC_DIR, 'synthetic_ksp_data.txt'), 'utf8');
  for (const block of raw.split(/\n(?=FIR Number:)/)) {
    const m = block.match(/^FIR Number:\s*(\S+)/m);
    if (m) RAW_BLOCK[m[1].trim()] = block.trim();
  }
} catch {
  console.warn('WARNING: source dataset unreadable — BriefFacts will be summary-only');
}

if (!FIRS || !FIRS.length) {
  console.error('No parsed FIRs available — cannot generate seed data.');
  process.exit(1);
}

const NOT_RECORDED = 99;          // shared "Not Recorded" id across lookup lists
const GENDER_NOT_RECORDED = 3;    // 1=Male 2=Female 3=Not Recorded
const STATE_ID = 29;              // Karnataka (official state code)
const NATIONALITY_ID = 1;         // India

const out = {};
const pad = (n, w) => String(n).padStart(w, '0');
const iso = (d) => (d ? `${d} 00:00:00` : null);

// ─────────────────────────── State / District ───────────────────────────
out.State = [{ StateID: STATE_ID, StateName: 'Karnataka', NationalityID: NATIONALITY_ID, Active: true }];

const ALL_DISTRICTS = [
  'Bagalkote', 'Ballari', 'Belagavi', 'Bengaluru Rural', 'Bengaluru Urban', 'Bidar',
  'Chamarajanagara', 'Chikkaballapura', 'Chikkamagaluru', 'Chitradurga', 'Dakshina Kannada',
  'Davanagere', 'Dharwad', 'Gadag', 'Hassan', 'Haveri', 'Kalaburagi', 'Kodagu', 'Kolar',
  'Koppal', 'Mandya', 'Mysuru', 'Raichur', 'Ramanagara', 'Shivamogga', 'Tumakuru', 'Udupi',
  'Uttara Kannada', 'Vijayanagara', 'Vijayapura', 'Yadgir',
];
const districtId = {};
out.District = ALL_DISTRICTS.map((name, i) => {
  districtId[name] = i + 1;
  return { DistrictID: i + 1, DistrictName: name, StateID: STATE_ID, Active: true };
});

// Approximate district centroids so the heatmap/lat-long look plausible.
const DISTRICT_LATLNG = {
  'Bengaluru Urban': [12.9716, 77.5946], 'Bengaluru Rural': [13.2846, 77.6200],
  'Mysuru': [12.2958, 76.6394], 'Dakshina Kannada': [12.8703, 74.8806],
  'Dharwad': [15.4589, 75.0078], 'Belagavi': [15.8497, 74.4977],
  'Kalaburagi': [17.3297, 76.8343], 'Tumakuru': [13.3409, 77.1010],
  'Ballari': [15.1394, 76.9214], 'Shivamogga': [13.9299, 75.5681],
};
const latLngFor = (d) => DISTRICT_LATLNG[d] || [15.3173, 75.7139]; // Karnataka centroid

// ─────────────────────────── Unit hierarchy ───────────────────────────
out.UnitType = [
  { UnitTypeID: 1, UnitTypeName: 'Police Station', CityDistState: 'City', Hierarchy: 4, Active: true },
  { UnitTypeID: 2, UnitTypeName: 'Circle Office', CityDistState: 'City', Hierarchy: 3, Active: true },
  { UnitTypeID: 3, UnitTypeName: 'Sub-Division', CityDistState: 'District', Hierarchy: 2, Active: true },
  { UnitTypeID: 4, UnitTypeName: 'District HQ', CityDistState: 'District', Hierarchy: 1, Active: true },
];

// One District HQ per district that has cases, then a station per distinct
// police station in the dataset, parented to its district HQ.
const activeDistricts = [...new Set(FIRS.map(f => f.district))];
out.Unit = [];
let unitSeq = 0;
const hqIdFor = {};
for (const d of activeDistricts) {
  const id = ++unitSeq;
  hqIdFor[d] = id;
  out.Unit.push({
    UnitID: id, UnitName: `${d} District Police HQ`, TypeID: 4, ParentUnit: null,
    NationalityID: NATIONALITY_ID, StateID: STATE_ID, DistrictID: districtId[d], Active: true,
  });
}
const unitIdFor = {}; // "district|station" -> UnitID
for (const f of FIRS) {
  const key = `${f.district}|${f.station}`;
  if (unitIdFor[key]) continue;
  const id = ++unitSeq;
  unitIdFor[key] = id;
  out.Unit.push({
    UnitID: id, UnitName: f.station, TypeID: 1, ParentUnit: hqIdFor[f.district],
    NationalityID: NATIONALITY_ID, StateID: STATE_ID, DistrictID: districtId[f.district], Active: true,
  });
}

// ─────────────────────────── Rank / Designation ───────────────────────────
out.Rank = [
  ['Constable', 1], ['Head Constable', 2], ['Assistant Sub-Inspector', 3], ['Sub-Inspector', 4],
  ['Police Sub-Inspector', 5], ['Inspector', 6], ['Deputy Superintendent of Police', 7],
  ['Superintendent of Police', 8],
].map(([RankName, Hierarchy], i) => ({ RankID: i + 1, RankName, Hierarchy, Active: true }));

out.Designation = [
  'Investigating Officer', 'Station House Officer', 'Beat Officer', 'Circle Inspector', 'Superintendent',
].map((DesignationName, i) => ({ DesignationID: i + 1, DesignationName, Active: true, SortOrder: i + 1 }));

// Map the rank prefix used in the narrative onto the Rank table.
const RANK_PATTERNS = [
  [/deputy\s+sp|dy\.?\s*sp|deputy superintendent/i, 7],
  [/\bsuperintendent\b|\bsp\b/i, 8],
  [/inspector\b/i, 6],
  [/\bpsi\b|police sub-?inspector/i, 5],
  [/sub-?inspector|\bsi\b/i, 4],
  [/\basi\b/i, 3],
  [/head constable|\bhc\b/i, 2],
  [/constable/i, 1],
];
const rankFor = (title) => (RANK_PATTERNS.find(([re]) => re.test(title)) || [null, 6])[1];

// ─────────────────────────── Employee ───────────────────────────
// One row per distinct investigating officer named in the dataset.
out.Employee = [];
const employeeIdFor = {};
let empSeq = 0;
for (const f of FIRS) {
  const raw = f.officer.split(',')[0].trim();
  if (!raw || employeeIdFor[raw]) continue;
  const id = ++empSeq;
  employeeIdFor[raw] = id;
  const rankId = rankFor(raw);
  out.Employee.push({
    EmployeeID: id,
    DistrictID: districtId[f.district],
    UnitID: unitIdFor[`${f.district}|${f.station}`],
    RankID: rankId,
    DesignationID: rankId >= 6 ? 4 : 1, // senior ranks act as Circle Inspector, others as IO
    KGID: `KG${pad(id, 5)}`,
    FirstName: raw,
    EmployeeDOB: null,
    GenderID: GENDER_NOT_RECORDED,
    BloodGroupID: null,
    PhysicallyChallenged: false,
    AppointmentDate: null,
  });
}

// ─────────────────────────── Simple lookups ───────────────────────────
out.CaseCategory = [
  { CaseCategoryID: 1, LookupValue: 'FIR' },
  { CaseCategoryID: 2, LookupValue: 'UDR' },
  { CaseCategoryID: 3, LookupValue: 'Zero FIR' },
  { CaseCategoryID: 4, LookupValue: 'PAR' },
];
out.GravityOffence = [
  { GravityOffenceID: 1, LookupValue: 'Heinous' },
  { GravityOffenceID: 2, LookupValue: 'Non-Heinous' },
];
out.CaseStatusMaster = [
  { CaseStatusID: 1, CaseStatusName: 'Under Investigation' },
  { CaseStatusID: 2, CaseStatusName: 'Charge Sheeted' },
  { CaseStatusID: 3, CaseStatusName: 'Closed' },
  { CaseStatusID: 4, CaseStatusName: 'Undetected' },
];

// Official-style category lists. Per-person rows reference "Not Recorded"
// rather than inventing demographics for named individuals.
out.CasteMaster = [
  [1, 'General'], [2, 'Scheduled Caste'], [3, 'Scheduled Tribe'],
  [4, 'Other Backward Class'], [NOT_RECORDED, 'Not Recorded'],
].map(([caste_master_id, caste_master_name]) => ({ caste_master_id, caste_master_name }));

out.ReligionMaster = [
  [1, 'Hindu'], [2, 'Muslim'], [3, 'Christian'], [4, 'Sikh'], [5, 'Buddhist'],
  [6, 'Jain'], [7, 'Parsi'], [8, 'Other'], [NOT_RECORDED, 'Not Recorded'],
].map(([ReligionID, ReligionName]) => ({ ReligionID, ReligionName }));

out.OccupationMaster = [
  [1, 'Agriculture'], [2, 'Business'], [3, 'Government Service'], [4, 'Private Service'],
  [5, 'Daily Wage Labour'], [6, 'Student'], [7, 'Homemaker'], [8, 'Self Employed'],
  [9, 'Unemployed'], [NOT_RECORDED, 'Not Recorded'],
].map(([OccupationID, OccupationName]) => ({ OccupationID, OccupationName }));

// ─────────────────────────── Crime heads ───────────────────────────
out.CrimeHead = [
  'Crimes Against Body', 'Crimes Against Property', 'Crimes Against Women & Children',
  'Cyber Crime', 'Narcotics & NDPS', 'Economic Offences', 'Public Order', 'Miscellaneous',
].map((CrimeGroupName, i) => ({ CrimeHeadID: i + 1, CrimeGroupName, Active: true }));

// Sub-heads: the 10 crime types actually present, plus related heads to ~20.
// crimeType -> [CrimeSubHeadID, CrimeHeadID, heinous?]
const SUBHEADS = [
  ['Murder', 1, 1, true], ['Attempt to Murder', 2, 1, true], ['Assault', 3, 1, false],
  ['Grievous Hurt', 4, 1, false], ['Kidnapping', 5, 1, true],
  ['Robbery', 6, 2, true], ['Burglary', 7, 2, false], ['Theft', 8, 2, false],
  ['Vehicle Theft', 9, 2, false], ['Extortion', 10, 2, false], ['Dacoity', 11, 2, true],
  ['POCSO', 12, 3, true], ['Crimes Against Women', 13, 3, true],
  ['Cybercrime', 14, 4, false], ['Cyber Fraud', 15, 4, false], ['Online Harassment', 16, 4, false],
  ['Drug Trafficking', 17, 5, true], ['NDPS Possession', 18, 5, false],
  ['Fraud', 19, 6, false], ['Cheating', 20, 6, false],
  ['Gang Activity', 21, 7, true], ['Rioting', 22, 7, false],
];
out.CrimeSubHead = SUBHEADS.map(([CrimeHeadName, CrimeSubHeadID, CrimeHeadID], i) =>
  ({ CrimeSubHeadID, CrimeHeadID, CrimeHeadName, SeqID: i + 1 }));

const subHeadFor = {};
SUBHEADS.forEach(([name, id, head, heinous]) => { subHeadFor[name] = { id, head, heinous }; });

// ─────────────────────────── Acts & Sections ───────────────────────────
out.Act = [
  { ActCode: 1, ActDescription: 'Indian Penal Code, 1860', ShortName: 'IPC', Active: true },
  { ActCode: 2, ActDescription: 'Narcotic Drugs and Psychotropic Substances Act, 1985', ShortName: 'NDPS', Active: true },
  { ActCode: 3, ActDescription: 'Protection of Children from Sexual Offences Act, 2012', ShortName: 'POCSO', Active: true },
  { ActCode: 4, ActDescription: 'Information Technology Act, 2000', ShortName: 'IT Act', Active: true },
  { ActCode: 5, ActDescription: 'Arms Act, 1959', ShortName: 'Arms Act', Active: true },
];

const SECTIONS = [
  [1, '302', 'Punishment for murder'], [1, '307', 'Attempt to murder'],
  [1, '323', 'Punishment for voluntarily causing hurt'], [1, '324', 'Voluntarily causing hurt by dangerous weapons'],
  [1, '325', 'Punishment for voluntarily causing grievous hurt'], [1, '341', 'Punishment for wrongful restraint'],
  [1, '354', 'Assault or criminal force to woman'], [1, '363', 'Punishment for kidnapping'],
  [1, '364', 'Kidnapping in order to murder'], [1, '366', 'Kidnapping or abducting a woman'],
  [1, '379', 'Punishment for theft'], [1, '380', 'Theft in dwelling house'],
  [1, '384', 'Punishment for extortion'], [1, '386', 'Extortion by putting a person in fear of death'],
  [1, '392', 'Punishment for robbery'], [1, '395', 'Punishment for dacoity'],
  [1, '397', 'Robbery or dacoity with attempt to cause death'], [1, '406', 'Punishment for criminal breach of trust'],
  [1, '420', 'Cheating and dishonestly inducing delivery of property'], [1, '427', 'Mischief causing damage'],
  [1, '447', 'Punishment for criminal trespass'], [1, '457', 'Lurking house-trespass by night'],
  [1, '506', 'Punishment for criminal intimidation'], [1, '120B', 'Punishment of criminal conspiracy'],
  [1, '34', 'Acts done by several persons in furtherance of common intention'],
  [1, '149', 'Unlawful assembly with common object'],
  [2, '20(b)', 'Contravention in relation to cannabis plant and cannabis'],
  [2, '21(c)', 'Contravention in relation to manufactured drugs — commercial quantity'],
  [2, '22(c)', 'Contravention in relation to psychotropic substances — commercial quantity'],
  [2, '29', 'Abetment and criminal conspiracy under NDPS'],
  [3, '4', 'Punishment for penetrative sexual assault'], [3, '6', 'Punishment for aggravated penetrative sexual assault'],
  [4, '66C', 'Punishment for identity theft'], [4, '66D', 'Cheating by personation using computer resource'],
  [4, '43', 'Penalty for damage to computer system'],
  [5, '25', 'Punishment for acquisition or possession of arms'], [5, '27', 'Punishment for using arms'],
];
out.Section = SECTIONS.map(([ActCode, SectionCode, SectionDescription]) =>
  ({ ActCode, SectionCode, SectionDescription, Active: true }));

// crimeType -> [[ActCode, SectionCode], ...]
const CRIME_SECTIONS = {
  'Murder': [[1, '302'], [1, '34']],
  'Assault': [[1, '323'], [1, '324']],
  'Kidnapping': [[1, '363'], [1, '364']],
  'Robbery': [[1, '392'], [1, '397']],
  'Burglary': [[1, '457'], [1, '380']],
  'Vehicle Theft': [[1, '379'], [1, '427']],
  'Drug Trafficking': [[2, '20(b)'], [2, '21(c)'], [2, '29']],
  'Cybercrime': [[4, '66D'], [4, '66C'], [1, '420']],
  'Fraud': [[1, '420'], [1, '406']],
  'Gang Activity': [[1, '384'], [1, '386'], [1, '120B'], [1, '149']],
};

out.CrimeHeadActSection = [];
for (const [crime, pairs] of Object.entries(CRIME_SECTIONS)) {
  const head = subHeadFor[crime]?.head;
  if (!head) continue;
  for (const [ActCode, SectionCode] of pairs) {
    out.CrimeHeadActSection.push({ CrimeHeadID: head, ActCode, SectionCode });
  }
}

// ─────────────────────────── Courts ───────────────────────────
out.Court = [];
let courtSeq = 0;
const courtIdFor = {};
for (const d of activeDistricts) {
  const cjm = ++courtSeq;
  courtIdFor[d] = cjm;
  out.Court.push({ CourtID: cjm, CourtName: `Chief Judicial Magistrate Court, ${d}`, DistrictID: districtId[d], StateID: STATE_ID, Active: true });
  const sessions = ++courtSeq;
  out.Court.push({ CourtID: sessions, CourtName: `District & Sessions Court, ${d}`, DistrictID: districtId[d], StateID: STATE_ID, Active: true });
}

// ─────────────────────────── CaseMaster + children ───────────────────────────
out.CaseMaster = [];
out.ComplainantDetails = [];
out.Victim = [];
out.AccusedPerson = [];
out.ArrestSurrender = [];
out.ActSectionAssociation = [];
out.ChargesheetDetails = [];

let complainantSeq = 0, victimSeq = 0, accusedSeq = 0, arrestSeq = 0, csSeq = 0;
const serialByDistrictYear = {};

FIRS.forEach((f, idx) => {
  const caseId = idx + 1;
  const dId = districtId[f.district];
  const uId = unitIdFor[`${f.district}|${f.station}`];
  const year = (f.dateISO || '2025-01-01').slice(0, 4);
  const sKey = `${dId}|${year}`;
  serialByDistrictYear[sKey] = (serialByDistrictYear[sKey] || 0) + 1;

  // CrimeNo: 1-digit category + 4-digit district + 4-digit station + 4-digit year + 5-digit serial
  const CrimeNo = `1${pad(dId, 4)}${pad(uId, 4)}${year}${pad(serialByDistrictYear[sKey], 5)}`;

  const sub = subHeadFor[f.crimeType] || { id: 22, head: 8, heinous: false };
  const convicted = /convicted/i.test(f.status);
  const statusId = f.isOpen ? 1 : (convicted ? 3 : 2);
  const [lat, lng] = latLngFor(f.district);

  out.CaseMaster.push({
    CaseMasterID: caseId,
    CrimeNo,
    CaseNo: f.number,                       // original KSP/... reference preserved
    CrimeRegisteredDate: iso(f.dateISO),
    PolicePersonID: employeeIdFor[f.officer.split(',')[0].trim()] || null,
    PoliceStationID: uId,
    CaseCategoryID: 1,                      // FIR
    GravityOffenceID: sub.heinous ? 1 : 2,
    CrimeMajorHeadID: sub.head,
    CrimeMinorHeadID: sub.id,
    CaseStatusID: statusId,
    CourtID: f.isOpen ? null : courtIdFor[f.district],
    IncidentFromDate: iso(f.dateISO),
    IncidentToDate: iso(f.dateISO),
    InfoReceivedPSDate: iso(f.dateISO),
    latitude: lat,
    longitude: lng,
    // Full original narrative — preserves gang names, cross-district markers and
    // modus operandi that the alert builders and KB documents depend on.
    BriefFacts: RAW_BLOCK[f.number] || [
      `${f.crimeType} reported at ${f.location || f.station}, ${f.district}.`,
      f.accused.length ? `Accused: ${f.accused.join(', ')}.` : '',
      f.victim && f.victim !== 'N/A' ? `Victim: ${f.victim}.` : '',
      `Status: ${f.status}`,
      `Investigating Officer: ${f.officer}`,
    ].filter(Boolean).join(' '),
  });

  // Complainant — the victim reports the case where one is named.
  const victimName = (f.victim || '').replace(/\s*\([^)]*\)/g, '').split(',')[0].trim();
  if (victimName && victimName !== 'N/A') {
    out.ComplainantDetails.push({
      ComplainantID: ++complainantSeq, CaseMasterID: caseId, ComplainantName: victimName,
      AgeYear: null, OccupationID: NOT_RECORDED, ReligionID: NOT_RECORDED,
      CasteID: NOT_RECORDED, GenderID: GENDER_NOT_RECORDED,
    });
    out.Victim.push({
      VictimMasterID: ++victimSeq, CaseMasterID: caseId, VictimName: victimName,
      AgeYear: null, GenderID: GENDER_NOT_RECORDED, VictimPolice: false,
    });
  }

  // Accused — one row per accused per case, PersonID A1..An within the case.
  const caseAccusedIds = [];
  f.accused.forEach((name, i) => {
    const id = ++accusedSeq;
    caseAccusedIds.push({ id, name });
    out.AccusedPerson.push({
      AccusedMasterID: id, CaseMasterID: caseId, AccusedName: name,
      AgeYear: null, GenderID: GENDER_NOT_RECORDED, PersonID: `A${i + 1}`,
    });
  });

  // Acts & sections charged
  const pairs = CRIME_SECTIONS[f.crimeType] || [[1, '34']];
  pairs.forEach(([ActCode, SectionCode], i) => {
    out.ActSectionAssociation.push({
      CaseMasterID: caseId, ActID: ActCode, SectionID: SectionCode,
      ActOrderID: i + 1, SectionOrderID: i + 1,
    });
  });

  // Arrest events — mirrors the legacy timeline's arrest classification.
  if (f.eventType === 'arrest' && caseAccusedIds.length) {
    out.ArrestSurrender.push({
      ArrestSurrenderID: ++arrestSeq, CaseMasterID: caseId, ArrestSurrenderTypeID: 1,
      ArrestSurrenderDate: iso(f.dateISO), ArrestSurrenderStateId: STATE_ID,
      ArrestSurrenderDistrictId: dId, PoliceStationID: uId,
      IOID: employeeIdFor[f.officer.split(',')[0].trim()] || null,
      CourtID: courtIdFor[f.district] || null,
      AccusedMasterID: caseAccusedIds[0].id, IsAccused: true, IsComplainantAccused: false,
    });
  }

  // Chargesheet — every case that left investigation reached a chargesheet.
  if (!f.isOpen) {
    out.ChargesheetDetails.push({
      CSID: ++csSeq, CaseMasterID: caseId, csdate: iso(f.dateISO), cstype: 'A',
      PolicePersonID: employeeIdFor[f.officer.split(',')[0].trim()] || null,
    });
  }
});

// ─────────────────────────── Write + report ───────────────────────────
const outPath = path.resolve(__dirname, 'seed-data.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));

const { TABLES } = require('./schema');
console.log(`Wrote ${path.relative(process.cwd(), outPath)}\n`);
console.log('Row counts per table:');
let total = 0;
for (const t of TABLES) {
  const n = (out[t.name] || []).length;
  total += n;
  console.log(`  ${t.name.padEnd(24)} ${String(n).padStart(5)}${n === 0 ? '   <-- EMPTY' : ''}`);
}
console.log(`  ${'TOTAL'.padEnd(24)} ${String(total).padStart(5)} rows`);

// Integrity summary that must hold for demo continuity
const distinctAccused = new Set(out.AccusedPerson.map(a => a.AccusedName)).size;
const counts = {};
out.AccusedPerson.forEach(a => { counts[a.AccusedName] = (counts[a.AccusedName] || 0) + 1; });
console.log('\nContinuity checks:');
console.log(`  cases                 ${out.CaseMaster.length} (expect 65)`);
console.log(`  distinct accused      ${distinctAccused} (expect 124)`);
console.log(`  repeat offenders      ${Object.values(counts).filter(c => c >= 2).length} (expect 7)`);
console.log(`  arrest events         ${out.ArrestSurrender.length} (expect 14)`);
console.log(`  chargesheets          ${out.ChargesheetDetails.length}`);
console.log(`  under investigation   ${out.CaseMaster.filter(c => c.CaseStatusID === 1).length} (expect 39)`);
console.log(`  police stations       ${out.Unit.filter(u => u.TypeID === 1).length}`);
console.log(`  officers              ${out.Employee.length}`);
