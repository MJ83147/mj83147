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
 *   submitAvailability
 *   previewStageTables             (Stage 1, 2, 3 — runs algorithm without committing)
 *   commitStageTables              (writes a previewed plan to the Tables sheet)
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
  AVAILABILITY: 'Availability'
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
    availability: readAvailability()
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

  // Mark each player's currentStage = 1
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

  if (stage !== '1') return { error: 'recordTableResult only handles Stage 1 tables' };
  if (status !== 'live') return { error: 'Table is not live (status: ' + status + ')' };

  if (size >= 4 && !place2) return { error: '2nd place required for tables of 4+' };
  if (size >= 7 && !place3) return { error: '3rd place required for tables of 7+' };

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

  var advancers = [];
  if (size >= 7) {
    advancers.push({ tornId: place1, dest: 'stage_4', source: tableId + ' 1st' });
    advancers.push({ tornId: place2, dest: 'stage_3', source: tableId + ' 2nd' });
    advancers.push({ tornId: place3, dest: 'stage_2', source: tableId + ' 3rd' });
  } else if (size >= 4) {
    advancers.push({ tornId: place1, dest: 'stage_4', source: tableId + ' 1st' });
    advancers.push({ tornId: place2, dest: 'stage_3', source: tableId + ' 2nd' });
  } else {
    advancers.push({ tornId: place1, dest: 'stage_4', source: tableId + ' 1st (short table walkover)' });
  }

  var advancerIds = advancers.map(function(a) { return a.tornId; });
  var losers = tablePlayerIds.filter(function(pid) { return advancerIds.indexOf(pid) === -1; });

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
  var elimRows = losers.map(function(pid) {
    var pl = findPlayer(pid);
    return [pid, pl ? pl.name : '', tableId, 1, new Date(), 'no', ''];
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
    eliminated: losers.length
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

  if (String(thisTable.stage) === '1') {
    var hasDownstream = allTables.some(function(t) { return String(t.stage) !== '1'; });
    if (hasDownstream) {
      return { error: 'Cannot edit: downstream tables already exist. Reset the tournament if you need to redo this.' };
    }
  } else {
    return { error: 'editTableResult currently only supports Stage 1 tables' };
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
        playersSheet.getRange(pi + 1, 5).setValue(1);
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

  var availSheet = getSheet(SHEETS.AVAILABILITY);
  var availData = availSheet.getDataRange().getValues();
  for (var j = 1; j < availData.length; j++) {
    if (String(availData[j][2]) === slotId) availSheet.getRange(j + 1, 3).setValue('');
    if (String(availData[j][3]) === slotId) availSheet.getRange(j + 1, 4).setValue('');
    if (String(availData[j][4]) === slotId) availSheet.getRange(j + 1, 5).setValue('');
  }

  return { message: 'Time slot removed and dependent picks cleared' };
}

// ===== AVAILABILITY =====
function readAvailability() {
  return readSheet(SHEETS.AVAILABILITY).map(function(r) {
    return {
      tornId: String(r.tornId || ''),
      name: r.name || '',
      firstChoiceSlotId: String(r.firstChoiceSlotId || ''),
      secondChoiceSlotId: String(r.secondChoiceSlotId || ''),
      thirdChoiceSlotId: String(r.thirdChoiceSlotId || ''),
      submittedAt: formatDate(r.submittedAt)
    };
  });
}

function submitAvailability(params) {
  var tornId = String(params.tornId || '').trim();
  var firstChoice = String(params.firstChoiceSlotId || '').trim();
  var secondChoice = String(params.secondChoiceSlotId || '').trim();
  var thirdChoice = String(params.thirdChoiceSlotId || '').trim();

  if (!tornId) return { error: 'tornId required' };
  if (!firstChoice) return { error: 'First choice required' };

  var players = readPlayers();
  var player = players.filter(function(p) { return p.tornId === tornId; })[0];
  if (!player) return { error: 'Player not registered' };

  var slots = readTimeSlots();
  var validIds = slots.map(function(s) { return s.slotId; });
  if (validIds.indexOf(firstChoice) === -1) return { error: 'First choice is not a valid time slot' };
  if (secondChoice && validIds.indexOf(secondChoice) === -1) return { error: 'Second choice is not a valid time slot' };
  if (thirdChoice && validIds.indexOf(thirdChoice) === -1) return { error: 'Third choice is not a valid time slot' };

  var picks = [firstChoice];
  if (secondChoice) picks.push(secondChoice);
  if (thirdChoice) picks.push(thirdChoice);
  var pickSet = {};
  for (var i = 0; i < picks.length; i++) {
    if (pickSet[picks[i]]) return { error: 'All choices must be different' };
    pickSet[picks[i]] = true;
  }

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
  var rowValues = [tornId, player.name, firstChoice, secondChoice, thirdChoice, now];

  if (existingRow > -1) {
    availSheet.getRange(existingRow, 1, 1, 6).setValues([rowValues]);
    return { message: 'Availability updated' };
  } else {
    availSheet.appendRow(rowValues);
    return { message: 'Availability saved' };
  }
}

// =============================================================================
// AVAILABILITY-BASED TABLE GENERATION
// =============================================================================

/**
 * previewStageTables: runs the algorithm for a given stage and returns the
 * proposed seating plan WITHOUT writing anything to the Tables sheet.
 *
 * Params:
 *   stage = '1' | '2' | '3'
 *
 * Returns:
 *   {
 *     stage: '1',
 *     tableSize: 9,
 *     players: [...],     // pool used
 *     plan: [
 *       {
 *         slotId: 'slot_20',
 *         tables: [
 *           { tableId: 'S1-T1', size: 9, playerIds: [...], playerNames: [...] }
 *         ]
 *       }
 *     ],
 *     stats: { totalPlayers, firstChoiceHits, secondChoiceHits, thirdChoiceHits, nonSubmitterSeats }
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
  var availability = readAvailability();
  var availByTornId = {};
  availability.forEach(function(a) { availByTornId[a.tornId] = a; });

  // Step 1: naive 1st-choice assignment + non-submitters bucket
  var slotBuckets = {}; // slotId -> [{ tornId, name, source: '1st'|'2nd'|'3rd', avail }]
  var nonSubmitters = [];
  pool.forEach(function(p) {
    var a = availByTornId[p.tornId];
    if (a && a.firstChoiceSlotId) {
      if (!slotBuckets[a.firstChoiceSlotId]) slotBuckets[a.firstChoiceSlotId] = [];
      slotBuckets[a.firstChoiceSlotId].push({ tornId: p.tornId, name: p.name, source: '1st', avail: a });
    } else {
      nonSubmitters.push({ tornId: p.tornId, name: p.name });
    }
  });

  // Step 2: handle overflow at slots with > (4 * tableSize) players
  // Per Jordie's rule: find groups of 4+ who share the same 2nd choice; bump the group
  // whose departure leaves the slot closest to a clean layout. Loop until <= cap.
  var maxPerSlot = 4 * tableSize;
  Object.keys(slotBuckets).forEach(function(slotId) {
    while (slotBuckets[slotId].length > maxPerSlot) {
      var bumped = bumpOverflowGroup_(slotBuckets, slotId, maxPerSlot, tableSize);
      if (!bumped) break; // no viable bump found; we'll leave them and the layout will use short tables
    }
  });

  // Step 3: for each slot, compute table layout and assign players
  var plan = [];
  var slotIdsInOrder = Object.keys(slotBuckets).sort(function(a, b) {
    // Sort by hour for stable output
    var ah = slotHour_(a);
    var bh = slotHour_(b);
    return ah - bh;
  });

  var tableCounter = 1;
  slotIdsInOrder.forEach(function(slotId) {
    var seated = slotBuckets[slotId];
    if (seated.length === 0) return;

    // Top up with non-submitters where it helps (Step 4 of spec): if seated.length
    // produces a short table layout, pulling in non-submitters until it hits a clean
    // multiple of tableSize avoids the short table. Up to capacity (maxPerSlot).
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

  // Step 5: remaining non-submitters form their own table(s) at the slot already
  // running the most tables (= the most-popular slot already in the plan)
  if (nonSubmitters.length > 0) {
    var targetSlotEntry = null;
    var maxTables = -1;
    plan.forEach(function(entry) {
      if (entry.tables.length > maxTables) {
        maxTables = entry.tables.length;
        targetSlotEntry = entry;
      }
    });

    // If no slots in plan at all (no submissions), use first time slot (if any) or '' placeholder
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
  var stats = { totalPlayers: pool.length, firstChoiceHits: 0, secondChoiceHits: 0, thirdChoiceHits: 0, nonSubmitterSeats: 0, bumped: 0 };
  plan.forEach(function(entry) {
    entry.tables.forEach(function(t) {
      t.sources.forEach(function(s) {
        if (s === '1st') stats.firstChoiceHits++;
        else if (s === '2nd') stats.secondChoiceHits++;
        else if (s === '3rd') stats.thirdChoiceHits++;
        else if (s === 'non') stats.nonSubmitterSeats++;
        else if (s === 'bumped') stats.bumped++;
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
 *
 * Params:
 *   stage = '1' | '2' | '3'
 *   plan  = JSON-encoded string of the plan array
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

  // Stage 1 commit transitions tournament from setup -> active.
  // Stages 2 and 3 require tournament to already be active.
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

  // Guard: don't allow commit if stage tables already exist for this stage
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

  // If this is Stage 1, also flip tournament to active and set every player's currentStage = 1
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

/**
 * checkStageGate_: returns { ok: true } if the stage can be generated.
 * Returns { error: '...' } otherwise.
 *
 * Stage 1: tournament must be active
 * Stage 2: all Stage 1 tables AND all rebuy_25 tables must be complete
 * Stage 3: all Stage 2 tables AND all rebuy_50 tables must be complete
 */
function checkStageGate_(stage) {
  var settings = readSettings();
  var status = settings.tournament_status || STATUS.SETUP;

  if (stage === '1') {
    // Stage 1 is generatable from setup OR active (but commit will fail if tables exist)
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

/**
 * getStagePool_: returns the array of player objects that should be seated for a given stage.
 *
 * Stage 1: all registered players
 * Stage 2: players in StageQueues with queuedFor='stage_2'
 * Stage 3: players in StageQueues with queuedFor='stage_3'
 */
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

/**
 * layoutForCount_: returns an array of table sizes for N players.
 * Rule (from Jordie):
 *   - if N % base == 0 → all full tables
 *   - else: (floor(N/base) - 1) full tables, then split (base + N%base) across two tables
 *   - if N < base, single short table
 */
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

  // Take one full off, split (baseSize + leftover) across two
  var splitTotal = baseSize + leftover;
  var a = Math.ceil(splitTotal / 2);
  var b = Math.floor(splitTotal / 2);

  var result = [];
  for (var j = 0; j < full - 1; j++) result.push(baseSize);
  // Put larger of the two splits first for stable ordering
  result.push(a, b);
  return result;
}

/**
 * bumpOverflowGroup_: an over-subscribed slot has > maxPerSlot players.
 * Find the best group of 4+ who share the same 2nd choice (and are currently
 * 1st-choicers at this slot), move them to that 2nd choice slot.
 *
 * "Best" = the group whose departure leaves the source slot closest to a
 * clean tableSize-multiple. Returns true if a bump happened, false otherwise.
 */
function bumpOverflowGroup_(slotBuckets, slotId, maxPerSlot, tableSize) {
  var bucket = slotBuckets[slotId];
  var excess = bucket.length - maxPerSlot;

  // Build map of 2nd-choice → [people at this slot whose 2nd is that destination]
  var groupsByDest = {};
  bucket.forEach(function(person, idx) {
    var secondChoice = person.avail && person.avail.secondChoiceSlotId;
    if (!secondChoice) return;
    if (secondChoice === slotId) return; // same slot, useless
    if (!groupsByDest[secondChoice]) groupsByDest[secondChoice] = [];
    groupsByDest[secondChoice].push({ person: person, idx: idx });
  });

  // Filter to groups of 4+
  var viableGroups = [];
  Object.keys(groupsByDest).forEach(function(dest) {
    if (groupsByDest[dest].length >= 4) {
      viableGroups.push({ dest: dest, members: groupsByDest[dest] });
    }
  });

  if (viableGroups.length === 0) return false;

  // For each viable group, simulate: what would bucket.length be if we moved the
  // minimum needed to cover the excess (or the whole group, whichever is smaller)?
  // Pick the group that yields the cleanest layout for the SOURCE slot.
  var best = null;
  viableGroups.forEach(function(g) {
    var moveCount = Math.min(g.members.length, excess);
    if (moveCount < 4) return; // need to move at least 4 for the group to be viable
    var resultingSize = bucket.length - moveCount;
    var distToClean = resultingSize % tableSize;
    // Score: closer to 0 (clean multiple) is better
    var score = Math.min(distToClean, tableSize - distToClean);
    if (best === null || score < best.score || (score === best.score && moveCount > best.moveCount)) {
      best = { group: g, moveCount: moveCount, score: score };
    }
  });

  if (!best) return false;

  // Execute the bump: remove best.moveCount members from bucket, add to destination slot
  var dest = best.group.dest;
  if (!slotBuckets[dest]) slotBuckets[dest] = [];

  var toMove = best.group.members.slice(0, best.moveCount);
  // Sort indices descending so splice doesn't shift remaining indices
  var indicesToRemove = toMove.map(function(m) { return m.idx; }).sort(function(a, b) { return b - a; });
  indicesToRemove.forEach(function(i) {
    var removed = bucket.splice(i, 1)[0];
    removed.source = 'bumped';
    slotBuckets[dest].push(removed);
  });

  return true;
}

/**
 * slotHour_: extracts the hour number from a slot ID like 'slot_20'.
 * Returns 999 if not parseable (puts unknowns at the end).
 */
function slotHour_(slotId) {
  var m = String(slotId).match(/^slot_(\d+)$/);
  return m ? parseInt(m[1], 10) : 999;
}

// ===== SHEET HELPERS =====
function getSheet(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name);
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
