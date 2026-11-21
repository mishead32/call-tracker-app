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
  LUNCH_START: '13:10',
  LUNCH_END: '13:50',
  TEA_START: '16:00',     // 20-minute tea break (change here or per caller)
  TEA_END: '16:20',
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
/** "9:00", "09:00", "9:00 AM", "6:00 PM", "18:00:00" -> "HH:MM". Blank -> fallback. "-"/"none" -> null (no such break). */
function parseHM(v, fb) {
  var s = String(v == null ? '' : v).trim().toUpperCase();
  if (!s) return fb;
  if (s === '-' || s === 'NONE' || s === 'NO') return null;
  var m = s.match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(AM|PM)?$/);
  if (!m) return fb;
  var h = +m[1], mi = +m[2];
  if (m[3] === 'PM' && h < 12) h += 12;
  if (m[3] === 'AM' && h === 12) h = 0;
  if (h > 23 || mi > 59) return fb;
  return pad(h) + ':' + pad(mi);
}
/** Callers-tab row (as displayed text) -> shift object. Columns E..J = start, end, lunch from/to, tea from/to. */
function shiftFromRow(r) {
  var breaks = [];
  var ls = parseHM(r[6], CFG.LUNCH_START), le = parseHM(r[7], CFG.LUNCH_END);
  var ts = parseHM(r[8], CFG.TEA_START), te = parseHM(r[9], CFG.TEA_END);
  if (ls && le) breaks.push([ls, le]);
  if (ts && te) breaks.push([ts, te]);
  return {
    start: parseHM(r[4], CFG.SHIFT_START) || CFG.SHIFT_START,
    end: parseHM(r[5], CFG.SHIFT_END) || CFG.SHIFT_END,
    breaks: breaks
  };
}
function defaultShift() {
  return { start: CFG.SHIFT_START, end: CFG.SHIFT_END, breaks: [[CFG.LUNCH_START, CFG.LUNCH_END], [CFG.TEA_START, CFG.TEA_END]] };
}
/** Working segments of a day: shift window minus breaks. */
function buildSegments(key, shift) {
  var base = dayStartMs(key);
  var s = base + hmMs(shift.start), e = base + hmMs(shift.end);
  var cuts = (shift.breaks || []).map(function (b) { return [base + hmMs(b[0]), base + hmMs(b[1])]; })
    .filter(function (b) { return b[1] > b[0]; }).sort(function (a, b) { return a[0] - b[0]; });
  var segs = [], cur = s;
  cuts.forEach(function (b) {
    var bs = Math.max(b[0], s), be = Math.min(b[1], e);
    if (be <= bs) return;
    if (bs > cur) segs.push([cur, bs]);
    cur = Math.max(cur, be);
  });
  if (e > cur) segs.push([cur, e]);
  return segs;
}

/** calls: [{start(ms), dur(sec), type}] for ONE caller on ONE day. nowMs cuts off today's working time. */
function computeDay(calls, key, nowMs, shift) {
  shift = shift || defaultShift();
  var fullSegs = buildSegments(key, shift);
  var busy = calls.filter(function (c) { return c.dur > 0; })
    .map(function (c) { return [c.start, c.start + c.dur * 1000]; })
    .sort(function (a, b) { return a[0] - b[0]; });

  var idleMs = 0, gaps = 0, longest = 0, workMs = 0, talkMs = 0, thr = CFG.IDLE_MIN * 60000;
  function gap(len) {
    if (len >= thr) { idleMs += len; gaps++; if (len > longest) longest = len; }
  }
  fullSegs.forEach(function (seg) {
    var s = seg[0], e = Math.min(seg[1], nowMs);
    if (e <= s) return;
    workMs += e - s;
    var cur = s;
    busy.forEach(function (b) {
      var bs = Math.max(b[0], s), be = Math.min(b[1], e);
      if (be <= bs) return;
      talkMs += be - bs;
      if (bs > cur) gap(bs - cur);
      cur = Math.max(cur, be);
    });
    if (e > cur) gap(e - cur);
  });

  var out = 0, inc = 0, missed = 0, outside = 0, first = null, last = null;
  calls.forEach(function (c) {
    if (c.type === 'OUTGOING') out++;
    else if (c.type === 'INCOMING') inc++;
    else missed++;                                  // MISSED / REJECTED
    var inside = fullSegs.some(function (g) { return c.start >= g[0] && c.start < g[1]; });
    if (!inside) outside++;
    if (first === null || c.start < first) first = c.start;
    var end = c.start + c.dur * 1000;
    if (last === null || end > last) last = end;
  });
  return {
    total: calls.length, out: out, inc: inc, missed: missed, outside: outside,
    first: first, last: last,
    workMs: workMs, talkMs: talkMs, idleMs: idleMs, gaps: gaps, longestMs: longest
  };
}

