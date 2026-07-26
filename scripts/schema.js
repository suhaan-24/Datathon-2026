'use strict';

/**
 * Official KSP FIR database schema, as released by the KSP Datathon 2026
 * organisers' Database Design Document.
 *
 * This module is the single source of truth: it drives the console setup guide
 * (scripts/generate-setup-guide.js), the seed generator (generate-seed-data.js)
 * and the backend's ZCQL query builders.
 *
 * Catalyst Data Store cannot create tables programmatically — the SDK exposes
 * only getAllTables/getTableDetails/table(id) — so these definitions are
 * rendered into a console setup guide for manual creation.
 *
 * Column type vocabulary maps to Catalyst Data Store's picker:
 *   INT      -> Number / BigInt
 *   VARCHAR  -> Text (with the given max length)
 *   TEXT     -> Text at maximum length (BriefFacts etc.)
 *   DATE     -> Date
 *   DATETIME -> DateTime
 *   DECIMAL  -> Double (latitude/longitude)
 *   BOOLEAN  -> Boolean (schema BIT fields)
 *
 * Catalyst adds ROWID/CREATEDTIME/MODIFIEDTIME automatically — the *ID primary
 * keys below are plain INT columns we populate and join on ourselves, since
 * Data Store does not enforce foreign keys.
 */

const T = { INT: 'INT', VARCHAR: 'VARCHAR', TEXT: 'TEXT', DATE: 'DATE', DATETIME: 'DATETIME', DECIMAL: 'DECIMAL', BOOLEAN: 'BOOLEAN' };

