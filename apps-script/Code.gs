/**
 * Telecaller Call Tracker  (Google Sheet + Apps Script)
 * - Phones send call logs to this script (doPost)
 * - Script fills "Call Log" and builds "Daily Summary" (calls, talktime, idle)
 * Idle = a gap of IDLE_MIN minutes or more with no call, inside working hours (lunch excluded).
 */

// ---------- SETTINGS (change here) ----------
var CFG = {
  SHIFT_START: '09:00',
  SHIFT_END: '18:00',
  LUNCH_START: '13:10',
  LUNCH_END: '13:50',
  IDLE_MIN: 10
};
var IST = 330 * 60000; // India time = UTC + 5:30

// ---------- PURE HELPERS (no Google services, easy to test) ----------
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function dayKey(ms) {
  var d = new Date(ms + IST);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}
function dayStartMs(key) {
  var p = key.split('-');
  return Date.UTC(+p[0], +p[1] - 1, +p[2]) - IST;
}
function hmMs(s) { var p = s.split(':'); return (+p[0] * 60 + +p[1]) * 60000; }
function fmtTime(ms) {
  var d = new Date(ms + IST);
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}
function fmtDur(sec) {
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h + ':' + pad(m) + ':' + pad(s);
}

/** calls: [{start(ms), dur(sec), type}] for ONE caller on ONE day. nowMs: cut-off for today. */
function computeDay(calls, key, nowMs) {
  var base = dayStartMs(key);
  var segs = [
    [base + hmMs(CFG.SHIFT_START), base + hmMs(CFG.LUNCH_START)],
    [base + hmMs(CFG.LUNCH_END), base + hmMs(CFG.SHIFT_END)]
  ];
  var busy = calls.filter(function (c) { return c.dur > 0; })
    .map(function (c) { return [c.start, c.start + c.dur * 1000]; })
    .sort(function (a, b) { return a[0] - b[0]; });

  var idleMs = 0, gaps = 0, longest = 0, workMs = 0, thr = CFG.IDLE_MIN * 60000;
  function gap(len) {
    if (len >= thr) { idleMs += len; gaps++; if (len > longest) longest = len; }
  }
  segs.forEach(function (seg) {
    var s = seg[0], e = Math.min(seg[1], nowMs);
    if (e <= s) return;
    workMs += e - s;
    var cur = s;
    busy.forEach(function (b) {
      var bs = Math.max(b[0], s), be = Math.min(b[1], e);
      if (be <= bs) return;
      if (bs > cur) gap(bs - cur);
      cur = Math.max(cur, be);
    });
    if (e > cur) gap(e - cur);
  });

  var out = 0, inc = 0, missed = 0, talk = 0, first = null, last = null;
  calls.forEach(function (c) {
    if (c.type === 'OUTGOING') out++;
    else if (c.type === 'INCOMING') inc++;
    else missed++;                       // MISSED / REJECTED
    talk += c.dur;
    if (first === null || c.start < first) first = c.start;
    var end = c.start + c.dur * 1000;
    if (last === null || end > last) last = end;
  });
  return {
    total: calls.length, out: out, inc: inc, missed: missed, talkSec: talk,
    first: first, last: last,
    idleMin: Math.round(idleMs / 60000), gaps: gaps, longestMin: Math.round(longest / 60000),
    workMin: Math.round(workMs / 60000)
  };
}

/** Fake but realistic calls for testing. Amanpreet = busy, Ashima = long idle stretches. */
function genTestCalls(key) {
  var base = dayStartMs(key);
  function t(hhmm) { return base + hmMs(hhmm); }
  var A = [], S = [];
  // Amanpreet: a call every ~6-8 minutes all day, 2-3 min each
  var tm = t('09:05'), i = 0, lunchS = t(CFG.LUNCH_START), lunchE = t(CFG.LUNCH_END), end = t('17:55');
  while (tm < end) {
    if (tm >= lunchS && tm < lunchE) { tm = lunchE + 120000; continue; }
    A.push({ start: tm, dur: 120 + (i * 37) % 120, type: i % 5 === 4 ? 'INCOMING' : 'OUTGOING' });
    tm += (6 + (i * 3) % 3) * 60000 + 60000 * 2; i++;
  }
  // Ashima: bursts of calls, then long gaps
  [['09:10', 3], ['09:14', 2], ['09:19', 4], ['10:05', 3], ['10:09', 5], ['11:40', 2], ['11:44', 3],
   ['11:50', 2], ['14:30', 4], ['14:34', 3], ['14:40', 2], ['16:20', 3], ['16:25', 4], ['17:10', 2]]
    .forEach(function (r, j) {
      S.push({ start: t(r[0]), dur: j === 6 ? 0 : r[1] * 60, type: j === 6 ? 'MISSED' : (j % 4 === 3 ? 'INCOMING' : 'OUTGOING') });
    });
  return { 'Amanpreet': A, 'Ashima': S };
}

