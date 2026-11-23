/**
 * Telecaller Call Tracker  (Google Sheet + Apps Script)
 * Phones send call logs here (doPost) -> "Call Log" tab -> "Daily Summary" tab.
 *
 * Working time = shift start to shift end, MINUS lunch and tea breaks (set per caller in the Callers tab).
 * Productivity % = time actually on calls (inside working time) / working time.
 * Idle = no call for IDLE_MIN minutes or more, inside working time.
 */

// ---------- DEFAULT SETTINGS (a caller's own cells in the Callers tab override these) ----------
var CFG = {
  SHIFT_START: '09:00',
  SHIFT_END: '18:00',
  BREAK_MIN: 60,          // total break per day (lunch + tea together), no fixed times
  IDLE_MIN: 10,           // gap with no call that counts as idle
  PROD_GOOD: 0.40,        // productivity at or above this = green
  PROD_LOW: 0.20,         // productivity below this = red
  CONNECT_MIN: 60         // phone not heard from for this many minutes = NOT CONNECTED
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
function fmtTime(ms) {               // HH:MM
  var d = new Date(ms + IST);
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}
function fmtTimeS(ms) {              // HH:MM:SS
  var d = new Date(ms + IST);
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
}
function fmtHMS(ms) {                // duration -> HH:MM:SS (hours can pass 24)
  var t = Math.round(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return pad(h) + ':' + pad(m) + ':' + pad(s);
}
/** "9:00", "09:00", "9:00 AM", "6:00 PM", "18:00:00" -> "HH:MM". Blank/invalid -> fallback. */
function parseHM(v, fb) {
  var s = String(v == null ? '' : v).trim().toUpperCase();
  if (!s) return fb;
  var m = s.match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(AM|PM)?$/);
  if (!m) return fb;
  var h = +m[1], mi = +m[2];
  if (m[3] === 'PM' && h < 12) h += 12;
  if (m[3] === 'AM' && h === 12) h = 0;
  if (h > 23 || mi > 59) return fb;
  return pad(h) + ':' + pad(mi);
}
/** Total break as typed in the Callers tab: "01:00" = 1 hour, "00:45" = 45 min, "60" = 60 min, "-" = none.
 *  Returns minutes, or null if blank/invalid (or more than 4 hours). */
function parseBreakMin(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return null;
  if (s === '-' || s === 'none' || s === 'no' || s === '0') return 0;
  var m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/), min;
  if (m) { if (+m[2] > 59) return null; min = +m[1] * 60 + +m[2]; }
  else if (/^\d{1,3}$/.test(s)) min = +s;
  else return null;
  return min > 240 ? null : min;
}
/** Callers-tab row (as displayed text) -> shift. Columns: E = shift start, F = shift end, G = total break. */
function shiftFromRow(r) {
  var b = parseBreakMin(r[6]);
  return {
    start: parseHM(r[4], CFG.SHIFT_START),
    end: parseHM(r[5], CFG.SHIFT_END),
    breakMin: b === null ? CFG.BREAK_MIN : b
  };
}
function defaultShift() { return { start: CFG.SHIFT_START, end: CFG.SHIFT_END, breakMin: CFG.BREAK_MIN }; }

/**
 * calls: [{start(ms), dur(sec), type}] for ONE caller on ONE day. nowMs cuts off today's working time.
 * Working time = shift so far minus the break allowance (full allowance once the shift is over; part of it
 * while the shift is still running). The break is assumed to be taken inside the longest no-call gaps, so
 * those minutes are NOT counted as idle.
 */
function computeDay(calls, key, nowMs, shift) {
  shift = shift || defaultShift();
  var base = dayStartMs(key);
  var s = base + hmMs(shift.start), e = base + hmMs(shift.end);
  var upto = Math.min(e, nowMs), elapsed = Math.max(0, upto - s), full = Math.max(1, e - s);
  var breakMs = Math.min(elapsed, shift.breakMin * 60000 * (elapsed / full));
  var workMs = Math.max(0, elapsed - breakMs);

  var busy = calls.filter(function (c) { return c.dur > 0; })
    .map(function (c) { return [c.start, c.start + c.dur * 1000]; })
    .sort(function (a, b) { return a[0] - b[0]; });

  var talkMs = 0, gaps = [], thr = CFG.IDLE_MIN * 60000, cur = s;
  if (elapsed > 0) {
    busy.forEach(function (b) {
      var bs = Math.max(b[0], s), be = Math.min(b[1], upto);
      if (be <= bs) return;
      talkMs += be - bs;
      if (bs > cur && bs - cur >= thr) gaps.push(bs - cur);
      cur = Math.max(cur, be);
    });
    if (upto > cur && upto - cur >= thr) gaps.push(upto - cur);
  }
  // the break allowance is taken out of the longest gaps first
  gaps.sort(function (a, b) { return b - a; });
  var left = breakMs, kept = [];
  gaps.forEach(function (g) {
    var use = Math.min(g, left); left -= use; g -= use;
    if (g >= thr) kept.push(g);
  });
  var idleMs = 0, longest = 0;
  kept.forEach(function (g) { idleMs += g; if (g > longest) longest = g; });

  var out = 0, inc = 0, missed = 0, outside = 0, first = null, last = null;
  calls.forEach(function (c) {
    if (c.type === 'OUTGOING') out++;
    else if (c.type === 'INCOMING') inc++;
    else missed++;                                  // MISSED / REJECTED
    if (c.start < s || c.start >= e) outside++;
    if (first === null || c.start < first) first = c.start;
    var end = c.start + c.dur * 1000;
    if (last === null || end > last) last = end;
  });
  return {
    total: calls.length, out: out, inc: inc, missed: missed, outside: outside,
    first: first, last: last,
    workMs: workMs, breakMs: breakMs, talkMs: talkMs, idleMs: idleMs, gaps: kept.length, longestMs: longest
  };
}