/** Fake but realistic calls for testing. Amanpreet = busy, Ashima = long idle stretches. */
function genTestCalls(key) {
  var base = dayStartMs(key);
  function t(hhmm) { return base + hmMs(hhmm); }
  var A = [], S = [];
  var tm = t('09:05'), i = 0, lunchS = t(CFG.LUNCH_START), lunchE = t(CFG.LUNCH_END), end = t('17:55');
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
  'Shift start', 'Shift end', 'Lunch from', 'Lunch to', 'Tea from', 'Tea to',
  'App status', 'Last seen', 'LastSeenMs (auto)', 'Call log permission (auto)', 'App version (auto)'];
var HEAD_SUM = ['Date', 'Caller', 'Company', 'Shift timing',
  'Total calls', 'Outgoing calls', 'Incoming calls', 'Missed / Rejected calls', 'Calls outside working hours',
  'Calls per working hour', 'Working time (excl. breaks)', 'Time on calls', 'Productivity %',
  'Idle time (no call for 10+ min)', 'No. of idle stretches', 'Longest idle stretch',
  'First call', 'Last call ended'];
var NOTES_SUM = [
  'Day of the calls.', 'Telecaller name (Callers tab).', 'Company / vertical (Callers tab).',
  'Shift start to shift end for this caller (set in the Callers tab).',
  'All calls in the phone call log that day.', 'Calls the caller dialled.', 'Calls the caller received and answered.',
  'Calls that rang but were not answered, or were declined.',
  'Calls that started before shift start, after shift end, or during lunch/tea break.',
  'Calls made inside working time divided by working hours.',
  'Shift length minus lunch and tea breaks. Today: only up to the current time.',
  'Time actually spent talking on calls, inside working time (hh:mm:ss).',
  'Time on calls divided by working time. Green = good, red = low.',
  'Total time inside working hours with no call for 10 minutes or more.',
  'How many separate times the caller was idle (no call for 10+ minutes).',
  'The single longest period with no call.',
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

/** Adds the shift / break columns to the Callers tab and fills blanks with the default times. Safe to run again. */
function updateCallersTab() {
  var c = ss_().getSheetByName('Callers');
  var n = HEAD_CALLERS.length;
  c.getRange(1, 1, 1, n).setValues([HEAD_CALLERS]).setFontWeight('bold').setBackground('#d9ead3')
    .setWrap(true).setHorizontalAlignment('center');
  c.setFrozenRows(1);
  var last = Math.max(c.getLastRow(), 2);
  c.getRange(2, 5, 200, 6).setNumberFormat('@');                       // keep times as plain text like 09:00
  var vals = c.getRange(2, 1, last - 1, n).getDisplayValues();
  var def = [CFG.SHIFT_START, CFG.SHIFT_END, CFG.LUNCH_START, CFG.LUNCH_END, CFG.TEA_START, CFG.TEA_END];
  var fill = vals.map(function (r) {
    return def.map(function (d, i) { return r[0] && !String(r[4 + i]).trim() ? d : r[4 + i]; });
  });
  c.getRange(2, 5, fill.length, 6).setValues(fill);
  c.getRange(1, 5, 1, 6).setNotes([['Shift start time, e.g. 09:00', 'Shift end time, e.g. 18:00',
    'Lunch break start, e.g. 13:10', 'Lunch break end, e.g. 14:10',
    'Tea break start, e.g. 16:00. Type - if none', 'Tea break end, e.g. 16:20']]);
  c.setColumnWidths(5, 6, 80);
  c.getRange(2, 5, 200, 6).setHorizontalAlignment('center');
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

  var out = [], bg = [], band = 0;
  Object.keys(days).sort().reverse().forEach(function (d) {
    callerRows.forEach(function (cr) {
      var name = String(cr[0]).trim(), shift = shiftFromRow(cr);
      var x = computeDay(groups[d + '|' + name] || [], d, now, shift);
      var hrs = x.workMs / 3600000;
      out.push([prettyDay(d), name, cr[2], shift.start + ' to ' + shift.end,
        x.total, x.out, x.inc, x.missed, x.outside,
        hrs ? Math.round(10 * (x.total - x.outside) / hrs) / 10 : 0,
        fmtHMS(x.workMs), fmtHMS(x.talkMs), x.workMs ? x.talkMs / x.workMs : '',
        fmtHMS(x.idleMs), x.gaps, fmtHMS(x.longestMs),
        x.first ? fmtTimeS(x.first) : '-', x.last ? fmtTimeS(x.last) : '-']);
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
    .addToUi();
}
