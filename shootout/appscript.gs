/**
 * Progressive Shootout Tournament API
 *
 * Endpoints implemented:
 *   getState
 *   addPlayer / removePlayer
 *   addDonation / removeDonation
 *   updateSetting
 *   resetTournament
 *   startTournament                (locks roster only, no table creation)
 *   recordTableResult              (Stage 1 only currently)
 *   editTableResult                (Stage 1 only, locked once downstream cascade exists)
 *   reseatStage1                   (legacy random reseat, kept for fallback)
 *   addTimeSlot / removeTimeSlot
 *   submitAvailability             (multi-select: comma-separated availableSlotIds)
 *   previewStageTables             (Stage 1, 2, 3 — runs algorithm without committing)
 *   commitStageTables              (writes a previewed plan to the Tables sheet)
 *
 * Availability sheet schema:
 *   A=tornId  B=name  C=availableSlotIds  D=submittedAt  E=browserId
 *
 *   availableSlotIds is a comma-separated string of slot IDs, e.g. "slot_0,slot_4,slot_18".
 *   browserId is a per-browser UUID set by the client (localStorage). Used to spot
 *   when one browser submitted on behalf of multiple players.
 */

// ===== CONFIG =====
var SHEETS = {
  SETTINGS: 'Settings',
  PLAYERS: 'Players',
  DONATIONS: 'Donations',
  TABLES: 'Tables',
  ELIMINATIONS: 'Eliminations',
  QUEUES: 'StageQueues',
  TIMESLOTS: 'TimeSlots',
  AVAILABILITY: 'Availability',
  STEWARDS: 'Stewards',
  STEWARD_AVAILABILITY: 'StewardAvailability',
  STEWARD_ASSIGNMENTS: 'StewardAssignments'
};

var STEWARD_SHEET_HEADERS = {
  Stewards: ['stewardId', 'name', 'tornId', 'createdAt'],
  StewardAvailability: ['stewardId', 'slotId', 'addedAt'],
  StewardAssignments: ['tableId', 'stewardId', 'assignedAt']
};

var STATUS = {
  SETUP: 'setup',
  ACTIVE: 'active',
  COMPLETE: 'complete'
};

// Tables sheet column layout (1-indexed for sheet operations)
// A=tableId, B=stage, C=tableSize, D=status, E=firedAt, F=completedAt,
// G..O = player1_id..player9_id (9 cols),
// P=place_1_id, Q=place_2_id, R=place_3_id, S=notes, T=timeSlotId
var TABLE_COL = {
  tableId: 1, stage: 2, tableSize: 3, status: 4, firedAt: 5, completedAt: 6,
  player1: 7, player9: 15,
  place1: 16, place2: 17, place3: 18,
  notes: 19, timeSlotId: 20
};

// ===== ROUTER =====
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  var params = (e && e.parameter) || {};

  try {
    var result;
    switch (action) {
      case 'getState':              result = getState(); break;
      case 'addPlayer':             result = addPlayer(params); break;
      case 'removePlayer':          result = removePlayer(params); break;
      case 'addDonation':           result = addDonation(params); break;
      case 'removeDonation':        result = removeDonation(params); break;
      case 'updateSetting':         result = updateSetting(params); break;
      case 'resetTournament':       result = resetTournament(); break;
      case 'startTournament':       result = startTournament(); break;
      case 'recordTableResult':     result = recordTableResult(params); break;
      case 'editTableResult':       result = editTableResult(params); break;
      case 'reseatStage1':          result = reseatStage1(); break;
      case 'addTimeSlot':           result = addTimeSlot(params); break;
      case 'removeTimeSlot':        result = removeTimeSlot(params); break;
      case 'submitAvailability':    result = submitAvailability(params); break;
      case 'previewStageTables':    result = previewStageTables(params); break;
      case 'commitStageTables':     result = commitStageTables(params); break;
      case 'addSteward':            result = addSteward(params); break;
      case 'removeSteward':         result = removeSteward(params); break;
      case 'setStewardAvailability': result = setStewardAvailability(params); break;
      case 'assignSteward':         result = assignSteward(params); break;
      case 'unassignSteward':       result = unassignSteward(params); break;
      case 'verifyStewardLogin':    result = verifyStewardLogin(params); break;
      default:
        result = { error: 'Unknown action: ' + action };
    }
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ error: err.message || String(err) });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== STATE =====
function getState() {
  return {
    settings: readSettings(),
    players: readPlayers(),
    donations: readDonations(),
    tables: readTables(),
    eliminations: readEliminations(),
    queues: readQueues(),
    timeSlots: readTimeSlots(),
    availability: readAvailability(),
    stewards: readStewards(),
    stewardAvailability: readStewardAvailability(),
    stewardAssignments: readStewardAssignments()
  };
}

// ===== SETTINGS =====
function readSettings() {
  var rows = readSheet(SHEETS.SETTINGS);
  var obj = {};
  rows.forEach(function(r) {
    if (r.key) obj[r.key] = r.value;
  });
  return obj;
}

function updateSetting(params) {
  var key = String(params.key || '').trim();
  var value = params.value;
  if (!key) return { error: 'key required' };

  var sheet = getSheet(SHEETS.SETTINGS);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return { message: 'Setting updated', key: key, value: value };
    }
  }
  sheet.appendRow([key, value, '']);
  return { message: 'Setting added', key: key, value: value };
}

// ===== PLAYERS =====
function readPlayers() {
  return readSheet(SHEETS.PLAYERS).map(function(r) {
    return {
      tornId: String(r.tornId || ''),
      name: r.name || '',
      registeredAt: formatDate(r.registeredAt),
      status: r.status || 'active',
      currentStage: r.currentStage === '' ? null : r.currentStage,
      rebuysUsed: Number(r.rebuysUsed) || 0
    };
  });
}

function addPlayer(params) {
  var status = readSettings().tournament_status || STATUS.SETUP;
  if (status !== STATUS.SETUP) {
    return { error: 'Cannot add players once the tournament has started' };
  }

  var name = String(params.name || '').trim();
  var tornId = String(params.tornId || '').trim();
  if (!name || !tornId) return { error: 'Name and Torn ID required' };
  if (!/^\d+$/.test(tornId)) return { error: 'Torn ID must be numeric' };

  var existing = readPlayers();
  if (existing.some(function(p) { return p.tornId === tornId; })) {
    return { error: 'Player with that Torn ID already registered' };
  }

  getSheet(SHEETS.PLAYERS).appendRow([
    tornId, name, new Date(), 'active', '', 0
  ]);
  return { message: name + ' added', tornId: tornId };
}

function removePlayer(params) {
  var status = readSettings().tournament_status || STATUS.SETUP;
  if (status !== STATUS.SETUP) {
    return { error: 'Cannot remove players once the tournament has started' };
  }

  var tornId = String(params.tornId || '').trim();
  if (!tornId) return { error: 'Torn ID required' };

  var sheet = getSheet(SHEETS.PLAYERS);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === tornId) {
      var name = data[i][1];
      sheet.deleteRow(i + 1);
      return { message: name + ' removed', tornId: tornId };
    }
  }
  return { error: 'Player not found' };
}

