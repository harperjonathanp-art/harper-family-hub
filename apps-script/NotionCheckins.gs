/**
 * HARPER FAMILY HUB — check-ins copied to Notion
 *
 * When NOTION_TOKEN and NOTION_CHECKINS_SOURCE are set in Script Properties,
 * every check-in saved in the Hub (Family Huddle and Jon & Maggie) gets a page
 * in the Weekly Check-Ins database in Notion: each question as a heading, the
 * answer under it. A timer copies new ones over; its first run copies every
 * check-in already in the Sheet.
 *
 * One way only: Hub -> Notion. The CheckIns tab stays the Hub's own record.
 * A check-in deleted in the Hub goes to Notion's trash at the next sync. One
 * deleted only in Notion comes back, since the Sheet still has it. Pages are
 * never changed once made, so anything added to them in Notion stays.
 *
 * Which pages the Hub made is read from Notion itself (the Hub ID property),
 * so nothing is kept here to track them.
 *
 * Uses notion_() and plainText_() from Notion.gs.
 * SETUP: see README.md next to this file ("Check-ins to Notion").
 */

// ======================= CONFIG =======================
const CHECKINS_SYNC_MIN = 30;   // how often the timer copies new check-ins (Apps Script allows 1, 5, 10, 15 or 30)
const CHECKINS_PER_RUN = 25;    // pages made per run; a longer backlog finishes over the next runs
// The Weekly Check-Ins database's property names, as they read in Notion.
const CHECKINS_PROPS = { name: 'Name', date: 'Date', type: 'Type', id: 'Hub ID' };
// The Type select's options, as the Hub labels each kind.
const CHECKINS_TYPE = { huddle: 'Family Huddle', couples: 'Jon & Maggie' };
// The questions as the Hub words them: HUDDLE_FIELDS and COUPLES_QUESTIONS in
// index.html. Change them there and here together. An answer whose question
// isn't listed here is still copied, under its key.
const CHECKINS_QUESTIONS = {
  huddle: [
    ['rose', 'Rose / Thorn / Bud'],
    ['week', 'Week ahead'],
    ['chores', 'Home team check'],
    ['fun', 'Fun pick'],
    ['grat', 'Gratitude & prayer'],
  ],
  couples: [
    ['q0', 'What are you grateful for and appreciate about me this week?'],
    ['q1', 'What brought you joy this week?'],
    ['q2', 'What is something that was hard this week?'],
    ['q3', 'What is one thing I can do for you this week?'],
    ['q4', 'Is there any unconfessed sin, conflict, or hurt that we need to resolve and/or seek forgiveness for?'],
    ['q5', 'What is a dream, craving, or desire that has been on the forefront of your mind?'],
    ['q6', 'How can I pray for you this week?'],
  ],
};
// ======================================================

const CHECKINS_TEXT_MAX_ = 2000; // Notion's limit on one piece of text

/** Whether check-ins are copied to Notion. */
function notionCheckinsOn_() {
  return !!(prop_('NOTION_TOKEN') && prop_('NOTION_CHECKINS_SOURCE'));
}

// ---------- setup & timer ----------

/** Run once from the editor: sets the timer and copies what's there. */
function setupNotionCheckins() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncNotionCheckins') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncNotionCheckins').timeBased().everyMinutes(CHECKINS_SYNC_MIN).create();
  const r = syncNotionCheckins();
  Logger.log('Check-ins to Notion: ' + r.status + (r.message ? ' — ' + r.message : ''));
}