/** Fake but realistic calls for testing. Amanpreet = busy, Ashima = long idle stretches. */
function genTestCalls(key) {
  var base = dayStartMs(key);
  function t(hhmm) { return base + hmMs(hhmm); }
  var A = [], S = [];
  var tm = t('09:05'), i = 0, lunchS = t('13:10'), lunchE = t('13:50'), end = t('17:55');
  while (tm < end) {
    if (tm >= lunchS && tm < lunchE) { tm = lunchE + 120000; continue; }
    A.push({ start: tm, dur: 120 + (i * 37) % 120, type: i % 5 === 4 ? 'INCOMING' : 'OUTGOING' });
    tm += (6 + (i * 3) % 3) * 60000 + 60000 * 2; i++;
  }
  [['09:10', 3], ['09:14', 2], ['09:19', 4], ['10:05', 3], ['10:09', 5], ['11:40', 2], ['11:44', 3],
   ['11:50', 2], ['14:30', 4], ['14:34', 3], ['14:40', 2], ['16:30', 3], ['16:35', 4], ['17:10', 2]]
    .forEach(function (r, j) {
      S.push({ start: t(r[0]), dur: j === 6 ? 0 : r[1] * 60, type: j === 6 ? 'MISSED' : (j % 4 === 3 ? 'INCOMING' : 'OUTGOING') });
    });
  return { 'Amanpreet': A, 'Ashima': S };
}

// ---------- GOOGLE SHEET PART ----------
var HEAD_LOG = ['Caller', 'Date', 'Start time', 'Number', 'Direction', 'Duration (sec)', 'Key', 'StartMs'];
var HEAD_CALLERS = ['Caller', 'Phone number', 'Company / Vertical', 'Token (secret)',
  'Shift start', 'Shift end', 'Total break (hh:mm)', '(not used)', '(not used)', '(not used)',
  'App status', 'Last seen', 'LastSeenMs (auto)', 'Call log permission (auto)', 'App version (auto)'];
var HEAD_SUM = ['Date', 'Caller', 'Company', 'Shift timing',
  'Total calls', 'Outgoing calls', 'Incoming calls', 'Missed / Rejected calls', 'Calls outside shift timing',
  'Calls per working hour', 'Working time (excl. breaks)', 'Total talk time on calls', 'Productivity %',
  'Total idle time (10+ min gaps with no call)', 'No. of times idle (10+ min gap)', 'Longest single idle gap',
  'First call', 'Last call ended'];
var NOTES_SUM = [
  'Day of the calls.', 'Telecaller name (Callers tab).', 'Company / vertical (Callers tab).',
  'Shift start to shift end for this caller (set in the Callers tab).',
  'All calls in the phone call log that day.', 'Calls the caller dialled.', 'Calls the caller received and answered.',
  'Calls that rang but were not answered, or were declined.',
  'Calls that started before the shift start or after the shift end.',
  'Calls made inside working time divided by working hours.',
  'Shift length minus the total break time (lunch + tea). Today: only up to the current time, with the break counted in proportion.',
  'Time actually spent talking on calls, inside working time (hh:mm:ss).',
  'Time on calls divided by working time. Green = good, red = low.',
  'Add up every gap of 10 minutes or more in which the caller made no call. The break time is taken out of the longest gaps first, so lunch and tea are not counted as idle.',
  'How many separate times the caller sat idle for 10 minutes or more with no call. Example: 5 means five different long gaps.',
  'The biggest single gap with no call that day. Example: 00:42:42 means the longest time without a call in one go was 42 minutes 42 seconds.',
  'Start time of the first call of the day.', 'Time the last call of the day ended.'];

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(name, header) {
  var sh = ss_().getSheetByName(name) || ss_().insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#d9ead3');
    sh.setFrozenRows(1);
  }
  return sh;
}
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var WDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function serialDate(key) {            // Google Sheets date number for a yyyy-mm-dd key
  var p = key.split('-');
  return Math.round((Date.UTC(+p[0], +p[1] - 1, +p[2]) - Date.UTC(1899, 11, 30)) / 86400000);
}
function prettyDay(key) {
  var d = new Date(dayStartMs(key) + IST);
  return WDAYS[d.getUTCDay()] + ' ' + pad(d.getUTCDate()) + '-' + MONTHS[d.getUTCMonth()] + '-' + d.getUTCFullYear();
}

/** Run this ONCE. Creates the tabs and adds two test callers. */
function setup() {
  var c = ss_().getSheetByName('Callers') || ss_().insertSheet('Callers');
  if (c.getLastRow() === 0) {
    c.getRange(1, 1, 1, 4).setValues([HEAD_CALLERS.slice(0, 4)]);
    c.getRange(2, 1, 2, 4).setValues([
      ['Amanpreet', '', 'Test', Utilities.getUuid().slice(0, 8)],
      ['Ashima', '', 'Test', Utilities.getUuid().slice(0, 8)]
    ]);
  }
  sheet_('Call Log', HEAD_LOG);
  sheet_('Daily Summary', HEAD_SUM);
  updateCallersTab();
  SpreadsheetApp.getUi().alert('Setup done. Tabs: Callers, Call Log, Daily Summary.');
}