/** @type {{name:string, group:'lookup'|'transactional', purpose:string, columns:{name:string,type:string,len?:number,note?:string}[]}[]} */
const TABLES = [
  // ─────────────────────────── LOOKUP / MASTER ───────────────────────────
  {
    name: 'State', group: 'lookup', purpose: 'States (Karnataka only for this dataset)',
    columns: [
      { name: 'StateID', type: T.INT, note: 'PK' },
      { name: 'StateName', type: T.VARCHAR, len: 100 },
      { name: 'NationalityID', type: T.INT },
      { name: 'Active', type: T.BOOLEAN },
    ],
  },
  {
    name: 'District', group: 'lookup', purpose: 'All 31 Karnataka districts',
    columns: [
      { name: 'DistrictID', type: T.INT, note: 'PK' },
      { name: 'DistrictName', type: T.VARCHAR, len: 100 },
      { name: 'StateID', type: T.INT, note: 'FK -> State' },
      { name: 'Active', type: T.BOOLEAN },
    ],
  },
  {
    name: 'UnitType', group: 'lookup', purpose: 'Police Station / Circle Office / Sub-Division / District HQ',
    columns: [
      { name: 'UnitTypeID', type: T.INT, note: 'PK' },
      { name: 'UnitTypeName', type: T.VARCHAR, len: 100 },
      { name: 'CityDistState', type: T.VARCHAR, len: 50 },
      { name: 'Hierarchy', type: T.INT },
      { name: 'Active', type: T.BOOLEAN },
    ],
  },
  {
    name: 'Unit', group: 'lookup', purpose: '~50 police stations and higher units',
    columns: [
      { name: 'UnitID', type: T.INT, note: 'PK' },
      { name: 'UnitName', type: T.VARCHAR, len: 150 },
      { name: 'TypeID', type: T.INT, note: 'FK -> UnitType' },
      { name: 'ParentUnit', type: T.INT, note: 'self-FK -> Unit' },
      { name: 'NationalityID', type: T.INT },
      { name: 'StateID', type: T.INT, note: 'FK -> State' },
      { name: 'DistrictID', type: T.INT, note: 'FK -> District' },
      { name: 'Active', type: T.BOOLEAN },
    ],
  },
  {
    name: 'Rank', group: 'lookup', purpose: 'Constable .. SP',
    columns: [
      { name: 'RankID', type: T.INT, note: 'PK' },
      { name: 'RankName', type: T.VARCHAR, len: 100 },
      { name: 'Hierarchy', type: T.INT },
      { name: 'Active', type: T.BOOLEAN },
    ],
  },
  {
    name: 'Designation', group: 'lookup', purpose: 'IO / SHO / Beat Officer / Circle Inspector / Superintendent',
    columns: [
      { name: 'DesignationID', type: T.INT, note: 'PK' },
      { name: 'DesignationName', type: T.VARCHAR, len: 100 },
      { name: 'Active', type: T.BOOLEAN },
      { name: 'SortOrder', type: T.INT },
    ],
  },
  {
    name: 'Employee', group: 'lookup', purpose: '~50 officers (investigating officers referenced by cases)',
    columns: [
      { name: 'EmployeeID', type: T.INT, note: 'PK' },
      { name: 'DistrictID', type: T.INT, note: 'FK -> District' },
      { name: 'UnitID', type: T.INT, note: 'FK -> Unit' },
      { name: 'RankID', type: T.INT, note: 'FK -> Rank' },
      { name: 'DesignationID', type: T.INT, note: 'FK -> Designation' },
      { name: 'KGID', type: T.VARCHAR, len: 20 },
      { name: 'FirstName', type: T.VARCHAR, len: 150 },
      { name: 'EmployeeDOB', type: T.DATE },
      { name: 'GenderID', type: T.INT },
      { name: 'BloodGroupID', type: T.INT },
      { name: 'PhysicallyChallenged', type: T.BOOLEAN },
      { name: 'AppointmentDate', type: T.DATE },
    ],
  },
  {
    name: 'CaseCategory', group: 'lookup', purpose: 'FIR, UDR, Zero FIR, PAR',
    columns: [
      { name: 'CaseCategoryID', type: T.INT, note: 'PK' },
      { name: 'LookupValue', type: T.VARCHAR, len: 50 },
    ],
  },
  {
    name: 'GravityOffence', group: 'lookup', purpose: 'Heinous / Non-Heinous',
    columns: [
      { name: 'GravityOffenceID', type: T.INT, note: 'PK' },
      { name: 'LookupValue', type: T.VARCHAR, len: 50 },
    ],
  },
  {
    name: 'CrimeHead', group: 'lookup', purpose: '8 major crime groups',
    columns: [
      { name: 'CrimeHeadID', type: T.INT, note: 'PK' },
      { name: 'CrimeGroupName', type: T.VARCHAR, len: 150 },
      { name: 'Active', type: T.BOOLEAN },
    ],
  },
  {
    name: 'CrimeSubHead', group: 'lookup', purpose: '~20 sub-heads (Murder, Robbery, Cyber Fraud, ...)',
    columns: [
      { name: 'CrimeSubHeadID', type: T.INT, note: 'PK' },
      { name: 'CrimeHeadID', type: T.INT, note: 'FK -> CrimeHead' },
      { name: 'CrimeHeadName', type: T.VARCHAR, len: 150 },
      { name: 'SeqID', type: T.INT },
    ],
  },
  {
    name: 'Act', group: 'lookup', purpose: 'IPC, NDPS, POCSO, IT Act, Arms Act',
    columns: [
      { name: 'ActCode', type: T.INT, note: 'PK' },
      { name: 'ActDescription', type: T.VARCHAR, len: 200 },
      { name: 'ShortName', type: T.VARCHAR, len: 50 },
      { name: 'Active', type: T.BOOLEAN },
    ],
  },
  {
    name: 'Section', group: 'lookup', purpose: '~30 sections across the acts',
    columns: [
      { name: 'ActCode', type: T.INT, note: 'FK -> Act' },
      { name: 'SectionCode', type: T.VARCHAR, len: 30, note: 'part of composite key' },
      { name: 'SectionDescription', type: T.VARCHAR, len: 300 },
      { name: 'Active', type: T.BOOLEAN },
    ],
  },
  {
    name: 'CrimeHeadActSection', group: 'lookup', purpose: 'Maps crime heads to act/section',
    columns: [
      { name: 'CrimeHeadID', type: T.INT, note: 'FK -> CrimeHead' },
      { name: 'ActCode', type: T.INT, note: 'FK -> Act' },
      { name: 'SectionCode', type: T.VARCHAR, len: 30, note: 'FK -> Section' },
    ],
  },
  {
    name: 'CasteMaster', group: 'lookup', purpose: 'Official government caste category list',
    columns: [
      { name: 'caste_master_id', type: T.INT, note: 'PK — lowercase per schema doc' },
      { name: 'caste_master_name', type: T.VARCHAR, len: 100 },
    ],
  },
  {
    name: 'ReligionMaster', group: 'lookup', purpose: 'Official religion list',
    columns: [
      { name: 'ReligionID', type: T.INT, note: 'PK' },
      { name: 'ReligionName', type: T.VARCHAR, len: 100 },
    ],
  },
  {
    name: 'OccupationMaster', group: 'lookup', purpose: 'Official occupation list',
    columns: [
      { name: 'OccupationID', type: T.INT, note: 'PK' },
      { name: 'OccupationName', type: T.VARCHAR, len: 100 },
    ],
  },
  {
    name: 'CaseStatusMaster', group: 'lookup', purpose: 'Under Investigation / Charge Sheeted / Closed / Undetected',
    columns: [
      { name: 'CaseStatusID', type: T.INT, note: 'PK' },
      { name: 'CaseStatusName', type: T.VARCHAR, len: 100 },
    ],
  },
  {
    name: 'Court', group: 'lookup', purpose: '~20 courts across the active districts',
    columns: [
      { name: 'CourtID', type: T.INT, note: 'PK' },
      { name: 'CourtName', type: T.VARCHAR, len: 200 },
      { name: 'DistrictID', type: T.INT, note: 'FK -> District' },
      { name: 'StateID', type: T.INT, note: 'FK -> State' },
      { name: 'Active', type: T.BOOLEAN },
    ],
  },

  // ─────────────────────────── TRANSACTIONAL ───────────────────────────
  {
    name: 'CaseMaster', group: 'transactional', purpose: '65 FIR cases — the spine of the schema',
    columns: [
      { name: 'CaseMasterID', type: T.INT, note: 'PK' },
      { name: 'CrimeNo', type: T.VARCHAR, len: 30, note: '1+4+4+4+5 encoded, e.g. 104430006202600001' },
      { name: 'CaseNo', type: T.VARCHAR, len: 50 },
      { name: 'CrimeRegisteredDate', type: T.DATETIME },
      { name: 'PolicePersonID', type: T.INT, note: 'FK -> Employee' },
      { name: 'PoliceStationID', type: T.INT, note: 'FK -> Unit' },
      { name: 'CaseCategoryID', type: T.INT, note: 'FK -> CaseCategory' },
      { name: 'GravityOffenceID', type: T.INT, note: 'FK -> GravityOffence' },
      { name: 'CrimeMajorHeadID', type: T.INT, note: 'FK -> CrimeHead' },
      { name: 'CrimeMinorHeadID', type: T.INT, note: 'FK -> CrimeSubHead' },
      { name: 'CaseStatusID', type: T.INT, note: 'FK -> CaseStatusMaster' },
      { name: 'CourtID', type: T.INT, note: 'FK -> Court' },
      { name: 'IncidentFromDate', type: T.DATETIME },
      { name: 'IncidentToDate', type: T.DATETIME },
      { name: 'InfoReceivedPSDate', type: T.DATETIME },
      { name: 'latitude', type: T.DECIMAL },
      { name: 'longitude', type: T.DECIMAL },
      { name: 'BriefFacts', type: T.TEXT, note: 'MAX length — case narrative' },
    ],
  },
  {
    name: 'ComplainantDetails', group: 'transactional', purpose: 'One or more complainants per case',
    columns: [
      { name: 'ComplainantID', type: T.INT, note: 'PK' },
      { name: 'CaseMasterID', type: T.INT, note: 'FK -> CaseMaster' },
      { name: 'ComplainantName', type: T.VARCHAR, len: 150 },
      { name: 'AgeYear', type: T.INT },
      { name: 'OccupationID', type: T.INT, note: 'FK -> OccupationMaster' },
      { name: 'ReligionID', type: T.INT, note: 'FK -> ReligionMaster' },
      { name: 'CasteID', type: T.INT, note: 'FK -> CasteMaster' },
      { name: 'GenderID', type: T.INT },
    ],
  },
  {
    name: 'ActSectionAssociation', group: 'transactional', purpose: 'Acts/sections charged per case',
    columns: [
      { name: 'CaseMasterID', type: T.INT, note: 'FK -> CaseMaster' },
      { name: 'ActID', type: T.INT, note: 'FK -> Act.ActCode' },
      { name: 'SectionID', type: T.VARCHAR, len: 30, note: 'FK -> Section.SectionCode' },
      { name: 'ActOrderID', type: T.INT },
      { name: 'SectionOrderID', type: T.INT },
    ],
  },
  {
    name: 'Victim', group: 'transactional', purpose: 'Victims per case',
    columns: [
      { name: 'VictimMasterID', type: T.INT, note: 'PK' },
      { name: 'CaseMasterID', type: T.INT, note: 'FK -> CaseMaster' },
      { name: 'VictimName', type: T.VARCHAR, len: 150 },
      { name: 'AgeYear', type: T.INT },
      { name: 'GenderID', type: T.INT },
      { name: 'VictimPolice', type: T.BOOLEAN },
    ],
  },
  {
    name: 'AccusedPerson', group: 'transactional',
    purpose: '124 accused rows. NOTE: schema calls this "Accused"; renamed to avoid colliding with the existing Accused table',
    columns: [
      { name: 'AccusedMasterID', type: T.INT, note: 'PK' },
      { name: 'CaseMasterID', type: T.INT, note: 'FK -> CaseMaster' },
      { name: 'AccusedName', type: T.VARCHAR, len: 150 },
      { name: 'AgeYear', type: T.INT },
      { name: 'GenderID', type: T.INT },
      { name: 'PersonID', type: T.VARCHAR, len: 10, note: 'A1, A2, A3 ... within a case' },
    ],
  },
  {
    name: 'ArrestSurrender', group: 'transactional', purpose: '~14 arrest/surrender events',
    columns: [
      { name: 'ArrestSurrenderID', type: T.INT, note: 'PK' },
      { name: 'CaseMasterID', type: T.INT, note: 'FK -> CaseMaster' },
      { name: 'ArrestSurrenderTypeID', type: T.INT, note: '1=Arrest, 2=Surrender' },
      { name: 'ArrestSurrenderDate', type: T.DATETIME },
      { name: 'ArrestSurrenderStateId', type: T.INT, note: 'FK -> State' },
      { name: 'ArrestSurrenderDistrictId', type: T.INT, note: 'FK -> District' },
      { name: 'PoliceStationID', type: T.INT, note: 'FK -> Unit' },
      { name: 'IOID', type: T.INT, note: 'FK -> Employee' },
      { name: 'CourtID', type: T.INT, note: 'FK -> Court' },
      { name: 'AccusedMasterID', type: T.INT, note: 'FK -> AccusedPerson' },
      { name: 'IsAccused', type: T.BOOLEAN },
      { name: 'IsComplainantAccused', type: T.BOOLEAN },
    ],
  },
  {
    name: 'ChargesheetDetails', group: 'transactional', purpose: '18 chargesheeted cases',
    columns: [
      { name: 'CSID', type: T.INT, note: 'PK' },
      { name: 'CaseMasterID', type: T.INT, note: 'FK -> CaseMaster' },
      { name: 'csdate', type: T.DATETIME },
      { name: 'cstype', type: T.VARCHAR, len: 1, note: 'A=Chargesheet, B=False Case, C=Undetected' },
      { name: 'PolicePersonID', type: T.INT, note: 'FK -> Employee' },
    ],
  },
];

const totalColumns = TABLES.reduce((n, t) => n + t.columns.length, 0);

module.exports = { TABLES, TYPES: T, totalColumns };