/** Timer entry point. Never throws: what fails is tried again next run. */
function syncNotionCheckins() {
  if (!notionCheckinsOn_()) return { status: 'off', message: 'add NOTION_TOKEN and NOTION_CHECKINS_SOURCE in Script Properties' };
  // Not the script lock: Notion is slow, and the Hub's saves wait on that one.
  // This only keeps two runs from copying the same check-in twice.
  const lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) return { status: 'busy' };
  try {
    const checkins = getCheckins_(Infinity).reverse(); // oldest first, so a backlog fills in date order
    const pages = checkinPages_();
    const errors = [];
    let made = 0, trashed = 0, left = 0;

    checkins.forEach(function (c) {
      if (pages[c.id]) return;
      if (made >= CHECKINS_PER_RUN) { left++; return; }
      try {
        notion_('post', '/pages', checkinPage_(c));
        made++;
        Utilities.sleep(350); // Notion allows about three requests a second
      } catch (err) {
        errors.push(c.date + ' ' + c.type + ': ' + String(err && err.message || err));
      }
    });

    // An empty CheckIns tab more likely means a renamed tab than a cleared one:
    // leave Notion alone rather than trash every page.
    if (checkins.length) {
      const inSheet = {};
      checkins.forEach(function (c) { inSheet[c.id] = true; });
      Object.keys(pages).forEach(function (id) {
        if (inSheet[id]) return;
        pages[id].forEach(function (pageId) {
          try {
            notion_('patch', '/pages/' + pageId, { in_trash: true });
            trashed++;
            Utilities.sleep(350);
          } catch (err) {
            errors.push('trashing ' + id + ': ' + String(err && err.message || err));
          }
        });
      });
    }

    const counts = made + ' copied, ' + trashed + ' trashed' + (left ? ', ' + left + ' left for the next run' : '');
    if (errors.length) return { status: 'error', message: counts + '. ' + errors.join(' / ').slice(0, 300) };
    return { status: made || trashed ? 'updated' : 'current', message: counts };
  } catch (err) {
    return { status: 'error', message: String(err && err.message || err).slice(0, 200) };
  } finally {
    lock.releaseLock();
  }
}

// ---------- talking to Notion ----------

/** The pages the Hub has made, by check-in id: { id: [pageId, …] }. */
function checkinPages_() {
  const P = CHECKINS_PROPS;
  const byId = {};
  let cursor = null;
  do {
    const body = { filter: { property: P.id, rich_text: { is_not_empty: true } }, page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = notion_('post', '/data_sources/' + prop_('NOTION_CHECKINS_SOURCE') + '/query', body);
    (res.results || []).forEach(function (page) {
      const p = page.properties || {};
      const id = plainText_(p[P.id] && p[P.id].rich_text);
      if (id) (byId[id] = byId[id] || []).push(page.id);
    });
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return byId;
}

/** A check-in as a new page: "Family Huddle · Oct 11, 2026", then each question and its answer. */
function checkinPage_(c) {
  const P = CHECKINS_PROPS;
  const type = c.type === 'couples' ? 'couples' : 'huddle';
  const label = CHECKINS_TYPE[type];
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(c.date);
  const shown = isDate ? Utilities.formatDate(new Date(c.date + 'T12:00:00Z'), 'UTC', 'MMM d, yyyy') : c.date;

  const props = {};
  props[P.name] = { title: richText_(label + (shown ? ' · ' + shown : '')) };
  props[P.type] = { select: { name: label } };
  props[P.id] = { rich_text: richText_(c.id) };
  if (isDate) props[P.date] = { date: { start: c.date } };

  const answers = c.answers || {};
  const questions = CHECKINS_QUESTIONS[type];
  const known = questions.map(function (q) { return q[0]; });
  const extra = Object.keys(answers).filter(function (k) { return known.indexOf(k) < 0; });
  const children = [];
  questions.concat(extra.map(function (k) { return [k, k]; })).forEach(function (q) {
    const answer = String(answers[q[0]] == null ? '' : answers[q[0]]).trim();
    children.push({ type: 'heading_3', heading_3: { rich_text: richText_(q[1]) } });
    children.push({ type: 'paragraph', paragraph: { rich_text: answer
      ? richText_(answer)
      : [{ type: 'text', text: { content: 'No answer' }, annotations: { italic: true, color: 'gray' } }] } });
  });

  return {
    parent: { type: 'data_source_id', data_source_id: prop_('NOTION_CHECKINS_SOURCE') },
    properties: props,
    children: children,
  };
}

/** Text as Notion takes it, in pieces short enough for its limit. */
function richText_(s) {
  const out = [];
  for (let i = 0; i < s.length; i += CHECKINS_TEXT_MAX_) {
    out.push({ type: 'text', text: { content: s.slice(i, i + CHECKINS_TEXT_MAX_) } });
  }
  return out;
}