/** Adds the shift / break columns to the Callers tab and fills blanks with defaults. Safe to run again. */
function updateCallersTab() {
  var c = ss_().getSheetByName('Callers');
  var n = HEAD_CALLERS.length;
  c.getRange(1, 1, 1, n).setValues([HEAD_CALLERS]).setFontWeight('bold').setBackground('#d9ead3')
    .setWrap(true).setHorizontalAlignment('center');
  c.setFrozenRows(1);
  var last = Math.max(c.getLastRow(), 2);
  c.getRange(2, 5, 200, 3).setNumberFormat('@');                       // keep times as plain text like 09:00
  var vals = c.getRange(2, 1, last - 1, n).getDisplayValues();
  var fill = vals.map(function (r) {
    if (!r[0]) return [r[4], r[5], r[6], '', '', ''];
    return [parseHM(r[4], '') || CFG.SHIFT_START, parseHM(r[5], '') || CFG.SHIFT_END,
      parseBreakMin(r[6]) === null ? '01:00' : r[6], '', '', ''];       // old lunch/tea cells are cleared
  });
  c.getRange(2, 5, fill.length, 6).setValues(fill);
  c.getRange(1, 5, 1, 3).setNotes([['Shift start, e.g. 09:00', 'Shift end, e.g. 18:00',
    'Total break per day (lunch + tea together), e.g. 01:00 = 1 hour, 00:45 = 45 minutes. Type - if none.']]);
  c.setColumnWidths(5, 3, 85);
  c.getRange(2, 5, 200, 3).setHorizontalAlignment('center');
  c.hideColumns(8, 3);
  c.setColumnWidths(11, 1, 230); c.setColumnWidths(12, 1, 140);
  c.hideColumns(13);
  c.getRange(1, 11, 1, 5).setNotes([['CONNECTED = this caller\'s phone sent data recently. NOT CONNECTED = app deleted, phone off, or no internet.',
    'Last time the phone contacted the Sheet.', 'Automatic - do not edit.', 'Automatic - OFF means the caller switched off call log permission.', 'Automatic.']]);
}

function tokenMap_() {
  var v = ss_().getSheetByName('Callers').getDataRange().getValues(), m = {};
  for (var i = 1; i < v.length; i++) if (v[i][3]) m[String(v[i][3]).trim()] = v[i][0];
  return m;
}

/** Phones POST here. action = login | enroll (admin only) | sync (default, with caller token). */
function doPost(e) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action || 'sync';
    if (action === 'login' || action === 'enroll') return adminAction_(action, body);
    return syncAction_(body);
  } catch (err) {
    return json_({ ok: false, error: 'bad request' });
  } finally { lock.releaseLock(); }
}

function syncAction_(body) {
  var token = String(body.token || '').trim();
  var c = ss_().getSheetByName('Callers'), cv = c.getDataRange().getValues(), rowIdx = -1, caller = '';
  for (var i = 1; i < cv.length; i++) if (token && String(cv[i][3]).trim() === token) { rowIdx = i + 1; caller = cv[i][0]; break; }
  if (rowIdx < 0) return json_({ ok: false, error: 'bad token' });

  var sh = sheet_('Call Log', HEAD_LOG);
  var existing = {};
  if (sh.getLastRow() > 1) sh.getRange(2, 7, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { existing[r[0]] = 1; });
  var rows = [];
  (body.calls || []).forEach(function (x) {
    var key = caller + '|' + x.time + '|' + x.number;
    if (existing[key]) return;
    rows.push([caller, dayKey(x.time), fmtTimeS(x.time), x.number, x.type, x.duration, key, x.time]);
  });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEAD_LOG.length).setValues(rows);

  // heartbeat: proves the app is installed and running on this caller's phone
  c.getRange(rowIdx, 13, 1, 3).setValues([[Date.now(), body.perm === false ? 'OFF' : 'OK', String(body.ver || '')]]);
  return json_({ ok: true, added: rows.length });
}

// ----- Admin login (ID + password are stored only as hashes in Script Properties) -----
function hash_(salt, v) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + String(v));
  return bytes.map(function (b) { return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2); }).join('');
}
/** Menu item 6: you type an admin ID and password. Only you will know them. */
function setAdminLogin() {
  var ui = SpreadsheetApp.getUi();
  var a = ui.prompt('Admin ID', 'Type the admin ID you want to use (example: rajinder):', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK || !a.getResponseText().trim()) return;
  var p = ui.prompt('Admin password', 'Type a strong password (8+ characters). Do not share it with callers:', ui.ButtonSet.OK_CANCEL);
  if (p.getSelectedButton() !== ui.Button.OK || p.getResponseText().length < 8) { ui.alert('Password must be 8 or more characters. Nothing saved.'); return; }
  var props = PropertiesService.getScriptProperties();
  var salt = Utilities.getUuid();
  props.setProperties({ SALT: salt, ADMIN_ID_HASH: hash_(salt, a.getResponseText().trim().toLowerCase()),
    ADMIN_PASS_HASH: hash_(salt, p.getResponseText()), FAILS: '0', LOCK_UNTIL: '0' });
  ui.alert('Admin login saved. Use this ID and password inside the app on each phone, once.');
}
function adminAction_(action, body) {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('ADMIN_PASS_HASH')) return json_({ ok: false, error: 'not_set', msg: 'Admin login is not set yet. In the Sheet click Call Tracker > 6. Set admin login.' });
  if (Date.now() < Number(props.getProperty('LOCK_UNTIL') || 0)) return json_({ ok: false, error: 'locked', msg: 'Too many wrong attempts. Try again after 15 minutes.' });
  var salt = props.getProperty('SALT');
  var ok = hash_(salt, String(body.adminId || '').trim().toLowerCase()) === props.getProperty('ADMIN_ID_HASH') &&
           hash_(salt, body.adminPass || '') === props.getProperty('ADMIN_PASS_HASH');
  if (!ok) {
    var f = Number(props.getProperty('FAILS') || 0) + 1;
    if (f >= 5) { props.setProperties({ FAILS: '0', LOCK_UNTIL: String(Date.now() + 15 * 60000) }); }
    else props.setProperty('FAILS', String(f));
    return json_({ ok: false, error: 'wrong', msg: 'Wrong admin ID or password.' });
  }
  props.setProperty('FAILS', '0');
  var cv = ss_().getSheetByName('Callers').getDataRange().getValues().slice(1)
    .filter(function (r) { return String(r[0]).trim() && String(r[3]).trim(); });
  if (action === 'login') return json_({ ok: true, callers: cv.map(function (r) { return String(r[0]).trim(); }) });
  for (var i = 0; i < cv.length; i++) if (String(cv[i][0]).trim() === String(body.caller || '').trim()) return json_({ ok: true, token: String(cv[i][3]).trim() });
  return json_({ ok: false, error: 'no_caller', msg: 'Caller not found in the Callers tab.' });
}