// ===== DONATIONS =====
function readDonations() {
  return readSheet(SHEETS.DONATIONS).map(function(r) {
    return {
      donorName: r.donorName || '',
      amount: Number(r.amount) || 0,
      addedAt: formatDate(r.addedAt)
    };
  });
}

function addDonation(params) {
  var donorName = String(params.donorName || '').trim();
  var amount = parseInt(String(params.amount || '').replace(/[^0-9]/g, ''), 10);
  if (!donorName) return { error: 'Donor name required' };
  if (!amount || amount <= 0) return { error: 'Valid amount required' };

  getSheet(SHEETS.DONATIONS).appendRow([donorName, amount, new Date()]);
  return { message: 'Donation recorded', donorName: donorName, amount: amount };
}

function removeDonation(params) {
  var index = parseInt(params.index, 10);
  if (isNaN(index) || index < 0) return { error: 'Valid index required' };

  var sheet = getSheet(SHEETS.DONATIONS);
  var rowNum = index + 2;
  if (rowNum > sheet.getLastRow()) return { error: 'Donation not found' };

  sheet.deleteRow(rowNum);
  return { message: 'Donation removed' };
}

// ===== TABLES =====
function readTables() {
  return readSheet(SHEETS.TABLES).map(function(r) {
    var players = [];
    for (var i = 1; i <= 9; i++) {
      var pid = String(r['player' + i + '_id'] || '');
      if (pid) players.push(pid);
    }
    return {
      tableId: r.tableId || '',
      stage: r.stage || '',
      tableSize: Number(r.tableSize) || 0,
      status: r.status || '',
      firedAt: formatDate(r.firedAt),
      completedAt: formatDate(r.completedAt),
      players: players,
      place1: String(r.place_1_id || ''),
      place2: String(r.place_2_id || ''),
      place3: String(r.place_3_id || ''),
      notes: r.notes || '',
      timeSlotId: String(r.timeSlotId || '')
    };
  });
}

// ===== ELIMINATIONS =====
function readEliminations() {
  return readSheet(SHEETS.ELIMINATIONS).map(function(r) {
    return {
      tornId: String(r.tornId || ''),
      name: r.name || '',
      tableId: r.tableId || '',
      stageLostAt: r.stageLostAt,
      eliminatedAt: formatDate(r.eliminatedAt),
      rebuyTaken: r.rebuyTaken || 'no',
      rebuyTableId: r.rebuyTableId || ''
    };
  });
}

// ===== QUEUES =====
function readQueues() {
  return readSheet(SHEETS.QUEUES).map(function(r) {
    return {
      tornId: String(r.tornId || ''),
      name: r.name || '',
      queuedFor: r.queuedFor || '',
      queuedAt: formatDate(r.queuedAt),
      source: r.source || ''
    };
  });
}

// ===== RESET =====
function resetTournament() {
  [SHEETS.TABLES, SHEETS.ELIMINATIONS, SHEETS.QUEUES].forEach(function(name) {
    var sheet = getSheet(name);
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
    }
  });

  var playersSheet = getSheet(SHEETS.PLAYERS);
  var lastRow = playersSheet.getLastRow();
  if (lastRow > 1) {
    var range = playersSheet.getRange(2, 4, lastRow - 1, 3);
    var values = range.getValues();
    for (var i = 0; i < values.length; i++) {
      values[i][0] = 'active';
      values[i][1] = '';
      values[i][2] = 0;
    }
    range.setValues(values);
  }

  updateSetting({ key: 'tournament_status', value: STATUS.SETUP });
  updateSetting({ key: 'champion_name', value: '' });
  updateSetting({ key: 'champion_torn_id', value: '' });

  return { message: 'Tournament reset' };
}

// ===== START TOURNAMENT =====
//
// Locks the roster and marks the tournament active. Does NOT create tables.
// Stage 1 tables are generated via the availability-based flow (previewStageTables/commitStageTables).
function startTournament() {
  var settings = readSettings();
  var status = settings.tournament_status || STATUS.SETUP;
  if (status !== STATUS.SETUP) {
    return { error: 'Tournament has already started' };
  }

  var players = readPlayers();
  if (players.length < 2) {
    return { error: 'Need at least 2 players to start' };
  }

  var playersSheet = getSheet(SHEETS.PLAYERS);
  var lastRow = playersSheet.getLastRow();
  if (lastRow > 1) {
    var range = playersSheet.getRange(2, 5, lastRow - 1, 1);
    var values = range.getValues();
    for (var p = 0; p < values.length; p++) {
      values[p][0] = 1;
    }
    range.setValues(values);
  }

  updateSetting({ key: 'tournament_status', value: STATUS.ACTIVE });

  return {
    message: 'Tournament started. Roster locked. Generate Stage 1 tables via the availability admin.',
    players: players.length
  };
}

