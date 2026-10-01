/**
 * HARPER FAMILY HUB — Jon's Apple Reminders, read from his daily snapshot email
 *
 * Apple Reminders has no public API and lives only on Jon's iPhone. An iPhone
 * Shortcuts automation emails a snapshot of ALL his open reminders to himself
 * around 4:40 AM Eastern (subject "REMINDERS SNAPSHOT"). This file reads that
 * email, read-only, with the Gmail API, and keeps the newest snapshot for the Hub.
 *
 * One way only: phone -> Hub. Nothing here writes back to Reminders or to Gmail.
 * Each snapshot is the complete set of open reminders, so it REPLACES the one
 * before it: a reminder missing from the newest snapshot was ticked off or
 * deleted on the phone.
 *
 * The script runs as the account that deployed it (Jon), so there are no
 * credentials or tokens to keep: Google's own consent screen grants the
 * read-only Gmail scope (see appsscript.json). Snapshot bodies are never
 * logged, and the snapshot is stored only in Script Properties (private).
 *
 * SETUP: see README.md next to this file ("Reminders").
 */

// ======================= CONFIG =======================
// "from:me" keeps a stranger from putting reminders on the Hub by mailing the
// same subject line; the Shortcut sends from Jon's own address to itself.
const REMINDERS_QUERY = 'subject:"REMINDERS SNAPSHOT" from:me newer_than:1d';
const REMINDERS_TZ = 'America/New_York';  // the snapshot's own clock
const REMINDERS_LOOK_AT = 10;             // newest messages to read when looking for today's
const REMINDERS_RETRY_MIN = 15;           // a stale Hub re-checks Gmail at most this often
// Script Property REMINDERS_HIDE_LISTS: lists never sent to the Hub, comma
// separated. Work names students, so it stays hidden unless this says otherwise.
const REMINDERS_HIDE_DEFAULT = 'Work';
const REMINDERS_CHUNK = 3000;             // Script Properties hold 9 KB a value, and some characters take 3 bytes
// ======================================================

const REM_META_ = 'REMINDERS_META';
const REM_DATA_ = 'REMINDERS_DATA_';      // + chunk number

// ---------- setup & timers ----------

/** Run once from the editor: asks for the Gmail permission, sets the timers, syncs. */
function setupReminders() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncReminders') ScriptApp.deleteTrigger(t);
  });
  // Shortly after the phone's 4:40 AM email, then hourly to catch manual re-runs.
  ScriptApp.newTrigger('syncReminders').timeBased().atHour(4).nearMinute(45).everyDays(1).create();
  ScriptApp.newTrigger('syncReminders').timeBased().everyHours(1).create();
  const r = syncReminders();
  Logger.log('Reminders: ' + r.status + (r.generatedText ? ' (snapshot ' + r.generatedText + ', ' + r.count + ' open)' : '') +
    (r.message ? ' — ' + r.message : ''));
}

/** Timer entry point. Never throws: a failed check leaves the last good snapshot alone. */
function syncReminders() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { status: 'busy' };
  try {
    return syncReminders_();
  } catch (err) {
    const message = String(err && err.message || err).slice(0, 200); // the error text only, never a snapshot
    saveMeta_({ attemptedAt: Date.now(), error: message });
    return { status: 'error', message: message };
  } finally {
    lock.releaseLock();
  }
}

function syncReminders_() {
  const found = fetchSnapshot_();
  const meta = loadMeta_();
  if (!found) { saveMeta_({ attemptedAt: Date.now(), error: '' }); return { status: 'no_email' }; }
  // Only ever move forward: an older email can't replace a newer snapshot.
  if (meta.generated && found.generated <= meta.generated) {
    saveMeta_({ attemptedAt: Date.now(), error: '' });
    return { status: 'current', generatedText: found.generatedText, count: meta.count };
  }
  storeSnapshot_(found);
  return { status: 'updated', generatedText: found.generatedText, count: found.items.length };
}

// ---------- fetching (Gmail API, read-only) ----------

/**
 * The newest snapshot, by its own GENERATED time. Gmail lists newest first, so
 * the first message generated today is the latest of today; if none was, the
 * newest of what was read is returned and the Hub marks it stale.
 */
function fetchSnapshot_() {
  const list = Gmail.Users.Messages.list('me', { q: REMINDERS_QUERY, maxResults: REMINDERS_LOOK_AT });
  const today = Utilities.formatDate(new Date(), REMINDERS_TZ, 'yyyy-MM-dd');
  let best = null;
  (list.messages || []).some(function (m) {
    const msg = Gmail.Users.Messages.get('me', m.id, { format: 'full' });
    const snap = parseSnapshot_(bodyText_(msg.payload));
    if (!snap) return false;
    if (!best || snap.generated > best.generated) best = snap;
    return snap.generatedDate === today;
  });
  return best;
}