/** Writes CONNECTED / NOT CONNECTED into the Callers tab (App status + Last seen). */
function refreshConnection_() {
  var c = ss_().getSheetByName('Callers'); if (!c || c.getLastRow() < 2) return;
  var n = c.getLastRow() - 1, v = c.getRange(2, 1, n, 15).getValues(), now = Date.now(), out = [];
  v.forEach(function (r) {
    if (!String(r[0]).trim()) { out.push(['', '']); return; }
    var last = Number(r[12]) || 0;
    if (!last) { out.push(['NOT CONNECTED (app never connected)', '-']); return; }
    var seen = dayKey(last) + ' ' + fmtTimeS(last);
    var recent = now - last <= CFG.CONNECT_MIN * 60000;
    var st = !recent ? 'NOT CONNECTED (app deleted, phone off or no internet)'
      : (String(r[13]) === 'OFF' ? 'PERMISSION OFF (call log not allowed)' : 'CONNECTED');
    out.push([st, seen]);
  });
  var kr = c.getRange(2, 11, n, 2);
  kr.setNumberFormat('@'); kr.setValues(out);
  var col = c.getRange(2, 11, n, 1);
  c.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('NOT CONNECTED').setBackground('#f4cccc').setFontColor('#990000').setRanges([col]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('PERMISSION').setBackground('#fce5cd').setFontColor('#b45f06').setRanges([col]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('CONNECTED').setBackground('#d9ead3').setFontColor('#274e13').setRanges([col]).build()
  ]);
}
function doGet() { return json_({ ok: true, msg: 'Call tracker is running' }); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/** Rebuilds Daily Summary (newest day first, callers A-Z). Also tidies Date/Time in Call Log to dd-Mon-yyyy and hh:mm:ss. */
function rebuildSummary() {
  refreshConnection_();
  var log = sheet_('Call Log', HEAD_LOG), sum = sheet_('Daily Summary', HEAD_SUM);
  var v = log.getLastRow() > 1 ? log.getRange(2, 1, log.getLastRow() - 1, 8).getValues() : [];

  // tidy Call Log date + time columns from the exact timestamp
  if (v.length) {
    var bc = v.map(function (r) {
      var ms = Number(r[7]);
      return ms ? [prettyDay(dayKey(ms)), fmtTimeS(ms)] : [r[1], r[2]];
    });
    var tr = log.getRange(2, 2, v.length, 2);
    tr.setNumberFormat('@'); tr.setValues(bc);
  }

  var groups = {}, days = {};
  v.forEach(function (r) {
    var startMs = Number(r[7]);
    if (!startMs) return;
    var d = dayKey(startMs);
    var k = d + '|' + String(r[0]).trim();
    (groups[k] = groups[k] || []).push({ start: startMs, dur: Number(r[5]) || 0, type: String(r[4]) });
    days[d] = 1;
  });
  var now = Date.now(); days[dayKey(now)] = 1;

  var callerRows = ss_().getSheetByName('Callers').getDataRange().getDisplayValues().slice(1)
    .filter(function (r) { return String(r[0]).trim(); })
    .sort(function (a, b) { return String(a[0]).trim() < String(b[0]).trim() ? -1 : 1; });

  var out = [], bg = [], helper = [], band = 0;
  Object.keys(days).sort().reverse().forEach(function (d) {
    callerRows.forEach(function (cr) {
      var name = String(cr[0]).trim(), shift = shiftFromRow(cr);
      var x = computeDay(groups[d + '|' + name] || [], d, now, shift);
      var hrs = x.workMs / 3600000;
      out.push([prettyDay(d), name, cr[2], shift.start + ' to ' + shift.end + ' (break ' + fmtHMS(shift.breakMin * 60000).slice(0, 5) + ')',
        x.total, x.out, x.inc, x.missed, x.outside,
        hrs ? Math.round(10 * (x.total - x.outside) / hrs) / 10 : 0,
        fmtHMS(x.workMs), fmtHMS(x.talkMs), x.workMs ? x.talkMs / x.workMs : '',
        fmtHMS(x.idleMs), x.gaps, fmtHMS(x.longestMs),
        x.first ? fmtTimeS(x.first) : '-', x.last ? fmtTimeS(x.last) : '-']);
      helper.push([serialDate(d), Math.round(x.talkMs / 1000), Math.round(x.idleMs / 1000), Math.round(x.workMs / 1000), Math.round(x.longestMs / 1000)]);
      bg.push(HEAD_SUM.map(function () { return band % 2 ? '#f3f3f3' : '#ffffff'; }));
    });
    band++;
  });

  var n = HEAD_SUM.length;
  var maxRows = sum.getMaxRows();
  if (sum.getMaxColumns() < n) sum.insertColumnsAfter(sum.getMaxColumns(), n - sum.getMaxColumns());
  sum.getRange(1, 1, maxRows, Math.max(n, sum.getMaxColumns())).clear();
  sum.clearConditionalFormatRules();
  sum.getRange(1, 1, 1, n).setValues([HEAD_SUM]).setFontWeight('bold').setBackground('#d9ead3')
    .setWrap(true).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sum.getRange(1, 1, 1, n).setNotes([NOTES_SUM]);
  sum.setFrozenRows(1);
  sum.setFrozenColumns(2);
  if (!out.length) return;

  var body = sum.getRange(2, 1, out.length, n);
  sum.getRange(1, 19, 1, 5).setValues([['(helper) date', '(helper) talk sec', '(helper) idle sec', '(helper) work sec', '(helper) longest idle sec']]);
  sum.getRange(2, 19, out.length, 5).setValues(helper);
  sum.getRange(2, 19, out.length, 1).setNumberFormat('dd/mm/yyyy');
  sum.hideColumns(19, 5);
  [1, 2, 3, 4, 11, 12, 14, 16, 17, 18].forEach(function (c) { sum.getRange(2, c, out.length, 1).setNumberFormat('@'); });
  body.setValues(out);
  body.setBackgrounds(bg).setVerticalAlignment('middle');
  sum.getRange(2, 5, out.length, n - 4).setHorizontalAlignment('center');
  sum.getRange(2, 10, out.length, 1).setNumberFormat('0.0');
  sum.getRange(2, 13, out.length, 1).setNumberFormat('0%');
  sum.getRange(2, 1, out.length, 2).setFontWeight('bold');
  sum.getRange(2, 1, out.length, n).setBorder(null, null, true, null, null, null, '#cccccc', SpreadsheetApp.BorderStyle.SOLID);

  var prod = sum.getRange(2, 13, out.length, 1);
  sum.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(CFG.PROD_GOOD).setBackground('#d9ead3').setFontColor('#274e13').setRanges([prod]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(CFG.PROD_LOW).setBackground('#f4cccc').setFontColor('#990000').setRanges([prod]).build()
  ]);
  sum.setColumnWidths(1, 1, 120); sum.setColumnWidths(2, 1, 100); sum.setColumnWidths(3, 1, 100);
  sum.setColumnWidths(4, 1, 105); sum.setColumnWidths(5, n - 4, 95);
  sum.setRowHeight(1, 60);
  try { ensureDashboard_(false); } catch (err) { /* dashboard problems must never break the summary */ }
}