// ---------- GOOGLE SHEET PART ----------
var HEAD_LOG = ['Caller', 'Date', 'Start time', 'Number', 'Direction', 'Duration (sec)', 'Key', 'StartMs'];
var HEAD_SUM = ['Date', 'Caller', 'Total calls', 'Outgoing', 'Incoming', 'Missed / Rejected',
  'Talktime (h:mm:ss)', 'Calls per hour', 'First call', 'Last call ended', 'Working min', 'Idle min',
  'Idle gaps', 'Longest idle (min)', 'Idle %'];
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var WDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function prettyDay(key) {
  var d = new Date(dayStartMs(key) + IST);
  return WDAYS[d.getUTCDay()] + ' ' + pad(d.getUTCDate()) + '-' + MONTHS[d.getUTCMonth()] + '-' + d.getUTCFullYear();
}

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(name, header) {
  var sh = ss_().getSheetByName(name) || ss_().insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#d9ead3');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Run this ONCE. Creates the tabs and adds two callers. */
function setup() {
  var c = ss_().getSheetByName('Callers') || ss_().insertSheet('Callers');
  if (c.getLastRow() === 0) {
    c.getRange(1, 1, 1, 4).setValues([['Caller', 'Phone number', 'Vertical', 'Token (secret)']])
      .setFontWeight('bold').setBackground('#d9ead3');
    c.setFrozenRows(1);
    c.getRange(2, 1, 2, 4).setValues([
      ['Amanpreet', '', 'Test', Utilities.getUuid().slice(0, 8)],
      ['Ashima', '', 'Test', Utilities.getUuid().slice(0, 8)]
    ]);
  }
  sheet_('Call Log', HEAD_LOG);
  sheet_('Daily Summary', HEAD_SUM);
  SpreadsheetApp.getUi().alert('Setup done. Tabs created: Callers, Call Log, Daily Summary.');
}

function tokenMap_() {
  var v = ss_().getSheetByName('Callers').getDataRange().getValues(), m = {};
  for (var i = 1; i < v.length; i++) if (v[i][3]) m[String(v[i][3]).trim()] = v[i][0];
  return m;
}

/** Phones POST here: {token, calls:[{time(ms), number, type, duration(sec)}]} */
function doPost(e) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var body = JSON.parse(e.postData.contents);
    var caller = tokenMap_()[String(body.token || '').trim()];
    if (!caller) return json_({ ok: false, error: 'bad token' });
    var sh = sheet_('Call Log', HEAD_LOG);
    var existing = {};
    if (sh.getLastRow() > 1) sh.getRange(2, 7, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { existing[r[0]] = 1; });
    var rows = [];
    (body.calls || []).forEach(function (c) {
      var key = caller + '|' + c.time + '|' + c.number;
      if (existing[key]) return;
      rows.push([caller, dayKey(c.time), fmtTime(c.time), c.number, c.type, c.duration, key, c.time]);
    });
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEAD_LOG.length).setValues(rows);
    return json_({ ok: true, added: rows.length });
  } finally { lock.releaseLock(); }
}
function doGet() { return json_({ ok: true, msg: 'Call tracker is running' }); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/** Rebuilds the Daily Summary tab from the Call Log (newest day first, callers A-Z). Runs automatically too. */
function rebuildSummary() {
  var log = sheet_('Call Log', HEAD_LOG), sum = sheet_('Daily Summary', HEAD_SUM);
  var v = log.getLastRow() > 1 ? log.getRange(2, 1, log.getLastRow() - 1, 8).getValues() : [];
  var groups = {}, days = {};
  v.forEach(function (r) {
    var startMs = Number(r[7]);
    if (!startMs) return;
    var d = dayKey(startMs);                       // day comes from the exact timestamp, not the Date column
    var k = d + '|' + String(r[0]).trim();
    (groups[k] = groups[k] || []).push({ start: startMs, dur: Number(r[5]) || 0, type: String(r[4]) });
    days[d] = 1;
  });
  var now = Date.now(); days[dayKey(now)] = 1;
  var callers = ss_().getSheetByName('Callers').getDataRange().getValues().slice(1)
    .map(function (r) { return String(r[0]).trim(); }).filter(String).sort();

  var out = [], bg = [], band = 0;
  Object.keys(days).sort().reverse().forEach(function (d) {
    callers.forEach(function (name) {
      var x = computeDay(groups[d + '|' + name] || [], d, now);
      var perHour = x.workMin ? Math.round(10 * x.total / (x.workMin / 60)) / 10 : 0;
      out.push([prettyDay(d), name, x.total, x.out, x.inc, x.missed, fmtDur(x.talkSec), perHour,
        x.first ? fmtTime(x.first) : '-', x.last ? fmtTime(x.last) : '-',
        x.workMin, x.idleMin, x.gaps, x.longestMin, x.workMin ? x.idleMin / x.workMin : '']);
      bg.push(HEAD_SUM.map(function () { return band % 2 ? '#f3f3f3' : '#ffffff'; }));
    });
    band++;
  });

  var n = HEAD_SUM.length;
  sum.getRange(1, 1, 1, n).setValues([HEAD_SUM]).setFontWeight('bold').setBackground('#d9ead3')
    .setWrap(true).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sum.setFrozenRows(1);
  sum.setFrozenColumns(2);
  var maxRows = sum.getMaxRows();
  if (maxRows > 1) sum.getRange(2, 1, maxRows - 1, n).clear();
  sum.clearConditionalFormatRules();
  if (!out.length) return;

  var body = sum.getRange(2, 1, out.length, n);
  [1, 2, 7, 9, 10].forEach(function (c) { sum.getRange(2, c, out.length, 1).setNumberFormat('@'); }); // keep as plain text
  body.setValues(out);
  body.setBackgrounds(bg).setVerticalAlignment('middle');
  sum.getRange(2, 3, out.length, n - 2).setHorizontalAlignment('center');
  sum.getRange(2, 8, out.length, 1).setNumberFormat('0.0');
  sum.getRange(2, 15, out.length, 1).setNumberFormat('0%');
  sum.getRange(2, 1, out.length, 2).setFontWeight('bold');
  sum.getRange(2, 1, out.length, n).setBorder(null, null, true, null, null, null, '#cccccc', SpreadsheetApp.BorderStyle.SOLID);

  var idleCol = sum.getRange(2, 15, out.length, 1);
  sum.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(0.5).setBackground('#f4cccc').setFontColor('#990000').setRanges([idleCol]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberLessThanOrEqualTo(0.2).setBackground('#d9ead3').setFontColor('#274e13').setRanges([idleCol]).build()
  ]);
  sum.setColumnWidths(1, 1, 120); sum.setColumnWidths(2, 1, 110); sum.setColumnWidths(3, n - 2, 85);
  sum.setRowHeight(1, 45);
}

/** TEST: fills two sample days for Amanpreet and Ashima, then builds the summary. */
function addTestData() {
  var log = sheet_('Call Log', HEAD_LOG), rows = [], now = Date.now();
  [dayKey(now - 86400000), dayKey(now - 2 * 86400000)].forEach(function (d) {
    var t = genTestCalls(d);
    Object.keys(t).forEach(function (name) {
      t[name].forEach(function (c, i) {
        rows.push([name, d, fmtTime(c.start), '98' + (10000000 + i * 7919 % 89999999), c.type, c.dur, 'TEST|' + name + '|' + c.start, c.start]);
      });
    });
  });
  log.getRange(log.getLastRow() + 1, 1, rows.length, HEAD_LOG.length).setValues(rows);
  rebuildSummary();
}

/** Run ONCE: refreshes the summary every 10 minutes automatically. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('rebuildSummary').timeBased().everyMinutes(10).create();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Call Tracker')
    .addItem('1. Setup (run once)', 'setup')
    .addItem('2. Add test data', 'addTestData')
    .addItem('3. Rebuild summary now', 'rebuildSummary')
    .addItem('4. Auto-refresh every 10 min', 'installTrigger')
    .addToUi();
}