// ===== RECORD TABLE RESULT (Stage 1) =====
function recordTableResult(params) {
  var tableId = String(params.tableId || '').trim();
  if (!tableId) return { error: 'tableId required' };

  var place1 = String(params.place1 || '').trim();
  var place2 = String(params.place2 || '').trim();
  var place3 = String(params.place3 || '').trim();
  if (!place1) return { error: '1st place required' };

  var tablesSheet = getSheet(SHEETS.TABLES);
  var data = tablesSheet.getDataRange().getValues();
  var tableRowIdx = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === tableId) {
      tableRowIdx = i;
      break;
    }
  }
  if (tableRowIdx === -1) return { error: 'Table not found: ' + tableId };

  var rowData = data[tableRowIdx];
  var stage = String(rowData[1]);
  var size = Number(rowData[2]);
  var status = String(rowData[3]);

  if (stage !== '1' && stage !== '2' && stage !== '3') {
    return { error: 'recordTableResult only handles Stage 1, 2 and 3 tables (got: ' + stage + ')' };
  }
  if (status !== 'live') return { error: 'Table is not live (status: ' + status + ')' };

  if (stage === '1') {
    if (size >= 4 && !place2) return { error: '2nd place required for tables of 4+' };
    if (size >= 7 && !place3) return { error: '3rd place required for tables of 7+' };
  } else if (stage === '2') {
    if (size >= 2 && !place2) return { error: '2nd place required for Stage 2 tables' };
    place3 = '';
  } else if (stage === '3') {
    // Knockout: only the winner advances; ignore any 2nd/3rd input.
    place2 = '';
    place3 = '';
  }

  var picks = [place1];
  if (place2) picks.push(place2);
  if (place3) picks.push(place3);
  var pickSet = {};
  for (var p = 0; p < picks.length; p++) {
    if (pickSet[picks[p]]) return { error: 'Same player selected for multiple places' };
    pickSet[picks[p]] = true;
  }

  var tablePlayerIds = [];
  for (var c = 6; c < 15; c++) {
    var pid = String(rowData[c] || '');
    if (pid) tablePlayerIds.push(pid);
  }
  for (var pp = 0; pp < picks.length; pp++) {
    if (tablePlayerIds.indexOf(picks[pp]) === -1) {
      return { error: 'Player ' + picks[pp] + ' is not at this table' };
    }
  }

  // Per-stage advancement destinations, keyed by finishing place.
  var DEST_BY_STAGE = {
    '1': { 1: 'stage_4', 2: 'stage_3', 3: 'stage_2' },
    '2': { 1: 'stage_4', 2: 'stage_3' },
    '3': { 1: 'stage_4' }
  };
  var destMap = DEST_BY_STAGE[stage];
  var shortWalkover = (stage === '1' && size < 4);

  var advancers = [];
  if (place1 && destMap[1]) {
    advancers.push({ tornId: place1, dest: destMap[1], source: tableId + ' 1st' + (shortWalkover ? ' (short table walkover)' : '') });
  }
  if (place2 && destMap[2]) {
    advancers.push({ tornId: place2, dest: destMap[2], source: tableId + ' 2nd' });
  }
  if (place3 && destMap[3]) {
    advancers.push({ tornId: place3, dest: destMap[3], source: tableId + ' 3rd' });
  }

  var advancerIds = advancers.map(function(a) { return a.tornId; });
  var losers = tablePlayerIds.filter(function(pid) { return advancerIds.indexOf(pid) === -1; });

  // Players (among the losers) the steward ticked as wanting a rebuy.
  var rebuyIds = parseSlotList_(params.rebuys);
  var loserSet = {};
  losers.forEach(function(pid) { loserSet[pid] = true; });
  for (var ri = 0; ri < rebuyIds.length; ri++) {
    if (!loserSet[rebuyIds[ri]]) {
      return { error: 'Rebuy player ' + rebuyIds[ri] + ' is not an eliminated player at this table' };
    }
  }
  var rebuySet = {};
  rebuyIds.forEach(function(pid) { rebuySet[pid] = true; });

  var allPlayers = readPlayers();
  function findPlayer(tornId) {
    return allPlayers.filter(function(p) { return p.tornId === tornId; })[0];
  }

  var sheetRow = tableRowIdx + 1;
  tablesSheet.getRange(sheetRow, 4).setValue('complete');
  tablesSheet.getRange(sheetRow, 6).setValue(new Date());
  tablesSheet.getRange(sheetRow, 16).setValue(place1);
  tablesSheet.getRange(sheetRow, 17).setValue(place2 || '');
  tablesSheet.getRange(sheetRow, 18).setValue(place3 || '');

  var queuesSheet = getSheet(SHEETS.QUEUES);
  var queueRows = advancers.map(function(a) {
    var pl = findPlayer(a.tornId);
    return [a.tornId, pl ? pl.name : '', a.dest, new Date(), a.source];
  });
  if (queueRows.length > 0) {
    queuesSheet.getRange(queuesSheet.getLastRow() + 1, 1, queueRows.length, 5).setValues(queueRows);
  }

  var elimSheet = getSheet(SHEETS.ELIMINATIONS);
  var stageNum = Number(stage);
  var elimRows = losers.map(function(pid) {
    var pl = findPlayer(pid);
    return [pid, pl ? pl.name : '', tableId, stageNum, new Date(), rebuySet[pid] ? 'yes' : 'no', ''];
  });
  if (elimRows.length > 0) {
    elimSheet.getRange(elimSheet.getLastRow() + 1, 1, elimRows.length, 7).setValues(elimRows);
  }

  if (losers.length > 0) {
    var playersSheet = getSheet(SHEETS.PLAYERS);
    var playersData = playersSheet.getDataRange().getValues();
    for (var pi = 1; pi < playersData.length; pi++) {
      if (losers.indexOf(String(playersData[pi][0])) !== -1) {
        playersSheet.getRange(pi + 1, 4).setValue('eliminated');
        playersSheet.getRange(pi + 1, 5).setValue('');
      }
    }
  }

  return {
    message: 'Result recorded for ' + tableId,
    tableId: tableId,
    advancers: advancers.length,
    eliminated: losers.length,
    rebuys: rebuyIds.length
  };
}

// ===== EDIT TABLE RESULT =====
function editTableResult(params) {
  var tableId = String(params.tableId || '').trim();
  if (!tableId) return { error: 'tableId required' };

  var allTables = readTables();
  var thisTable = allTables.filter(function(t) { return t.tableId === tableId; })[0];
  if (!thisTable) return { error: 'Table not found' };
  if (thisTable.status !== 'complete') return { error: 'Table is not complete; nothing to edit' };

  var stage = String(thisTable.stage);
  if (stage !== '1' && stage !== '2' && stage !== '3') {
    return { error: 'editTableResult only supports Stage 1, 2 and 3 tables' };
  }
  var STAGE_RANK = { '1': 0, 'rebuy_25': 1, '2': 2, 'rebuy_50': 3, '3': 4, 'rebuy_75': 5, '4': 6 };
  var myRank = STAGE_RANK[stage];
  var hasDownstream = allTables.some(function(t) {
    var r = STAGE_RANK[String(t.stage)];
    return r !== undefined && r > myRank;
  });
  if (hasDownstream) {
    return { error: 'Cannot edit: later-stage tables already exist. Reset the tournament if you need to redo this.' };
  }

  var queuesSheet = getSheet(SHEETS.QUEUES);
  var qData = queuesSheet.getDataRange().getValues();
  var rowsToDelete = [];
  for (var qi = qData.length - 1; qi >= 1; qi--) {
    var src = String(qData[qi][4] || '');
    if (src.indexOf(tableId + ' ') === 0) {
      rowsToDelete.push(qi + 1);
    }
  }
  rowsToDelete.forEach(function(r) { queuesSheet.deleteRow(r); });

  var elimSheet = getSheet(SHEETS.ELIMINATIONS);
  var eData = elimSheet.getDataRange().getValues();
  var elimRowsToDelete = [];
  var restoredIds = [];
  for (var ei = eData.length - 1; ei >= 1; ei--) {
    if (String(eData[ei][2]) === tableId) {
      restoredIds.push(String(eData[ei][0]));
      elimRowsToDelete.push(ei + 1);
    }
  }
  elimRowsToDelete.forEach(function(r) { elimSheet.deleteRow(r); });

  if (restoredIds.length > 0) {
    var playersSheet = getSheet(SHEETS.PLAYERS);
    var pData = playersSheet.getDataRange().getValues();
    for (var pi = 1; pi < pData.length; pi++) {
      if (restoredIds.indexOf(String(pData[pi][0])) !== -1) {
        playersSheet.getRange(pi + 1, 4).setValue('active');
        playersSheet.getRange(pi + 1, 5).setValue(Number(stage));
      }
    }
  }

  var tablesSheet = getSheet(SHEETS.TABLES);
  var tData = tablesSheet.getDataRange().getValues();
  for (var ti = 1; ti < tData.length; ti++) {
    if (String(tData[ti][0]) === tableId) {
      tablesSheet.getRange(ti + 1, 4).setValue('live');
      tablesSheet.getRange(ti + 1, 6).setValue('');
      tablesSheet.getRange(ti + 1, 16).setValue('');
      tablesSheet.getRange(ti + 1, 17).setValue('');
      tablesSheet.getRange(ti + 1, 18).setValue('');
      break;
    }
  }

  return recordTableResult(params);
}