// ---------- DASHBOARD TAB (pick dates in A1 and B1) ----------
var DASH_CHARTS = 1;   // one chart only: calls by hour of the day
var DASH_HEAD = ['Date', 'Caller name', 'Company', 'Shift timing', 'Total calls (made + received)', 'Outgoing calls',
  'Incoming calls', 'Missed / Rejected calls', 'Total talk time on calls', 'Total idle time (10+ min gaps with no call)',
  'No. of times idle (10+ min gap)', 'Longest single idle gap', 'First call', 'Last call ended'];
var DASH_NOTES = ['Day of the calls.', 'Telecaller name.', 'Company / vertical.', 'Shift start to end, and the total break that is deducted.',
  'Every call on the phone that day: calls the caller made + calls the caller received + missed/rejected calls.',
  'Calls the caller dialled to customers (includes calls that were not picked up).',
  'Calls from customers that the caller picked up.',
  'Missed = a customer called and the caller did not pick up. Rejected = a customer called and the caller cut the call. (A call the caller dialled that nobody answered is counted under Outgoing.)',
  'Total time spent talking on connected calls (hh:mm:ss).',
  'Add up every gap of 10+ minutes with no call. Break time is taken out of the longest gaps first.',
  'How many separate times the caller sat idle for 10+ minutes.',
  'The biggest single gap with no call that day.', 'Time the first call started.', 'Time the last call ended.'];
var HEAT_FIRST_HOUR = 8, HEAT_HOURS = 12;           // heatmap covers 8 AM to 8 PM
var PAL = { blue: '#1a73e8', green: '#188038', red: '#d93025', amber: '#f9ab00' };

function ensureDashboard_(force) {
  var callers = ss_().getSheetByName('Callers').getDataRange().getDisplayValues().slice(1)
    .map(function (r) { return String(r[0]).trim(); }).filter(String).sort();
  var props = PropertiesService.getScriptProperties();
  var sh = ss_().getSheetByName('Dashboard');
  var key = 'v6|' + callers.join('|');
  if (sh && !force && props.getProperty('DASH_KEY') === key && sh.getCharts().length === (callers.length ? DASH_CHARTS : 0)) return;
  buildDashboard_(callers);
  props.setProperty('DASH_KEY', key);
}

/** Menu item 7: builds (or rebuilds) the Dashboard tab. */
function buildDashboard() {
  ensureDashboard_(true);
  ss_().setActiveSheet(ss_().getSheetByName('Dashboard'));
}

function hourLabel_(h) { return (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? ' AM' : ' PM'); }