/** The plain-text body of a Gmail message (HTML with the tags stripped if that's all there is). */
function bodyText_(payload) {
  const find = function (part, type) {
    if (!part) return null;
    if (part.mimeType === type && part.body && part.body.data) return part.body.data;
    const kids = part.parts || [];
    for (let i = 0; i < kids.length; i++) {
      const hit = find(kids[i], type);
      if (hit) return hit;
    }
    return null;
  };
  const decode = function (data) {
    return Utilities.newBlob(Utilities.base64DecodeWebSafe(data)).getDataAsString('UTF-8');
  };
  const plain = find(payload, 'text/plain');
  if (plain) return decode(plain);
  const html = find(payload, 'text/html');
  return html ? decode(html).replace(/<br\s*\/?>|<\/(p|div|li|tr)>/gi, '\n').replace(/<[^>]+>/g, '') : '';
}

// ---------- parsing (pure: no Apps Script services, so it can be tested anywhere) ----------

const REM_MONTHS_ = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Greedy title, so the line anchors on its LAST " | due ... | priority " pair and a
// title that contains pipes ("Work | LinkedIn | Alumni") stays whole.
const REM_LINE_ = /^(?<list>[^|]+?) \| (?<title>.*) \| due(?: (?<due>.*?))? \| priority (?<priority>High|Medium|Low|None) \|(?: ?(?<notes>.*))?$/;

/**
 * One snapshot email body -> { generated, generatedDate, generatedText, items, skipped },
 * or null if it has no GENERATED line (not a snapshot).
 *   generated      the snapshot's time, epoch ms (Eastern)
 *   generatedDate  that day, yyyy-MM-dd (Eastern)
 *   items          [{ list, title, due (yyyy-MM-dd or ''), time ('7:30 AM' or ''), dueText, priority, notes, key }]
 *                  (dueText keeps a due the parser couldn't read, so nothing is silently lost)
 *   skipped        lines that matched neither the format nor NONE (counted, never logged)
 */
function parseSnapshot_(body) {
  // Newer iOS puts a narrow no-break space before AM/PM; treat every space alike.
  const lines = String(body || '').replace(/[\u00a0\u202f\u2009]/g, ' ').split(/\r?\n/)
    .map(function (l) { return l.trim(); }).filter(Boolean);
  const head = lines.length && lines[0].match(/^GENERATED:\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!head) return null;
  const year = Number(head[3]) < 100 ? 2000 + Number(head[3]) : Number(head[3]);
  const at = easternMs_(year, Number(head[1]), Number(head[2]), hour24_(Number(head[4]), head[6]), Number(head[5]));

  const items = [], seen = {};
  let skipped = 0;
  lines.slice(1).forEach(function (line) {
    if (line === 'NONE') return;
    const m = line.match(REM_LINE_);
    if (!m) { skipped++; return; }
    const g = m.groups;
    const due = parseDue_(g.due);
    // Titles repeat (several "Counters"), so identity is list + title + due + which one of those it is.
    const item = {
      list: g.list.trim(), title: g.title.trim(),
      due: due.date, time: due.time, dueText: due.date ? '' : (g.due || '').trim(),
      priority: g.priority, notes: (g.notes || '').trim(),
    };
    item.key = itemKey_(item, seen);
    items.push(item);
  });
  return {
    generated: at,
    generatedDate: ymd_(year, Number(head[1]), Number(head[2])),
    generatedText: lines[0].replace(/^GENERATED:\s*/i, ''),
    items: items, skipped: skipped,
  };
}

/** "Oct 2, 2026 at 7:30 AM" -> { date: '2026-10-02', time: '7:30 AM' }. 12:00 AM means no time. */
function parseDue_(text) {
  const none = { date: '', time: '' };
  const m = String(text || '').trim().match(/^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})(?: at (\d{1,2}):(\d{2}) ?([AP]M))?$/i);
  if (!m) return none;
  const mo = REM_MONTHS_.indexOf(m[1].slice(0, 3).toLowerCase());
  if (mo < 0) return none;
  const midnight = !m[4] || (Number(m[4]) === 12 && m[5] === '00' && m[6].toUpperCase() === 'AM');
  return {
    date: ymd_(Number(m[3]), mo + 1, Number(m[2])),
    time: midnight ? '' : Number(m[4]) + ':' + m[5] + ' ' + m[6].toUpperCase(),
  };
}