// ===== TEST HELPERS =====
// Run createTestStage1Table() from the Apps Script editor to seed a live Stage 1
// table (9 test players) so the steward result-entry UI can be exercised end to end.
// Re-running it resets the same test table. Run removeTestStage1Table() to clean up.
var TEST_TABLE_ID = 'TEST-S1';
var TEST_PLAYER_PREFIX = '9000'; // test torn ids: 9000001 .. 9000009

function createTestStage1Table() {
  removeTestStage1Table(); // idempotent: clear any prior test data first

  // 1. Test players
  var playersSheet = getSheet(SHEETS.PLAYERS);
  var testIds = [];
  for (var i = 1; i <= 9; i++) {
    var tornId = TEST_PLAYER_PREFIX + '0' + i; // -> 900001 .. 900009
    testIds.push(tornId);
    playersSheet.appendRow([tornId, 'Test Player ' + i, new Date(), 'active', 1, 0]);
  }

  // 2. A time slot for the table (reuse the first existing one, else create slot_20)
  var slots = readTimeSlots();
  var slotId;
  if (slots.length > 0) {
    slotId = slots[0].slotId;
  } else {
    slotId = 'slot_20';
    var dt = new Date(); dt.setUTCHours(20, 0, 0, 0);
    getSheet(SHEETS.TIMESLOTS).appendRow([slotId, dt, new Date()]);
  }

  // 3. The live Stage 1 table row (20 columns; see TABLE layout)
  var row = new Array(20);
  for (var c = 0; c < 20; c++) row[c] = '';
  row[0] = TEST_TABLE_ID; // tableId
  row[1] = '1';           // stage
  row[2] = 9;             // tableSize
  row[3] = 'live';        // status
  row[4] = new Date();    // firedAt
  for (var pi = 0; pi < testIds.length; pi++) row[6 + pi] = testIds[pi]; // players G..O
  row[19] = slotId;       // timeSlotId
  getSheet(SHEETS.TABLES).appendRow(row);

  return {
    message: 'Test Stage 1 table ' + TEST_TABLE_ID + ' created at ' + slotId,
    tableId: TEST_TABLE_ID,
    slotId: slotId,
    players: testIds
  };
}

function removeTestStage1Table() {
  // Remove the test table and any results it produced.
  deleteRowsWhere_(SHEETS.TABLES, 0, TEST_TABLE_ID);
  deleteRowsWhere_(SHEETS.ELIMINATIONS, 2, TEST_TABLE_ID); // col C = tableId

  // Remove queue rows sourced from the test table (col E source starts with tableId + ' ').
  var qSheet = getSheet(SHEETS.QUEUES);
  var qData = qSheet.getDataRange().getValues();
  for (var qi = qData.length - 1; qi >= 1; qi--) {
    if (String(qData[qi][4] || '').indexOf(TEST_TABLE_ID + ' ') === 0) qSheet.deleteRow(qi + 1);
  }

  // Remove the test players (exact torn ids 900001 .. 900009).
  var testIds = {};
  for (var i = 1; i <= 9; i++) testIds[TEST_PLAYER_PREFIX + '0' + i] = true;
  var pSheet = getSheet(SHEETS.PLAYERS);
  var pData = pSheet.getDataRange().getValues();
  for (var pi2 = pData.length - 1; pi2 >= 1; pi2--) {
    if (testIds[String(pData[pi2][0])]) pSheet.deleteRow(pi2 + 1);
  }
  return { message: 'Test Stage 1 table data removed' };
}

// ===== RE-SEAT STAGE 1 (LEGACY RANDOM) =====
function reseatStage1() {
  var settings = readSettings();
  if (settings.tournament_status !== STATUS.ACTIVE) {
    return { error: 'Tournament is not active' };
  }

  var allTables = readTables();
  var stage1Tables = allTables.filter(function(t) { return String(t.stage) === '1'; });
  if (stage1Tables.length === 0) return { error: 'No Stage 1 tables to reseat' };

  var anyComplete = stage1Tables.some(function(t) { return t.status === 'complete'; });
  if (anyComplete) {
    return { error: 'Cannot reseat: at least one Stage 1 table has already recorded a result' };
  }

  var tablesSheet = getSheet(SHEETS.TABLES);
  var tData = tablesSheet.getDataRange().getValues();
  for (var ti = tData.length - 1; ti >= 1; ti--) {
    if (String(tData[ti][1]) === '1') {
      tablesSheet.deleteRow(ti + 1);
    }
  }

  var players = readPlayers();
  var mainTableSize = 9;

  var shuffled = players.slice();
  for (var i = shuffled.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = tmp;
  }

  var tables = [];
  for (var k = 0; k < shuffled.length; k += mainTableSize) {
    tables.push(shuffled.slice(k, k + mainTableSize));
  }

  var now = new Date();
  var tableRows = tables.map(function(playersAtTable, idx) {
    var size = playersAtTable.length;
    return [
      'S1-T' + (idx + 1),
      '1',
      size,
      'live',
      now,
      '',
      playersAtTable[0] ? playersAtTable[0].tornId : '',
      playersAtTable[1] ? playersAtTable[1].tornId : '',
      playersAtTable[2] ? playersAtTable[2].tornId : '',
      playersAtTable[3] ? playersAtTable[3].tornId : '',
      playersAtTable[4] ? playersAtTable[4].tornId : '',
      playersAtTable[5] ? playersAtTable[5].tornId : '',
      playersAtTable[6] ? playersAtTable[6].tornId : '',
      playersAtTable[7] ? playersAtTable[7].tornId : '',
      playersAtTable[8] ? playersAtTable[8].tornId : '',
      '', '', '',
      size < mainTableSize ? 'short table (' + size + ' players)' : '',
      ''
    ];
  });

  if (tableRows.length > 0) {
    tablesSheet.getRange(tablesSheet.getLastRow() + 1, 1, tableRows.length, tableRows[0].length).setValues(tableRows);
  }

  return {
    message: 'Stage 1 reseated. ' + tables.length + ' table(s) created.',
    tables: tables.length
  };
}

// ===== TIMESLOTS =====
function readTimeSlots() {
  var rows = readSheet(SHEETS.TIMESLOTS).map(function(r) {
    return {
      slotId: String(r.slotId || ''),
      datetimeTct: formatDate(r.datetimeTct),
      createdAt: formatDate(r.createdAt)
    };
  });
  rows.sort(function(a, b) {
    return new Date(a.datetimeTct) - new Date(b.datetimeTct);
  });
  return rows;
}