function buildDashboard_(callers) {
  var sh = ss_().getSheetByName('Dashboard');
  var isNew = !sh;
  if (isNew) { sh = ss_().insertSheet('Dashboard', 0); }
  var keepFrom = sh.getRange('A1').getValue(), keepTo = sh.getRange('B1').getValue();
  sh.getCharts().forEach(function (c) { sh.removeChart(c); });
  if (sh.getMaxColumns() < 32) sh.insertColumnsAfter(sh.getMaxColumns(), 32 - sh.getMaxColumns());
  sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), sh.getMaxColumns()).clear();
  sh.clearConditionalFormatRules();
  sh.setHiddenGridlines(true);

  var DS = "'Daily Summary'!", LOG = "'Call Log'!";
  function rng(col) { return DS + '$' + col + '$2:$' + col + '$1000'; }
  var between = rng('S') + ',">="&$Q$1,' + rng('S') + ',"<="&$Q$2';
  var n = callers.length;

  // ===== A1 / B1: the two dates you choose =====
  var today = serialDate(dayKey(Date.now()));
  sh.getRange('A1:B1').setNumberFormat('dd/mm/yyyy').setBackground('#fff2cc').setFontWeight('bold')
    .setHorizontalAlignment('center').setBorder(true, true, true, true, true, true, '#bf9000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sh.getRange('A1').setValue(keepFrom || today);
  sh.getRange('B1').setValue(keepTo || today);
  var dv = SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).setHelpText('Type or pick a date, dd/mm/yyyy').build();
  sh.getRange('A1:B1').setDataValidation(dv);
  sh.getRange('A1').setNote('FROM date (dd/mm/yyyy). Click the cell and type or pick a date.');
  sh.getRange('B1').setNote('TO date (dd/mm/yyyy). For a single day, use the same date as A1 (or leave B1 empty).');
  sh.getRange('C1').setValue('<-- Choose FROM date in A1 and TO date in B1. Everything below updates by itself.')
    .setFontColor('#7f6000').setFontStyle('italic');

  // helper cells (dates actually used)
  sh.getRange('P1').setValue('From date used'); sh.getRange('Q1').setFormula('=IF($A$1="",TODAY(),$A$1)');
  sh.getRange('P2').setValue('To date used'); sh.getRange('Q2').setFormula('=IF($B$1="",$Q$1,MAX($B$1,$Q$1))');
  sh.getRange('Q1:Q2').setNumberFormat('dd/mm/yyyy');
  sh.getRange('R1').setValue('From (ms)'); sh.getRange('S1').setFormula('=($Q$1-25569)*86400000-19800000');
  sh.getRange('R2').setValue('To, end of day (ms)'); sh.getRange('S2').setFormula('=($Q$2-25569+1)*86400000-19800000');
  sh.getRange('S1:S2').setNumberFormat('0');
  sh.getRange('P1:S2').setFontColor('#999999');

  // ===== title + KPI cards =====
  sh.getRange('A2').setFormula('="TELECALLER REPORT  |  "&TEXT($Q$1,"dd/mm/yyyy")&IF($Q$2<>$Q$1," to "&TEXT($Q$2,"dd/mm/yyyy"),"")')
    .setFontSize(15).setFontWeight('bold').setFontColor('#174ea6');
  sh.getRange('A3:E3').setValues([['Total calls (made + received)', 'Total talk time', 'Total idle time', 'Overall productivity', 'Days selected']])
    .setFontWeight('bold').setFontColor('#ffffff').setBackground('#1a73e8').setHorizontalAlignment('center').setWrap(true).setVerticalAlignment('middle');
  sh.getRange('A4').setFormula('=SUMIFS(' + rng('E') + ',' + between + ')');
  sh.getRange('B4').setFormula('=TEXT(SUMIFS(' + rng('T') + ',' + between + ')/86400,"[h]:mm:ss")');
  sh.getRange('C4').setFormula('=TEXT(SUMIFS(' + rng('U') + ',' + between + ')/86400,"[h]:mm:ss")');
  sh.getRange('D4').setFormula('=IFERROR(SUMIFS(' + rng('T') + ',' + between + ')/SUMIFS(' + rng('V') + ',' + between + '),0)');
  sh.getRange('E4').setFormula('=$Q$2-$Q$1+1');
  sh.getRange('A4:E4').setFontSize(17).setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle')
    .setBackground('#e8f0fe').setFontColor('#174ea6').setBorder(true, true, true, true, true, true, '#c6dafc', SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange('A4').setNumberFormat('0'); sh.getRange('D4').setNumberFormat('0%'); sh.getRange('E4').setNumberFormat('0');
  sh.setRowHeight(3, 40); sh.setRowHeight(4, 40);

  // ===== heatmap: calls by hour of day (rows 39+) =====
  var H0 = 7;
  sh.getRange(H0, 1).setValue('TIME-WISE CALLS  (calls per hour of the day for each caller; darker green = more calls, white = none)')
    .setFontWeight('bold').setFontSize(12).setFontColor('#174ea6');
  var hh = ['Caller']; for (var h = 0; h < HEAT_HOURS; h++) hh.push(hourLabel_(HEAT_FIRST_HOUR + h)); hh.push('Total');
  sh.getRange(H0 + 1, 1, 1, hh.length).setValues([hh]).setFontWeight('bold').setFontColor('#ffffff').setBackground('#1a73e8')
    .setHorizontalAlignment('center');
  if (n) {
    var hf = [], names = [];
    var Hc = LOG + '$H$2:$H$20000', hr = 'MOD(' + Hc + '/3600000+5.5,24)';
    for (var i2 = 0; i2 < n; i2++) {
      var rr = H0 + 2 + i2, row = [];
      for (var h2 = 0; h2 < HEAT_HOURS; h2++) {
        var hv = HEAT_FIRST_HOUR + h2;
        row.push('=SUMPRODUCT((' + LOG + '$A$2:$A$20000=$A' + rr + ')*(' + Hc + '>=$S$1)*(' + Hc + '<$S$2)*(' + hr + '>=' + hv + ')*(' + hr + '<' + (hv + 1) + '))');
      }
      row.push('=SUM(B' + rr + ':' + String.fromCharCode(65 + HEAT_HOURS) + rr + ')');
      hf.push(row); names.push([callers[i2]]);
    }
    sh.getRange(H0 + 2, 1, n, 1).setValues(names).setFontWeight('bold');
    sh.getRange(H0 + 2, 2, n, HEAT_HOURS + 1).setFormulas(hf).setHorizontalAlignment('center');
    sh.getRange(H0 + 2, 1, n, HEAT_HOURS + 2).setBorder(true, true, true, true, true, true, '#dadce0', SpreadsheetApp.BorderStyle.SOLID);
    sh.getRange(H0 + 2, HEAT_HOURS + 2, n, 1).setFontWeight('bold').setBackground('#e8f0fe');
    // last row: total of all callers
    var tr = H0 + 2 + n, tf = [];
    for (var c4 = 0; c4 <= HEAT_HOURS; c4++) { var L4 = String.fromCharCode(66 + c4); tf.push('=SUM(' + L4 + (H0 + 2) + ':' + L4 + (H0 + 1 + n) + ')'); }
    sh.getRange(tr, 1).setValue('TOTAL (all callers)');
    sh.getRange(tr, 2, 1, HEAT_HOURS + 1).setFormulas([tf]);
    sh.getRange(tr, 1, 1, HEAT_HOURS + 2).setFontWeight('bold').setBackground('#d2e3fc').setHorizontalAlignment('center')
      .setBorder(true, true, true, true, true, true, '#dadce0', SpreadsheetApp.BorderStyle.SOLID);
  }

  // ===== time-wise chart data (visible grey helper from column U): hours down, one column per caller =====
  sh.getRange(H0 + 1, 21).setValue('Hour').setFontColor('#999999').setFontWeight('bold');
  if (n) sh.getRange(H0 + 1, 22, 1, n).setValues([callers]).setFontColor('#999999').setFontWeight('bold');
  for (var h3 = 0; h3 < HEAT_HOURS; h3++) {
    var colL = String.fromCharCode(66 + h3), fr = [];
    sh.getRange(H0 + 2 + h3, 21).setValue(hourLabel_(HEAT_FIRST_HOUR + h3));
    for (var c3 = 0; c3 < n; c3++) fr.push('=' + colL + (H0 + 2 + c3));
    if (n) sh.getRange(H0 + 2 + h3, 22, 1, n).setFormulas([fr]);
  }
  sh.getRange(H0 + 2, 21, HEAT_HOURS, n + 1).setFontColor('#999999');
  sh.setColumnWidth(21, 70);

  // ===== detailed table =====
  var T = H0 + 2 + n + 3 + 17;   // 17 rows of room for the hourly chart
  sh.getRange(T - 1, 1).setValue('DETAILED REPORT').setFontWeight('bold').setFontSize(12).setFontColor('#174ea6');
  sh.getRange(T, 1, 1, DASH_HEAD.length).setValues([DASH_HEAD]).setFontWeight('bold').setFontColor('#ffffff').setBackground('#1a73e8')
    .setWrap(true).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange(T, 1, 1, DASH_HEAD.length).setNotes([DASH_NOTES]);
  sh.setRowHeight(T, 62);
  sh.getRange(T + 1, 1).setFormula('=IFERROR(FILTER({' + DS + 'A2:H1000,' + DS + 'L2:L1000,' + DS + 'N2:R1000},' +
    '(' + rng('S') + '>=$Q$1)*(' + rng('S') + '<=$Q$2)*(' + rng('S') + '<>"")),"No calls found for these dates")');
  sh.getRange(T + 1, 1, 400, DASH_HEAD.length).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange(T + 1, 1, 400, 2).setFontWeight('bold');
  var widths = [130, 100, 100, 150, 100, 90, 90, 100, 110, 130, 150, 110, 95, 110];
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.setColumnWidth(15, 30);
  sh.hideColumns(16, 4);

  var rules = [
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($A' + (T + 1) + '<>"",ISEVEN(ROW()))').setBackground('#f1f3f4')
      .setRanges([sh.getRange(T + 1, 1, 400, DASH_HEAD.length)]).build()];
  if (n) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .setGradientMinpoint('#ffffff').setGradientMaxpoint('#34a853')
      .setRanges([sh.getRange(H0 + 2, 2, n, HEAT_HOURS)]).build());
  }
  sh.setConditionalFormatRules(rules);

  if (n) {
    var pal = [PAL.blue, PAL.green, PAL.amber, PAL.red, '#9334e6', '#12b5cb', '#e8710a', '#5f6368'];
    var cols = []; for (var k = 0; k < n; k++) cols.push(pal[k % pal.length]);
    var ser = {}; for (var k2 = 0; k2 < n; k2++) ser[k2] = {};
    addChartSafe_(sh, { type: Charts.ChartType.COLUMN, title: 'Time-wise calls by caller',
      ranges: [sh.getRange(H0 + 1, 21, HEAT_HOURS + 1, n + 1)],
      colors: cols, series: ser, hTitle: 'Hour of the day', row: H0 + 2 + n + 2, col: 1 });
  }
  if (isNew) ss_().setActiveSheet(sh);
}