/** list + title + due + which of those it is in the file; titles repeat, so a title alone never identifies one. */
function itemKey_(r, seen) {
  const base = [r.list, r.title, r.due, r.time, r.dueText].join('|');
  seen[base] = (seen[base] || 0) + 1;
  return base + '|' + seen[base];
}
function hour24_(h, ampm) { return (h % 12) + (/^p/i.test(ampm) ? 12 : 0); }
function ymd_(y, m, d) { return y + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d; }

/** A US Eastern wall-clock time as epoch ms (EDT from the 2nd Sunday of March to the 1st Sunday of November, 2:00 AM). */
function easternMs_(y, mo, d, h, mi) {
  const nthSunday = function (month, n) {
    const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + (n - 1) * 7;
  };
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const dstStart = Date.UTC(y, 2, nthSunday(3, 2), 2, 0);
  const dstEnd = Date.UTC(y, 10, nthSunday(11, 1), 2, 0);
  return wall + (wall >= dstStart && wall < dstEnd ? 4 : 5) * 3600000;
}

// ---------- keeping the snapshot ----------

function storeSnapshot_(snap) {
  const props = PropertiesService.getScriptProperties();
  const packed = JSON.stringify(snap.items.map(function (r) {
    return [r.list, r.title, r.due, r.time, r.priority, r.notes, r.dueText];
  }));
  const chunks = {};
  let n = 0;
  for (let i = 0; i < packed.length; i += REMINDERS_CHUNK) chunks[REM_DATA_ + (n++)] = packed.slice(i, i + REMINDERS_CHUNK);
  const old = loadMeta_().chunks || 0;
  const meta = {
    generated: snap.generated, generatedDate: snap.generatedDate, generatedText: snap.generatedText,
    count: snap.items.length, skipped: snap.skipped, chunks: n,
    syncedAt: Date.now(), attemptedAt: Date.now(), error: '',
  };
  chunks[REM_META_] = JSON.stringify(meta);
  props.setProperties(chunks, false);
  for (let i = n; i < old; i++) props.deleteProperty(REM_DATA_ + i);
}

function loadMeta_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(REM_META_) || '{}'); }
  catch (err) { return {}; }
}

function saveMeta_(patch) {
  const meta = loadMeta_();
  Object.keys(patch).forEach(function (k) { meta[k] = patch[k]; });
  PropertiesService.getScriptProperties().setProperty(REM_META_, JSON.stringify(meta));
}

function loadItems_(meta) {
  const props = PropertiesService.getScriptProperties();
  let packed = '';
  for (let i = 0; i < (meta.chunks || 0); i++) packed += props.getProperty(REM_DATA_ + i) || '';
  let rows = [];
  try { rows = packed ? JSON.parse(packed) : []; } catch (err) { rows = []; }
  const seen = {};
  return rows.map(function (r) {
    const item = { list: r[0], title: r[1], due: r[2], time: r[3], priority: r[4], notes: r[5], dueText: r[6] };
    item.key = itemKey_(item, seen);
    return item;
  });
}

// ---------- what the Hub is sent ----------

/**
 * The Hub's view of the snapshot. Lists named in REMINDERS_HIDE_LISTS are left
 * out here, so a hidden list never reaches any phone. `stale` means the newest
 * snapshot was not generated today (Eastern): the Hub keeps showing it, labelled
 * with its own time, and never calls it current.
 */
function getReminders_() {
  let meta = loadMeta_();
  const today = Utilities.formatDate(new Date(), REMINDERS_TZ, 'yyyy-MM-dd');
  // Behind on today's snapshot and the timers haven't looked lately: look now.
  if (meta.generatedDate !== today && Date.now() - (meta.attemptedAt || 0) > REMINDERS_RETRY_MIN * 60000) {
    syncReminders();
    meta = loadMeta_();
  }
  if (!meta.generated) return { status: meta.error ? 'error' : 'none', items: [], lists: [] };

  const hide = String(prop_('REMINDERS_HIDE_LISTS') == null ? REMINDERS_HIDE_DEFAULT : prop_('REMINDERS_HIDE_LISTS'))
    .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  const items = loadItems_(meta).filter(function (r) { return hide.indexOf(r.list.toLowerCase()) < 0; });
  const lists = [];
  items.forEach(function (r) { if (lists.indexOf(r.list) < 0) lists.push(r.list); });
  return {
    status: meta.generatedDate === today ? 'fresh' : 'stale',
    generated: meta.generated, generatedText: meta.generatedText,
    syncedAt: meta.syncedAt || 0, error: meta.error || '',
    lists: lists, items: items,
  };
}