function addTimeSlot(params) {
  var datetimeTct = String(params.datetimeTct || '').trim();
  if (!datetimeTct) return { error: 'Datetime required' };

  var parsed = new Date(datetimeTct);
  if (isNaN(parsed.getTime())) return { error: 'Invalid datetime format' };

  var existing = readTimeSlots();
  var maxNum = 0;
  existing.forEach(function(s) {
    var match = String(s.slotId).match(/^slot_(\d+)$/);
    if (match) {
      var n = parseInt(match[1], 10);
      if (n > maxNum) maxNum = n;
    }
  });
  var newId = 'slot_' + (maxNum + 1);

  getSheet(SHEETS.TIMESLOTS).appendRow([newId, parsed, new Date()]);
  return { message: 'Time slot added', slotId: newId };
}

function removeTimeSlot(params) {
  var slotId = String(params.slotId || '').trim();
  if (!slotId) return { error: 'slotId required' };

  var slotsSheet = getSheet(SHEETS.TIMESLOTS);
  var slotsData = slotsSheet.getDataRange().getValues();
  var found = false;
  for (var i = 1; i < slotsData.length; i++) {
    if (String(slotsData[i][0]) === slotId) {
      slotsSheet.deleteRow(i + 1);
      found = true;
      break;
    }
  }
  if (!found) return { error: 'Slot not found' };

  // Remove this slotId from every player's availableSlotIds list (column C, index 2)
  var availSheet = getSheet(SHEETS.AVAILABILITY);
  var availData = availSheet.getDataRange().getValues();
  for (var j = 1; j < availData.length; j++) {
    var raw = String(availData[j][2] || '');
    if (!raw) continue;
    var ids = raw.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    var filtered = ids.filter(function(id) { return id !== slotId; });
    if (filtered.length !== ids.length) {
      availSheet.getRange(j + 1, 3).setValue(filtered.join(','));
    }
  }

  return { message: 'Time slot removed and dependent picks cleared' };
}

// ===== AVAILABILITY =====
//
// Sheet schema: A=tornId  B=name  C=availableSlotIds  D=submittedAt
// availableSlotIds is a comma-separated string, e.g. "slot_0,slot_4,slot_18".
function readAvailability() {
  return readSheet(SHEETS.AVAILABILITY).map(function(r) {
    return {
      tornId: String(r.tornId || ''),
      name: r.name || '',
      availableSlotIds: String(r.availableSlotIds || ''),
      submittedAt: formatDate(r.submittedAt),
      browserId: String(r.browserId || '')
    };
  });
}

function submitAvailability(params) {
  var tornId = String(params.tornId || '').trim();
  var raw = String(params.availableSlotIds || '').trim();
  var browserId = String(params.browserId || '').trim();

  if (!tornId) return { error: 'tornId required' };
  if (!raw) return { error: 'At least one slot required' };

  var players = readPlayers();
  var player = players.filter(function(p) { return p.tornId === tornId; })[0];
  if (!player) return { error: 'Player not registered' };

  var slots = readTimeSlots();
  var validIds = {};
  slots.forEach(function(s) { validIds[s.slotId] = true; });

  var ids = raw.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  var seen = {};
  var dedupedIds = [];
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    if (!validIds[id]) return { error: 'Not a valid time slot: ' + id };
    if (!seen[id]) {
      seen[id] = true;
      dedupedIds.push(id);
    }
  }
  if (dedupedIds.length === 0) return { error: 'At least one slot required' };

  var combined = dedupedIds.join(',');

  var availSheet = getSheet(SHEETS.AVAILABILITY);
  var availData = availSheet.getDataRange().getValues();
  var existingRow = -1;
  for (var k = 1; k < availData.length; k++) {
    if (String(availData[k][0]) === tornId) {
      existingRow = k + 1;
      break;
    }
  }

  var now = new Date();
  var rowValues = [tornId, player.name, combined, now, browserId];

  if (existingRow > -1) {
    availSheet.getRange(existingRow, 1, 1, 5).setValues([rowValues]);
    return { message: 'Availability updated', slots: dedupedIds.length };
  } else {
    availSheet.appendRow(rowValues);
    return { message: 'Availability saved', slots: dedupedIds.length };
  }
}

// =============================================================================
// AVAILABILITY-BASED TABLE GENERATION (multi-select model)
// =============================================================================

/**
 * previewStageTables: runs the seating algorithm for a given stage and returns
 * the proposed plan WITHOUT writing anything to the Tables sheet.
 *
 * Algorithm (multi-select):
 *   1. Build availability sets: each pool player has an array of slots they marked.
 *   2. Greedy: repeatedly pick the slot with the most unseated demand, seat up to
 *      4 × tableSize of those players there. Prefer players with the fewest other
 *      options (so flexible players save space for inflexible ones).
 *   3. Any player whose slots all filled up before they got seated falls into
 *      the most-populated slot among the ones they had marked. Tagged 'bumped'.
 *   4. Top up each slot with non-submitters to round out short tables.
 *   5. Any non-submitters left get bundled into the most-popular slot.
 *
 * Returns:
 *   {
 *     stage, tableSize, plan, stats: {
 *       totalPlayers, availableHits, bumped, nonSubmitterSeats
 *     }
 *   }
 */
