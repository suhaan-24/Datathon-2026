'use strict';

/**
 * Flattens the normalized schema back into the narrative format the QuickML
 * Knowledge Base indexes, so RAG chat is sourced from the official schema
 * rather than the flat file.
 *
 * Each case is rendered by joining CaseMaster with Unit, District, Employee,
 * CrimeSubHead, CaseStatusMaster, Court, AccusedPerson, Victim,
 * ComplainantDetails, ActSectionAssociation, Act and Section — so the document
 * carries the FIR/CrimeNo, station, district, charges and people, which is what
 * the model cites in answers.
 *
 * Output: catalyst-kb/ksp-firs-knowledge-base.txt  (re-upload to the KB)
 * Run:    node scripts/generate-kb-docs.js
 */

const fs = require('fs');
const path = require('path');

const seed = require('./seed-data.json');

const index = (rows, key) => Object.fromEntries((rows || []).map(r => [String(r[key]), r]));
const unitById = index(seed.Unit, 'UnitID');
const districtById = index(seed.District, 'DistrictID');
const employeeById = index(seed.Employee, 'EmployeeID');
const subHeadById = index(seed.CrimeSubHead, 'CrimeSubHeadID');
const headById = index(seed.CrimeHead, 'CrimeHeadID');
const statusById = index(seed.CaseStatusMaster, 'CaseStatusID');
const courtById = index(seed.Court, 'CourtID');
const gravityById = index(seed.GravityOffence, 'GravityOffenceID');
const categoryById = index(seed.CaseCategory, 'CaseCategoryID');
const actByCode = index(seed.Act, 'ActCode');

const sectionDesc = {};
(seed.Section || []).forEach(s => { sectionDesc[`${s.ActCode}|${s.SectionCode}`] = s.SectionDescription; });

const groupBy = (rows, key) => (rows || []).reduce((acc, r) => {
  (acc[r[key]] ||= []).push(r); return acc;
}, {});
const accusedByCase = groupBy(seed.AccusedPerson, 'CaseMasterID');
const victimByCase = groupBy(seed.Victim, 'CaseMasterID');
const complainantByCase = groupBy(seed.ComplainantDetails, 'CaseMasterID');
const sectionsByCase = groupBy(seed.ActSectionAssociation, 'CaseMasterID');
const arrestsByCase = groupBy(seed.ArrestSurrender, 'CaseMasterID');
const csByCase = groupBy(seed.ChargesheetDetails, 'CaseMasterID');

const docs = (seed.CaseMaster || []).map(c => {
  const unit = unitById[String(c.PoliceStationID)] || {};
  const district = districtById[String(unit.DistrictID)] || {};
  const officer = employeeById[String(c.PolicePersonID)] || {};
  const sub = subHeadById[String(c.CrimeMinorHeadID)] || {};
  const head = headById[String(c.CrimeMajorHeadID)] || {};
  const status = statusById[String(c.CaseStatusID)] || {};
  const court = courtById[String(c.CourtID)] || {};
  const gravity = gravityById[String(c.GravityOffenceID)] || {};
  const category = categoryById[String(c.CaseCategoryID)] || {};

  const accused = (accusedByCase[c.CaseMasterID] || [])
    .map(a => `${a.AccusedName} (${a.PersonID})`).join(', ') || 'Not named';
  const victims = (victimByCase[c.CaseMasterID] || []).map(v => v.VictimName).join(', ') || 'N/A';
  const complainants = (complainantByCase[c.CaseMasterID] || []).map(x => x.ComplainantName).join(', ') || 'N/A';
  const charges = (sectionsByCase[c.CaseMasterID] || []).map(s => {
    const act = actByCode[String(s.ActID)] || {};
    const desc = sectionDesc[`${s.ActID}|${s.SectionID}`] || '';
    return `${act.ShortName || 'Act'} Section ${s.SectionID}${desc ? ` (${desc})` : ''}`;
  }).join('; ') || 'Not recorded';

  const arrests = (arrestsByCase[c.CaseMasterID] || [])
    .map(a => `Arrest recorded on ${String(a.ArrestSurrenderDate || '').slice(0, 10)}`).join('; ');
  const cs = (csByCase[c.CaseMasterID] || [])
    .map(x => `Chargesheet filed on ${String(x.csdate || '').slice(0, 10)}`).join('; ');

  return [
    `FIR Number: ${c.CaseNo}`,
    `Crime Number: ${c.CrimeNo}`,
    `Case Category: ${category.LookupValue || 'FIR'}`,
    `Date: ${String(c.CrimeRegisteredDate || '').slice(0, 10)}`,
    `Police Station: ${unit.UnitName || ''}`,
    `District: ${district.DistrictName || ''}`,
    `Crime Head: ${head.CrimeGroupName || ''}`,
    `Crime Type: ${sub.CrimeHeadName || ''}`,
    `Gravity: ${gravity.LookupValue || ''}`,
    `Accused Name(s): ${accused}`,
    `Victim Name: ${victims}`,
    `Complainant: ${complainants}`,
    `Acts and Sections: ${charges}`,
    `Status: ${status.CaseStatusName || ''}`,
    court.CourtName ? `Court: ${court.CourtName}` : '',
    arrests ? `Arrest Details: ${arrests}` : '',
    cs ? `Chargesheet: ${cs}` : '',
    `Assigned Officer: ${officer.FirstName || ''}`,
    `Location: latitude ${c.latitude}, longitude ${c.longitude}`,
    '',
    'Brief Facts:',
    String(c.BriefFacts || '').trim(),
  ].filter(Boolean).join('\n');
});

const outPath = path.resolve(__dirname, '..', 'catalyst-kb', 'ksp-firs-knowledge-base.txt');
const body = docs.join('\n\n' + '='.repeat(72) + '\n\n') + '\n';
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, body);

const bytes = Buffer.byteLength(body);
console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
console.log(`  ${docs.length} case documents · ${(bytes / 1024).toFixed(1)} KB`);
console.log(`  KB limit is 500 KB per .txt — ${bytes > 500 * 1024 ? 'OVER LIMIT!' : 'within limit'}`);
console.log(`  mentions "Black Cobra": ${(body.match(/black cobra/gi) || []).length}`);
console.log(`  mentions CrimeNo codes: ${(body.match(/Crime Number: \d{18}/g) || []).length}`);