/** One chart. Tries the full professional styling; if Sheets rejects an option, falls back to a plain chart. */
function addChart_(sh, spec, fancy) {
  var b = sh.newChart().setChartType(spec.type);
  spec.ranges.forEach(function (r) { b.addRange(r); });
  b.setNumHeaders(1).setPosition(spec.row, spec.col, 0, 0)
    .setOption('title', spec.title).setOption('width', 480).setOption('height', 330)
    .setOption('colors', spec.colors).setOption('legend', { position: 'bottom' });
  if (fancy) {
    b.setOption('fontName', 'Arial')
      .setOption('titleTextStyle', { color: '#202124', fontSize: 14, bold: true })
      .setOption('backgroundColor', { fill: '#ffffff', stroke: '#dadce0', strokeWidth: 1 })
      .setOption('legend', { position: 'bottom', textStyle: { color: '#5f6368' } })
      .setOption('hAxis', { textStyle: { color: '#5f6368' }, title: spec.hTitle || '', titleTextStyle: { color: '#5f6368', italic: false } })
      .setOption('vAxis', spec.vAxis || { textStyle: { color: '#5f6368' }, gridlines: { color: '#e8eaed' }, minValue: 0 })
      .setOption('bar', { groupWidth: '55%' });
    if (spec.vAxes) b.setOption('vAxes', spec.vAxes);
    if (spec.series) b.setOption('series', spec.series);
  }
  if (spec.stacked) {
    try { b = b.asColumnChart(); b.setStacked(); }       // stacked bars need the column-chart builder
    catch (e) { b.setOption('isStacked', true); }
  }
  sh.insertChart(b.build());
}
function addChartSafe_(sh, spec) {
  try { addChart_(sh, spec, true); } catch (e) { addChart_(sh, spec, false); }
}