function previewStageTables(params) {
  var stage = String(params.stage || '').trim();
  if (['1', '2', '3'].indexOf(stage) === -1) {
    return { error: "stage must be '1', '2' or '3'" };
  }

  var gate = checkStageGate_(stage);
  if (gate.error) return gate;

  var pool = getStagePool_(stage);
  if (pool.length < 2) return { error: 'Not enough players to generate Stage ' + stage + ' tables' };

  var tableSize = (stage === '1') ? 9 : 6;
  var maxPerSlot = 4 * tableSize;

  var availability = readAvailability();
  var availByTornId = {};
  availability.forEach(function(a) { availByTornId[a.tornId] = a; });

  // Separate pool into players with picks vs non-submitters
  var unseated = []; // [{ tornId, name, availableSlots: [slotId, ...] }]
  var nonSubmitters = [];
  pool.forEach(function(p) {
    var a = availByTornId[p.tornId];
    var slots = a ? parseSlotList_(a.availableSlotIds) : [];
    if (slots.length > 0) {
      unseated.push({ tornId: p.tornId, name: p.name, availableSlots: slots.slice() });
    } else {
      nonSubmitters.push({ tornId: p.tornId, name: p.name });
    }
  });

  var slotBuckets = {}; // slotId -> [{ tornId, name, source }]

  // Greedy main loop
  var safetyCounter = 0;
  while (unseated.length > 0 && safetyCounter < 10000) {
    safetyCounter++;

    // Demand per slot from remaining unseated
    var demand = {};
    unseated.forEach(function(u) {
      u.availableSlots.forEach(function(s) {
        demand[s] = (demand[s] || 0) + 1;
      });
    });

    var demandSlots = Object.keys(demand);
    if (demandSlots.length === 0) break; // everyone's slots full

    // Pick slot with most demand; tie-break by earliest hour
    demandSlots.sort(function(a, b) {
      if (demand[b] !== demand[a]) return demand[b] - demand[a];
      return slotHour_(a) - slotHour_(b);
    });
    var targetSlot = demandSlots[0];

    var existing = (slotBuckets[targetSlot] || []).length;
    var room = maxPerSlot - existing;
    if (room <= 0) {
      // Target slot is full; drop it from everyone's availability and re-try
      unseated.forEach(function(u) {
        var idx = u.availableSlots.indexOf(targetSlot);
        if (idx !== -1) u.availableSlots.splice(idx, 1);
      });
      continue;
    }

    // Candidates = unseated players available for this slot
    var candidates = unseated.filter(function(u) { return u.availableSlots.indexOf(targetSlot) !== -1; });
    // Inflexible players (fewer options) first so we don't strand them
    candidates.sort(function(a, b) {
      if (a.availableSlots.length !== b.availableSlots.length) {
        return a.availableSlots.length - b.availableSlots.length;
      }
      return a.tornId < b.tornId ? -1 : 1;
    });

    var toSeat = candidates.slice(0, room);
    var toSeatIds = {};
    toSeat.forEach(function(u) { toSeatIds[u.tornId] = true; });

    if (!slotBuckets[targetSlot]) slotBuckets[targetSlot] = [];
    toSeat.forEach(function(u) {
      slotBuckets[targetSlot].push({ tornId: u.tornId, name: u.name, source: 'available' });
    });

    unseated = unseated.filter(function(u) { return !toSeatIds[u.tornId]; });

    // Anyone who wanted this slot but didn't get a seat: remove it from their list
    if (candidates.length > room) {
      var notSeated = candidates.slice(room);
      notSeated.forEach(function(u) {
        var idx = u.availableSlots.indexOf(targetSlot);
        if (idx !== -1) u.availableSlots.splice(idx, 1);
      });
    }
  }

  // Anyone still unseated had all their slots fill up. Send them to the most-
  // populated slot among the ones they originally picked, tagged 'bumped'.
  if (unseated.length > 0) {
    unseated.forEach(function(u) {
      var orig = availByTornId[u.tornId];
      var slots = orig ? parseSlotList_(orig.availableSlotIds) : [];
      var target = null;
      var maxCount = -1;
      slots.forEach(function(s) {
        var c = (slotBuckets[s] || []).length;
        if (c > maxCount) {
          maxCount = c;
          target = s;
        }
      });
      if (!target) {
        nonSubmitters.push({ tornId: u.tornId, name: u.name });
        return;
      }
      if (!slotBuckets[target]) slotBuckets[target] = [];
      slotBuckets[target].push({ tornId: u.tornId, name: u.name, source: 'bumped' });
    });
  }

  // Build the plan, topping up each slot with non-submitters where it cleans up
  // a short table.
  var slotIdsInOrder = Object.keys(slotBuckets).sort(function(a, b) {
    return slotHour_(a) - slotHour_(b);
  });

  var tableCounter = 1;
  var plan = [];

  slotIdsInOrder.forEach(function(slotId) {
    var seated = slotBuckets[slotId];
    if (seated.length === 0) return;

    var roomLeft = maxPerSlot - seated.length;
    var distToCleanMultiple = (tableSize - (seated.length % tableSize)) % tableSize;
    var nonSubToPull = Math.min(roomLeft, distToCleanMultiple, nonSubmitters.length);
    for (var i = 0; i < nonSubToPull; i++) {
      var ns = nonSubmitters.shift();
      seated.push({ tornId: ns.tornId, name: ns.name, source: 'non' });
    }

    var sizes = layoutForCount_(seated.length, tableSize);
    var tablesForSlot = [];
    var cursor = 0;
    sizes.forEach(function(size) {
      var slice = seated.slice(cursor, cursor + size);
      cursor += size;
      tablesForSlot.push({
        tableId: 'S' + stage + '-T' + tableCounter,
        size: size,
        playerIds: slice.map(function(s) { return s.tornId; }),
        playerNames: slice.map(function(s) { return s.name; }),
        sources: slice.map(function(s) { return s.source; })
      });
      tableCounter++;
    });

    plan.push({ slotId: slotId, tables: tablesForSlot });
  });

  // Any remaining non-submitters get their own table(s) at the most-popular slot.
  if (nonSubmitters.length > 0) {
    var targetSlotEntry = null;
    var maxTables = -1;
    plan.forEach(function(entry) {
      if (entry.tables.length > maxTables) {
        maxTables = entry.tables.length;
        targetSlotEntry = entry;
      }
    });

    if (!targetSlotEntry) {
      var allSlots = readTimeSlots();
      var fallbackSlotId = allSlots.length > 0 ? allSlots[0].slotId : '';
      targetSlotEntry = { slotId: fallbackSlotId, tables: [] };
      plan.push(targetSlotEntry);
    }

    var sizes = layoutForCount_(nonSubmitters.length, tableSize);
    var cursor = 0;
    sizes.forEach(function(size) {
      var slice = nonSubmitters.slice(cursor, cursor + size);
      cursor += size;
      targetSlotEntry.tables.push({
        tableId: 'S' + stage + '-T' + tableCounter,
        size: size,
        playerIds: slice.map(function(s) { return s.tornId; }),
        playerNames: slice.map(function(s) { return s.name; }),
        sources: slice.map(function() { return 'non'; })
      });
      tableCounter++;
    });
    nonSubmitters = [];
  }

  // Stats
  var stats = { totalPlayers: pool.length, availableHits: 0, bumped: 0, nonSubmitterSeats: 0 };
  plan.forEach(function(entry) {
    entry.tables.forEach(function(t) {
      t.sources.forEach(function(s) {
        if (s === 'available') stats.availableHits++;
        else if (s === 'bumped') stats.bumped++;
        else if (s === 'non') stats.nonSubmitterSeats++;
      });
    });
  });

  return {
    stage: stage,
    tableSize: tableSize,
    plan: plan,
    stats: stats
  };
}

/**
 * commitStageTables: takes a plan (same shape as previewStageTables returned)
 * and writes the tables to the Tables sheet.
 */
function commitStageTables(params) {
  var stage = String(params.stage || '').trim();
  if (['1', '2', '3'].indexOf(stage) === -1) {
    return { error: "stage must be '1', '2' or '3'" };
  }

  var planRaw = params.plan;
  if (!planRaw) return { error: 'plan parameter required' };

  var plan;
  try {
    plan = JSON.parse(planRaw);
  } catch (e) {
    return { error: 'plan parameter must be valid JSON' };
  }
  if (!Array.isArray(plan)) return { error: 'plan must be an array' };

  var settings = readSettings();
  var tournamentStatus = settings.tournament_status || STATUS.SETUP;

  if (stage === '1') {
    if (tournamentStatus !== STATUS.SETUP) {
      return { error: 'Stage 1 commit only valid while tournament is in setup state' };
    }
  } else {
    if (tournamentStatus !== STATUS.ACTIVE) {
      return { error: 'Tournament must be active to commit Stage ' + stage };
    }
  }

  var existing = readTables().filter(function(t) { return String(t.stage) === stage; });
  if (existing.length > 0) {
    return { error: 'Stage ' + stage + ' tables already exist. Reset to regenerate.' };
  }

  var tablesSheet = getSheet(SHEETS.TABLES);
  var now = new Date();
  var rows = [];

  plan.forEach(function(entry) {
    entry.tables.forEach(function(t) {
      var row = new Array(20);
      for (var i = 0; i < 20; i++) row[i] = '';
      row[0] = t.tableId;
      row[1] = stage;
      row[2] = t.size;
      row[3] = 'live';
      row[4] = now;
      row[5] = '';
      for (var pi = 0; pi < t.playerIds.length && pi < 9; pi++) {
        row[6 + pi] = t.playerIds[pi];
      }
      row[15] = '';
      row[16] = '';
      row[17] = '';
      row[18] = ((t.size < (stage === '1' ? 9 : 6)) ? 'short table (' + t.size + ' players)' : '');
      row[19] = entry.slotId || '';
      rows.push(row);
    });
  });

  if (rows.length === 0) return { error: 'plan is empty' };

  tablesSheet.getRange(tablesSheet.getLastRow() + 1, 1, rows.length, 20).setValues(rows);

  if (stage === '1') {
    var playersSheet = getSheet(SHEETS.PLAYERS);
    var lastRow = playersSheet.getLastRow();
    if (lastRow > 1) {
      var range = playersSheet.getRange(2, 5, lastRow - 1, 1);
      var values = range.getValues();
      for (var p = 0; p < values.length; p++) {
        values[p][0] = 1;
      }
      range.setValues(values);
    }
    updateSetting({ key: 'tournament_status', value: STATUS.ACTIVE });
  }

  return {
    message: 'Stage ' + stage + ' tables created: ' + rows.length + (stage === '1' ? '. Tournament is now active.' : ''),
    tables: rows.length,
    stageStarted: (stage === '1')
  };
}

// ===== HELPERS FOR TABLE GENERATION =====

function checkStageGate_(stage) {
  var settings = readSettings();
  var status = settings.tournament_status || STATUS.SETUP;

  if (stage === '1') {
    if (status !== STATUS.SETUP && status !== STATUS.ACTIVE) {
      return { error: 'Tournament cannot generate Stage 1 in its current state' };
    }
    return { ok: true };
  }

  if (status !== STATUS.ACTIVE) {
    return { error: 'Tournament is not active' };
  }

  var tables = readTables();

  if (stage === '2') {
    var stage1 = tables.filter(function(t) { return String(t.stage) === '1'; });
    if (stage1.length === 0) return { error: 'No Stage 1 tables exist yet' };
    if (stage1.some(function(t) { return t.status !== 'complete'; })) {
      return { error: 'All Stage 1 tables must be complete before generating Stage 2' };
    }
    var rebuy25 = tables.filter(function(t) { return String(t.stage) === 'rebuy_25'; });
    if (rebuy25.some(function(t) { return t.status !== 'complete'; })) {
      return { error: 'All 25M rebuy tables must be complete before generating Stage 2' };
    }
    return { ok: true };
  }

  if (stage === '3') {
    var stage2 = tables.filter(function(t) { return String(t.stage) === '2'; });
    if (stage2.length === 0) return { error: 'No Stage 2 tables exist yet' };
    if (stage2.some(function(t) { return t.status !== 'complete'; })) {
      return { error: 'All Stage 2 tables must be complete before generating Stage 3' };
    }
    var rebuy50 = tables.filter(function(t) { return String(t.stage) === 'rebuy_50'; });
    if (rebuy50.some(function(t) { return t.status !== 'complete'; })) {
      return { error: 'All 50M rebuy tables must be complete before generating Stage 3' };
    }
    return { ok: true };
  }

  return { error: 'Unknown stage: ' + stage };
}

function getStagePool_(stage) {
  if (stage === '1') {
    return readPlayers();
  }

  var queues = readQueues();
  var queueKey = 'stage_' + stage;
  var queuedIds = queues.filter(function(q) { return q.queuedFor === queueKey; }).map(function(q) { return q.tornId; });

  var players = readPlayers();
  return players.filter(function(p) { return queuedIds.indexOf(p.tornId) !== -1; });
}

function layoutForCount_(n, baseSize) {
  if (n <= 0) return [];
  if (n <= baseSize) return [n];

  var full = Math.floor(n / baseSize);
  var leftover = n % baseSize;

  if (leftover === 0) {
    var out = [];
    for (var i = 0; i < full; i++) out.push(baseSize);
    return out;
  }

  var splitTotal = baseSize + leftover;
  var a = Math.ceil(splitTotal / 2);
  var b = Math.floor(splitTotal / 2);

  var result = [];
  for (var j = 0; j < full - 1; j++) result.push(baseSize);
  result.push(a, b);
  return result;
}

function parseSlotList_(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return String(value).split(',').map(function(s) { return s.trim(); }).filter(Boolean);
}

function slotHour_(slotId) {
  var m = String(slotId).match(/^slot_(\d+)$/);
  return m ? parseInt(m[1], 10) : 999;
}

// =============================================================================
// STEWARDS
// =============================================================================

function readStewards() {
  ensureStewardSheets_();
  return readSheet(SHEETS.STEWARDS).map(function(r) {
    return {
      stewardId: String(r.stewardId || ''),
      name: r.name || '',
      tornId: String(r.tornId || ''),
      createdAt: formatDate(r.createdAt)
    };
  }).filter(function(s) { return s.stewardId; });
}

function readStewardAvailability() {
  ensureStewardSheets_();
  return readSheet(SHEETS.STEWARD_AVAILABILITY).map(function(r) {
    return {
      stewardId: String(r.stewardId || ''),
      slotId: String(r.slotId || ''),
      addedAt: formatDate(r.addedAt)
    };
  }).filter(function(r) { return r.stewardId && r.slotId; });
}

function readStewardAssignments() {
  ensureStewardSheets_();
  return readSheet(SHEETS.STEWARD_ASSIGNMENTS).map(function(r) {
    return {
      tableId: String(r.tableId || ''),
      stewardId: String(r.stewardId || ''),
      assignedAt: formatDate(r.assignedAt)
    };
  }).filter(function(r) { return r.tableId && r.stewardId; });
}

function addSteward(params) {
  ensureStewardSheets_();
  var name = String(params.name || '').trim();
  var tornId = String(params.tornId || '').trim();
  if (!name) return { error: 'Name required' };
  if (!tornId) return { error: 'Torn ID required' };
  if (!/^\d+$/.test(tornId)) return { error: 'Torn ID must be numeric' };

  var existing = readStewards();
  if (existing.some(function(s) { return s.tornId === tornId; })) {
    return { error: 'A steward with that Torn ID already exists' };
  }

  var maxNum = 0;
  existing.forEach(function(s) {
    var m = String(s.stewardId).match(/^steward_(\d+)$/);
    if (m) {
      var n = parseInt(m[1], 10);
      if (n > maxNum) maxNum = n;
    }
  });
  var newId = 'steward_' + (maxNum + 1);

  getSheet(SHEETS.STEWARDS).appendRow([newId, name, tornId, new Date()]);
  return { message: name + ' added as steward', stewardId: newId };
}