function buildDashCharts_(sh, n) {
  function cc(c) { return sh.getRange(4, c, n + 1, 1); }          // caller-block column (header + n rows)
  function tr(c) { return sh.getRange(4, c, 15, 1); }             // trend-block column (header + 14 days)
  var P = cc(16), COL = Charts.ChartType.COLUMN, COMBO = Charts.ChartType.COMBO;
  var lbl = { dataLabel: 'value' };
  var dash = { lineDashStyle: [6, 3], pointSize: 0 };
  var lineAx = { textStyle: { color: '#5f6368' }, gridlines: { color: '#e8eaed' }, minValue: 0 };

  addChartSafe_(sh, { type: COL, title: 'Total calls by caller', ranges: [P, cc(17)], colors: [PAL.blue],
    series: { 0: lbl }, hTitle: 'Caller', row: 6, col: 1 });
  addChartSafe_(sh, { type: COMBO, title: 'Productivity % vs target', ranges: [P, cc(23), cc(24), cc(25)],
    colors: [PAL.blue, PAL.green, PAL.red], hTitle: 'Caller',
    series: { 0: { type: 'bars', dataLabel: 'value' }, 1: { type: 'line', lineDashStyle: [6, 3], pointSize: 0 }, 2: { type: 'line', lineDashStyle: [6, 3], pointSize: 0 } },
    vAxis: { format: '0%', textStyle: { color: '#5f6368' }, gridlines: { color: '#e8eaed' }, minValue: 0 }, row: 6, col: 5 });
  addChartSafe_(sh, { type: COL, title: 'Talk time vs idle time (hours)', ranges: [P, cc(21), cc(22)],
    colors: [PAL.green, PAL.red], series: { 0: lbl, 1: lbl }, hTitle: 'Caller', row: 6, col: 10 });
  addChartSafe_(sh, { type: COL, title: 'Call mix: outgoing / incoming / missed-rejected', ranges: [P, cc(18), cc(19), cc(20)],
    colors: [PAL.blue, PAL.green, PAL.red], stacked: true, hTitle: 'Caller', row: 22, col: 1 });
  addChartSafe_(sh, { type: COMBO, title: 'Idle stretches and longest idle gap', ranges: [P, cc(26), cc(27)],
    colors: [PAL.amber, PAL.red], hTitle: 'Caller',
    series: { 0: { type: 'bars', dataLabel: 'value' }, 1: { type: 'line', targetAxisIndex: 1, pointSize: 6, dataLabel: 'value' } },
    vAxes: { 0: { title: 'No. of times idle', minValue: 0, gridlines: { color: '#e8eaed' } }, 1: { title: 'Longest gap (min)', minValue: 0 } }, row: 22, col: 5 });
  addChartSafe_(sh, { type: COMBO, title: 'Daily trend (last 14 days up to the "to" date)', ranges: [tr(29), tr(30), tr(31)],
    colors: [PAL.blue, PAL.green],
    series: { 0: { type: 'bars' }, 1: { type: 'line', targetAxisIndex: 1, pointSize: 5 } },
    vAxes: { 0: { title: 'Total calls', minValue: 0, gridlines: { color: '#e8eaed' } }, 1: { title: 'Productivity %', format: '0%', minValue: 0 } }, row: 22, col: 10 });
}

/** TEST: fills two sample days for Amanpreet and Ashima, then builds the summary. */
function addTestData() {
  var log = sheet_('Call Log', HEAD_LOG), rows = [], now = Date.now();
  [dayKey(now - 86400000), dayKey(now - 2 * 86400000)].forEach(function (d) {
    var t = genTestCalls(d);
    Object.keys(t).forEach(function (name) {
      t[name].forEach(function (c, i) {
        rows.push([name, d, fmtTimeS(c.start), '98' + (10000000 + i * 7919 % 89999999), c.type, c.dur, 'TEST|' + name + '|' + c.start, c.start]);
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
    .addItem('5. Update Callers tab (shift & breaks)', 'updateCallersTab')
    .addItem('6. Set admin login (ID + password)', 'setAdminLogin')
    .addItem('7. Build / refresh Dashboard tab', 'buildDashboard')
    .addToUi();
}