function removeSteward(params) {
  ensureStewardSheets_();
  var stewardId = String(params.stewardId || '').trim();
  if (!stewardId) return { error: 'stewardId required' };

  var stewardsSheet = getSheet(SHEETS.STEWARDS);
  var sData = stewardsSheet.getDataRange().getValues();
  var removedName = '';
  for (var i = sData.length - 1; i >= 1; i--) {
    if (String(sData[i][0]) === stewardId) {
      removedName = sData[i][1];
      stewardsSheet.deleteRow(i + 1);
    }
  }
  if (!removedName) return { error: 'Steward not found' };

  deleteRowsWhere_(SHEETS.STEWARD_AVAILABILITY, 0, stewardId);
  deleteRowsWhere_(SHEETS.STEWARD_ASSIGNMENTS, 1, stewardId);

  return { message: removedName + ' removed' };
}

function setStewardAvailability(params) {
  ensureStewardSheets_();
  var stewardId = String(params.stewardId || '').trim();
  if (!stewardId) return { error: 'stewardId required' };

  var stewards = readStewards();
  if (!stewards.some(function(s) { return s.stewardId === stewardId; })) {
    return { error: 'Steward not found' };
  }

  var raw = String(params.slotIds || '').trim();
  var slotIds = raw ? raw.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];

  var validSlotIds = {};
  readTimeSlots().forEach(function(s) { validSlotIds[s.slotId] = true; });
  for (var i = 0; i < slotIds.length; i++) {
    if (!validSlotIds[slotIds[i]]) return { error: 'Not a valid time slot: ' + slotIds[i] };
  }
  var seen = {};
  var deduped = [];
  slotIds.forEach(function(id) {
    if (!seen[id]) { seen[id] = true; deduped.push(id); }
  });

  deleteRowsWhere_(SHEETS.STEWARD_AVAILABILITY, 0, stewardId);

  var now = new Date();
  if (deduped.length > 0) {
    var rows = deduped.map(function(slotId) { return [stewardId, slotId, now]; });
    var sheet = getSheet(SHEETS.STEWARD_AVAILABILITY);
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
  }

  // Cascade: remove assignments where this steward is assigned to a table
  // whose time slot is no longer in the picks.
  var keepSet = {};
  deduped.forEach(function(s) { keepSet[s] = true; });

  var tables = readTables();
  var tableSlotById = {};
  tables.forEach(function(t) { tableSlotById[t.tableId] = t.timeSlotId; });

  var assignmentsSheet = getSheet(SHEETS.STEWARD_ASSIGNMENTS);
  var aData = assignmentsSheet.getDataRange().getValues();
  var removed = [];
  for (var j = aData.length - 1; j >= 1; j--) {
    var tableId = String(aData[j][0]);
    var sid = String(aData[j][1]);
    if (sid !== stewardId) continue;
    var slot = tableSlotById[tableId];
    if (slot && keepSet[slot]) continue;
    removed.push(tableId);
    assignmentsSheet.deleteRow(j + 1);
  }

  return {
    message: 'Availability saved (' + deduped.length + ' slot' + (deduped.length === 1 ? '' : 's') + ')',
    slots: deduped.length,
    removedAssignments: removed
  };
}

function assignSteward(params) {
  ensureStewardSheets_();
  var tableId = String(params.tableId || '').trim();
  var stewardId = String(params.stewardId || '').trim();
  if (!tableId) return { error: 'tableId required' };
  if (!stewardId) return { error: 'stewardId required' };

  var table = readTables().filter(function(t) { return t.tableId === tableId; })[0];
  if (!table) return { error: 'Table not found' };
  if (!table.timeSlotId) return { error: 'Table has no time slot; cannot assign a steward' };

  var steward = readStewards().filter(function(s) { return s.stewardId === stewardId; })[0];
  if (!steward) return { error: 'Steward not found' };

  var availability = readStewardAvailability().filter(function(r) { return r.stewardId === stewardId; });
  var available = availability.some(function(r) { return r.slotId === table.timeSlotId; });
  if (!available) return { error: steward.name + ' is not available for this time slot' };

  var tables = readTables();
  var tableSlotById = {};
  tables.forEach(function(t) { tableSlotById[t.tableId] = t.timeSlotId; });

  var conflict = readStewardAssignments().filter(function(a) {
    return a.stewardId === stewardId &&
           a.tableId !== tableId &&
           tableSlotById[a.tableId] === table.timeSlotId;
  })[0];
  if (conflict) {
    return { error: steward.name + ' is already assigned to ' + conflict.tableId + ' at the same time slot' };
  }

  var sheet = getSheet(SHEETS.STEWARD_ASSIGNMENTS);
  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === tableId) sheet.deleteRow(i + 1);
  }
  sheet.appendRow([tableId, stewardId, new Date()]);

  return { message: steward.name + ' assigned to ' + tableId };
}

function unassignSteward(params) {
  ensureStewardSheets_();
  var tableId = String(params.tableId || '').trim();
  if (!tableId) return { error: 'tableId required' };

  var removed = deleteRowsWhere_(SHEETS.STEWARD_ASSIGNMENTS, 0, tableId);
  if (removed === 0) return { error: 'No assignment for ' + tableId };
  return { message: 'Cleared steward for ' + tableId };
}

// Returns { ok: true, stewardId, name } if the supplied password matches any
// steward's Torn ID in the Stewards sheet. Used by the stewards page login
// gate so each steward can sign in with their own Torn ID.
function verifyStewardLogin(params) {
  ensureStewardSheets_();
  var password = String(params.password || '').trim();
  if (!password) return { ok: false };

  var match = readStewards().filter(function(s) { return s.tornId === password; })[0];
  if (!match) return { ok: false };

  return { ok: true, stewardId: match.stewardId, name: match.name };
}

function ensureStewardSheets_() {
  getOrCreateSheet_(SHEETS.STEWARDS, STEWARD_SHEET_HEADERS.Stewards);
  getOrCreateSheet_(SHEETS.STEWARD_AVAILABILITY, STEWARD_SHEET_HEADERS.StewardAvailability);
  getOrCreateSheet_(SHEETS.STEWARD_ASSIGNMENTS, STEWARD_SHEET_HEADERS.StewardAssignments);
}

function deleteRowsWhere_(sheetName, colIdxZeroBased, value) {
  var sheet = getSheet(sheetName);
  var data = sheet.getDataRange().getValues();
  var removed = 0;
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][colIdxZeroBased]) === String(value)) {
      sheet.deleteRow(i + 1);
      removed++;
    }
  }
  return removed;
}

// ===== SHEET HELPERS =====
function getSheet(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name);
  return sheet;
}

function getOrCreateSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (sheet) return sheet;
  sheet = ss.insertSheet(name);
  if (headers && headers.length > 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readSheet(name) {
  var sheet = getSheet(name);
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  var headers = data[0].map(function(h) { return String(h).trim(); });
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var row = {};
    var hasContent = false;
    for (var j = 0; j < headers.length; j++) {
      row[headers[j]] = data[i][j];
      if (data[i][j] !== '' && data[i][j] !== null) hasContent = true;
    }
    if (hasContent) rows.push(row);
  }
  return rows;
}

function formatDate(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
