// The Tasks screen: rows, repeats, Jon's Todoist tasks, adding, editing and dragging.
"use strict";

/* A task and its subtasks, folded under it like Jon's reminders. (Not taskRow(t, i): it's used with .map.) */
function taskRow(t) {
  const subs = isSub(t) ? [] : subsOf(t.id).sort(subOrder);
  if (!subs.length) return taskLine(t, false, false);
  const id = esc(t.id), left = subs.filter(x => !x.completed).length;
  const label = left === subs.length ? `${left} subtask${left === 1 ? "" : "s"}` : left ? `${left} of ${subs.length} subtasks left` : "All subtasks done";
  return taskLine(t, false, true) + `<details class="subs tsubs" data-for="${id}" ontoggle="foldTask(this.dataset.for, !this.open)" ${FOLDED.has(t.id) ? "" : "open"}>
    <summary>${label}</summary>${subs.map(s => taskLine(s, true, false)).join("")}</details>`;
}
/* Folded tasks, remembered on this device. Open is the default, as in Reminders. */
const FOLDED = new Set((() => { try { return JSON.parse(localStorage.getItem("fd_task_folded") || "[]"); } catch (e) { return []; } })());
function foldTask(id, folded) {
  if (FOLDED.has(id) === folded) return;
  folded ? FOLDED.add(id) : FOLDED.delete(id);
  // forget tasks that are gone, so the list doesn't grow forever
  [...FOLDED].forEach(x => { if (!taskById(x)) FOLDED.delete(x); });
  try { localStorage.setItem("fd_task_folded", JSON.stringify([...FOLDED])); } catch (e) {}
}
function taskLine(t, sub, hasSubs) {
  const id = esc(t.id);
  // Dragging lives on the Tasks screen, where the rows sit in order.
  const grip = VIEW !== "tasks" ? ""
    : t.completed || String(t.id).startsWith("tmp-") ? `<span class="grip-space"></span>`
    : `<button class="grip" data-tgrip="${id}" aria-label="Move ${esc(t.title)} (arrow keys; right makes it a subtask, left takes it out)"
        onpointerdown="tdStart(event, '${id}')" onpointermove="tdMove(event)"
        onpointerup="tdEnd(false)" onpointercancel="tdEnd(true)" onkeydown="tdKey(event, '${id}')">${GRIP_SVG}</button>`;
  return `<div class="task ${t.completed ? "done" : ""} ${sub ? "sub" : ""} ${hasSubs ? "has-subs" : ""}" data-tid="${id}" ${sub ? `data-parent="${esc(t.parentId)}"` : ""}>
    ${grip}
    <input type="checkbox" ${t.completed ? "checked" : ""} onchange="toggleTask('${id}')" aria-label="${esc(t.title)}">
    ${chip(t.assignee)}
    <button type="button" class="ttl tedit" onclick="openTaskEdit('${id}')" aria-label="Edit ${esc(t.title)}">${esc(t.title)}${t.completed && t.completedBy ? ` <span class="tiny">by ${esc(t.completedBy)}</span>` : ""}${taskMeta(t)}</button>
    <button class="del" onclick="deleteTask('${id}')" aria-label="Delete">×</button>
  </div>`;
}

/* ---------- due dates and Apple Reminders-style repeats ----------
   A repeat is stored as text the server also reads: "every 2 weeks",
   "every 1 week on sun,tue,thu", "every 3 months on 3rd sat". */
const WD = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WD_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const NTH = { "1st": 1, first: 1, "2nd": 2, second: 2, "3rd": 3, third: 3, "4th": 4, fourth: 4, "5th": 5, fifth: 5, last: -1 };
const NTH_WORD = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", "-1": "last" };
const NTH_CODE = { 1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 5: "5th", "-1": "last" };

function parseRepeat(text) {
  const m = String(text || "").trim().toLowerCase().match(/^every\s+(\d+)\s+(day|week|month|year)s?(?:\s+on\s+(.+))?$/);
  if (!m) return null;
  const r = { n: Math.max(1, Number(m[1])), unit: m[2] };
  if (r.unit === "week" && m[3]) {
    const days = m[3].split(/[\s,]+/).filter(Boolean).map(d => WD.indexOf(d.slice(0, 3)));
    if (!days.length || days.includes(-1)) return null; // same rule as the server
    r.days = [...new Set(days)].sort();
  }
  if (r.unit !== "week" && r.unit !== "day" && m[3]) {
    const p = m[3].match(/^(\w+)\s+(\w{3})/);
    if (p && p[1] in NTH && WD.includes(p[2])) r.nth = { k: NTH[p[1]], wd: WD.indexOf(p[2]) };
  }
  return r;
}
/* Worded like Apple Reminders: "Weekly", "Every 2 weeks", "Every 3 months on the third Saturday". */
function describeRepeat(text, due) {
  const r = parseRepeat(text);
  if (!r) return text;
  const plural = { day: "days", week: "weeks", month: "months", year: "years" }[r.unit];
  const base = r.n === 1 ? { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" }[r.unit] : `Every ${r.n} ${plural}`;
  if (r.unit === "week" && r.days && r.days.length) {
    if (r.n === 1 && r.days.join() === "1,2,3,4,5") return "Every weekday";
    return `${base} on ${r.days.map(d => WD_LONG[d].slice(0, 3)).join(", ")}`;
  }
  if (r.nth) {
    const on = `the ${NTH_WORD[r.nth.k]} ${WD_LONG[r.nth.wd]}`;
    if (r.unit === "year") {
      const month = due ? new Date(due + "T12:00:00").toLocaleDateString("en-US", { month: "long" }) : "";
      return `${r.n === 1 ? "Every year" : base} on ${on}${month ? " of " + month : ""}`;
    }
    return `${base} on ${on}`;
  }
  return base;
}
function dueInfo(due) {
  if (!due) return null;
  const d = new Date(due + "T12:00:00"), t = new Date(todayStr() + "T12:00:00");
  const days = Math.round((d - t) / 86400000);
  const text = days === 0 ? "Today" : days === 1 ? "Tomorrow" : days === -1 ? "Yesterday"
    : days > 1 && days < 7 ? d.toLocaleDateString("en-US", { weekday: "long" })
    : d.toLocaleDateString("en-US", d.getFullYear() === t.getFullYear() ? { month: "numeric", day: "numeric" } : { month: "numeric", day: "numeric", year: "2-digit" });
  return { text, days };
}
function taskMeta(t) {
  const due = dueInfo(t.due), parts = [];
  if (due) {
    const late = isLate(t);
    // a repeating task ticked today has already moved on to its next date
    const text = (t.completed && t.repeat ? "Next: " : "") + due.text + (t.time ? " · " + fmtTime(t.time) : "");
    parts.push(`<span class="${late ? "overdue" : ""}">${esc(text)}${late ? " · overdue" : ""}</span>`);
  }
  if (t.repeat) parts.push(`<span>↻ ${esc(describeRepeat(t.repeat, t.due))}</span>`);
  if (t.badRepeat) parts.push(`<span class="overdue">Can't read the repeat "${esc(t.badRepeat)}" — fix it in the Sheet</span>`);
  return parts.length ? `<span class="meta">${parts.join(" &nbsp;")}</span>` : "";
}
function isDailyRepeat(t) {
  const r = t.repeat && parseRepeat(t.repeat);
  return !!r && r.unit === "day" && r.n === 1;
}
/* ---------- due times, subtasks and order ---------- */
function fmtTime(t) {
  const m = /^(\d{2}):(\d{2})$/.exec(t || "");
  if (!m) return "";
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}
function timeMin(t) { const m = /^(\d{2}):(\d{2})$/.exec(t || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : -1; }
function nowHM() { const d = new Date(); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
/* Late: a day gone by, or today's time gone by. A task with no time is late only after its day. */
function isLate(t) {
  if (!t.due || t.completed) return false;
  const today = todayStr();
  return t.due < today || (t.due === today && !!t.time && t.time < nowHM());
}
const taskById = id => DATA.tasks.find(t => t.id === id);
const isSub = t => !!t.parentId && !!taskById(t.parentId); // a subtask whose parent is gone stands as a task of its own
const subsOf = id => DATA.tasks.filter(t => t.parentId === id);
const tops = () => DATA.tasks.filter(t => !isSub(t));
const sortKey = t => t.sort == null ? 1e9 : t.sort;
/* Subtasks: open ones first, then the order they were put in. */
const subOrder = (a, b) => !!a.completed - !!b.completed || sortKey(a) - sortKey(b);
/* Tasks by day, then time (no time first, like an all-day event), then the order set by dragging. */
const cmpTask = (a, b) => (a.due || "9").localeCompare(b.due || "9") || (a.time || "").localeCompare(b.time || "") ||
  sortKey(a) - sortKey(b) || String(a.title).localeCompare(String(b.title));
const byDue = cmpTask;

/* ----- Tasks ----- */
const REPEAT_PRESETS = [
  ["", "Doesn't repeat"], ["every 1 day", "Daily"], ["every 1 week on mon,tue,wed,thu,fri", "Every weekday"],
  ["every 1 week", "Weekly"], ["every 2 weeks", "Every 2 weeks"], ["every 1 month", "Monthly"],
  ["every 3 months", "Every 3 months"], ["every 6 months", "Every 6 months"], ["every 1 year", "Yearly"], ["custom", "Custom…"],
];
/* The repeat picker, shared by the add form (ids "new…") and the edit screen ("ed…"). */
function repeatSelect(p) {
  return `<select id="${p}Repeat" aria-label="Repeat" onchange="repeatUI('${p}')">${REPEAT_PRESETS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>`;
}
function repeatCustom(p) {
  return `<div class="addrow hidden" id="${p}Custom">
      <span class="muted">Every</span>
      <input type="number" id="${p}RepN" min="1" max="99" value="1" aria-label="How many" oninput="repeatUI('${p}')">
      <select id="${p}RepUnit" aria-label="Days, weeks, months or years" onchange="repeatUI('${p}')">
        <option value="day">day(s)</option><option value="week" selected>week(s)</option>
        <option value="month">month(s)</option><option value="year">year(s)</option></select>
      <div class="daypick" id="${p}RepDays">${WD.map((d, i) => `<label><input type="checkbox" value="${d}" onchange="this.closest('.daypick').dataset.touched = 1; repeatUI('${p}')"><span aria-label="${WD_LONG[i]}">${WD_LONG[i][0]}</span></label>`).join("")}</div>
      <select id="${p}RepOn" aria-label="Which day of the month" onchange="repeatUI('${p}')"></select>
    </div>`;
}
/* Top-level tasks a task could go under: open ones (and its own parent, even if ticked), not itself, not one still saving. */
function parentOptions(selected, except) {
  return `<option value="">Not a subtask</option>` + tops().filter(x => x.id !== except && (!x.completed || x.id === selected) && !String(x.id).startsWith("tmp-"))
    .sort(cmpTask).map(x => `<option value="${esc(x.id)}" ${x.id === selected ? "selected" : ""}>${esc(x.title)}</option>`).join("");
}
function renderTasks() {
  const options = FAMILY.map(f => `<option>${f}</option>`).join("");
  let h = `<div class="addform">
    <input type="text" id="newTitle" placeholder="New task…">
    <div class="addrow">
      <input type="date" id="newDue" aria-label="Due date" onchange="repeatUI()">
      <input type="time" id="newTime" aria-label="Due time" onchange="repeatUI()">
    </div>
    <div class="addrow">
      <select id="newWho" aria-label="Who">${options}</select>
      ${repeatSelect("new")}
    </div>
    <div class="addrow">
      <select id="newParent" aria-label="Subtask of">${parentOptions("", "")}</select>
    </div>
    ${repeatCustom("new")}
    <div class="addrow">
      <span class="tiny grow" id="newRepeatText"></span>
      <button class="primary" onclick="addTask()">Add</button>
    </div>
  </div>`;
  // Dated tasks, like Apple Reminders: overdue, today, the coming week, then later.
  // Subtasks go with their parents, so only top-level tasks sort into sections.
  const today = todayStr(), week = isoPlus(today, 7), shown = new Set();
  const dated = tops().filter(x => x.due);
  const take = list => { list.forEach(x => shown.add(x.id)); return list.sort(byDue); };
  const overdue = take(dated.filter(x => x.due < today && !x.completed));
  const todays = take(dated.filter(x => !shown.has(x.id) && (x.due === today || (x.repeat && x.completed))));
  const soon = take(dated.filter(x => !shown.has(x.id) && x.due > today && x.due <= week));
  const later = take(dated.filter(x => !shown.has(x.id) && x.due > week));
  // Jon's reminders sort into the same sections by their due date.
  const rems = reminderTops(), rDated = rems.filter(r => r.due);
  const rOver = rDated.filter(r => r.due < today), rToday = rDated.filter(r => r.due === today);
  const rSoon = rDated.filter(r => r.due > today && r.due <= week), rLater = rDated.filter(r => r.due > week);
  const open = (ts, rs) => ts.filter(x => !x.completed).length + rs.filter(r => !r.ticked).length;
  h += remStale();
  if (overdue.length || rOver.length) h += `<h2>Overdue<span class="hint">${open(overdue, rOver)}</span></h2><div class="block">${mixRows(overdue, rOver).join("")}</div>`;
  if (todays.length || rToday.length) h += `<h2>Today</h2><div class="block">${mixRows(todays, rToday).join("")}</div>`;
  if (soon.length || rSoon.length) h += `<h2>Next 7 days</h2><div class="block">${mixRows(soon, rSoon).join("")}</div>`;
  const nLater = later.length + rLater.length;
  if (nLater) h += `<details class="later" data-sec="later" ontoggle="secToggle(this)" ${REM.open.has("later") ? "open" : ""}><summary>Later · ${nLater} task${nLater > 1 ? "s" : ""}</summary><div class="block">${mixRows(later, rLater).join("")}</div></details>`;
  RECURS.forEach(r => {
    const group = tops().filter(t => t.recurrence === r && !shown.has(t.id)).sort(cmpTask);
    if (!group.length) return;
    const hint = { once: "", daily: " · resets every day", weekly: " · resets Mondays", monthly: " · resets on the 1st", quarterly: " · resets each quarter", yearly: " · resets Jan 1" }[r];
    h += `<h2>${RECUR_LABEL[r]}${hint ? `<span class="hint">${hint}</span>` : ""}</h2>
      <div class="block">${group.map(taskRow).join("")}</div>`;
  });
  h += renderUndatedReminders(rems.filter(r => !r.due));
  if (!DATA.tasks.length && !rems.length) h += `<div class="block"><div class="empty">No tasks yet — add the first one above.</div></div>`;
  return h + remFresh();
}
/* ----- Jon's Todoist tasks -----
   Read-only. The backend reads Jon's open Todoist tasks every few minutes and
   keeps the last good copy, so a task done in Todoist leaves here at the next
   read. Nothing here goes back to Todoist. Rows are keyed by Todoist's task ID
   and never merged or deduplicated: titles repeat. */
const REM = {
  get show() { const v = localStorage.getItem("fd_rem_show"); return v == null ? ["Jon", "Maggie"].includes(cfg.user) : v === "1"; },
  get hidden() { try { return JSON.parse(localStorage.getItem("fd_rem_hidden") || "[]"); } catch (e) { return []; } },
  open: new Set(), // lists the reader has expanded, so a refresh doesn't fold them
  subOpen: new Map(), // parent key -> whether its subtasks are showing, once the reader has chosen
};
function reminderItems() {
  const rm = DATA.reminders;
  return rm && Array.isArray(rm.items) ? rm.items.filter(r => !REM.hidden.includes(r.list)) : [];
}
/* Tasks as the views place them: each subtask folds under its top-level task
   (by Todoist's parent ID, never by title), so only top-level tasks sort into
   the date sections. A subtask of a subtask goes in the same fold, saying which
   one it's under. One whose parent isn't here stays a row of its own. */
function reminderTops() {
  const all = reminderItems(), byKey = new Map(all.map(r => [r.key, r]));
  const topOf = r => { const seen = new Set(); while (r.parentKey && byKey.has(r.parentKey) && !seen.has(r.key)) { seen.add(r.key); r = byKey.get(r.parentKey); } return r; };
  const tops = new Map();
  all.forEach(r => { if (topOf(r) === r) tops.set(r.key, { ...r, subs: [] }); });
  all.forEach(r => {
    const top = topOf(r), into = top !== r && tops.get(top.key);
    if (into) into.subs.push(r.parentKey === top.key ? r : { ...r, under: byKey.get(r.parentKey).title });
    else if (top !== r) tops.set(r.key, { ...r, subs: [] }); // a broken parent link: show it on its own
  });
  return [...tops.values()];
}
function remMinutes(t) {
  const m = /^(\d+):(\d+) ([AP]M)$/.exec(t || "");
  return m ? (Number(m[1]) % 12 + (m[3] === "PM" ? 12 : 0)) * 60 + Number(m[2]) : -1;
}
const byRemDue = (a, b) => a.due.localeCompare(b.due) || remMinutes(a.time) - remMinutes(b.time);
function remStamp(rm) {
  // `generated`: what a backend from before Todoist sends
  return new Date(rm.syncedAt || rm.generated).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
/* Says how fresh the list is. An old copy is shown, but never as current. */
function remStatus(rm) {
  if (rm.status === "stale") return `<div class="tiny" style="color:var(--warn);margin:var(--space-2) 0">Couldn't reach Todoist — showing Jon's tasks as of ${esc(remStamp(rm))}.</div>`;
  if (rm.status === "fresh") return `<div class="tiny" style="margin:var(--space-2) 0">From Jon's Todoist, ${esc(remStamp(rm))}.</div>`;
  return "";
}
function remEmpty(rm) {
  if (rm.status === "none") return `<div class="empty">Nothing synced from Todoist yet.</div>`;
  if (rm.status === "error") return `<div class="empty">Couldn't read Jon's Todoist. Check TODOIST_TOKEN on the Hub's Worker.</div>`;
  return "";
}
function reminderRow(r, asSub) {
  const due = dueInfo(r.due), parts = [];
  if (!asSub) parts.push(`<span>${esc(r.list)}${r.section ? " · " + esc(r.section) : ""}</span>`);
  if (asSub && r.under) parts.push(`<span>Under ${esc(r.under)}</span>`);
  if (r.parentKey && !asSub) parts.push(`<span>Subtask of ${esc(r.parent || "a task not shown")}</span>`);
  if (due) {
    const late = due.days < 0 && !r.ticked;
    parts.push(`<span class="${late ? "overdue" : ""}">${esc(due.text)}${r.time ? " · " + esc(r.time) : ""}${late ? " · overdue" : ""}</span>`);
  } else if (r.dueText) parts.push(`<span>${esc(r.dueText)}</span>`);
  if (r.recurring) parts.push(`<span>↻ ${esc(r.repeat || "repeats")}</span>`);
  if (r.priority && r.priority !== "P4") parts.push(`<span>${esc(r.priority)}</span>`);
  if (r.notes) parts.push(`<span>${esc(r.notes.length > 120 ? r.notes.slice(0, 117) + "…" : r.notes)}</span>`);
  if (r.ticked) parts.push(`<span>Ticked here${r.tickedBy ? " by " + esc(r.tickedBy) : ""} — tick it in Todoist too</span>`);
  const subs = !asSub && r.subs && r.subs.length ? r.subs : null;
  const row = `<div class="task ${r.ticked ? "done" : ""} ${subs ? "has-subs" : ""}">
    <input type="checkbox" ${r.ticked ? "checked" : ""} data-key="${esc(r.key)}" onchange="tickReminder(this.dataset.key, this.checked)" aria-label="${esc(r.title)}">
    ${asSub ? "" : chip("Jon")}
    <span class="ttl">${esc(r.title)}${parts.length ? `<span class="meta">${parts.join(" &nbsp;")}</span>` : ""}</span></div>`;
  if (!subs) return row;
  // Subtasks fold under their parent. Open by default once the parent is due.
  const left = subs.filter(x => !x.ticked).length;
  const open = REM.subOpen.has(r.key) ? REM.subOpen.get(r.key) : !!(r.due && r.due <= todayStr());
  const label = left === subs.length ? `${left} subtask${left === 1 ? "" : "s"}` : left ? `${left} of ${subs.length} subtasks left` : "All subtasks ticked";
  return row + `<details class="subs" data-key="${esc(r.key)}" ontoggle="REM.subOpen.set(this.dataset.key, this.open)" ${open ? "open" : ""}>
    <summary>${label}</summary>${subs.slice().sort(openFirst).map(x => reminderRow(x, true)).join("")}</details>`;
}
/* Just for fun: a tick here marks a task on every device, but nothing goes to
   Todoist. The tick lasts until the task is done in Todoist or its due date
   moves (a repeating task's next turn), then it's dropped. */
async function tickReminder(key, on) {
  const r = reminderItems().find(x => x.key === key);
  if (!r) return;
  r.ticked = on; r.tickedBy = on ? cfg.user : "";
  localStorage.setItem("fd_cache", JSON.stringify(DATA));
  if (on) FLASH = key; // redrawn at once, so its tick pops on the new row
  LAST_TICK = on ? "rem:" + key : null;
  render();
  note("Saving…");
  try {
    const d = await apiPost({ action: "tickReminder", key, on, by: cfg.user });
    note(d.ok ? "Saved ✓" : "Save failed");
  } catch (e) { note("Save failed — offline?"); }
}
const openFirst = (a, b) => !!a.ticked - !!b.ticked;
/* Hub tasks and Todoist tasks in one list: open before done, then by date, time
   and the order set by dragging. An undated Hub task sorts after the dated
   ones ("9" > any date); a task with no time sorts before timed ones. */
function mixRows(tasks, rems) {
  const rows = tasks.map(t => ({ done: !!t.completed, due: t.due || "9", min: timeMin(t.time), ord: sortKey(t), title: String(t.title), html: () => taskRow(t) }))
    .concat(rems.map(r => ({ done: !!r.ticked, due: r.due, min: remMinutes(r.time), ord: 2e9, title: r.title, html: () => reminderRow(r) })));
  return rows.sort((a, b) => a.done - b.done || a.due.localeCompare(b.due) || a.min - b.min || a.ord - b.ord || a.title.localeCompare(b.title))
    .map(x => x.html());
}
/* Undated tasks have no section to sort into, so each project gets its own,
   folded until opened, in Todoist's order. */
function renderUndatedReminders(items) {
  const lists = [];
  items.forEach(r => { if (!lists.includes(r.list)) lists.push(r.list); });
  return lists.map(l => {
    const mine = items.filter(r => r.list === l).sort(openFirst), n = mine.filter(r => !r.ticked).length;
    return `<details class="later" data-sec="list:${esc(l)}" ontoggle="secToggle(this)" ${REM.open.has("list:" + l) ? "open" : ""}>
      <summary>${esc(l)} · ${n}<span class="tiny">no due date</span></summary><div class="block">${mine.map(reminderRow).join("")}</div></details>`;
  }).join("");
}
/* Where Todoist tasks sit among the Hub's, these lines say how fresh they are.
   A stale copy's note goes at the top so its dates are never taken as current. */
function remStale() {
  const rm = REM.show && DATA.reminders;
  if (!rm) return "";
  if (rm.status === "stale") return remStatus(rm);
  return rm.status === "none" || rm.status === "error" ? `<div class="block">${remEmpty(rm)}</div>` : "";
}
function remFresh() {
  const rm = REM.show && DATA.reminders;
  return rm && rm.status === "fresh" ? remStatus(rm) : "";
}
/* If the backend has nothing to send but this device holds an earlier copy,
   keep showing that copy (marked stale with its time) rather than an empty list. */
function keepGoodReminders(next) {
  const prev = DATA && DATA.reminders;
  if (next && (next.status === "none" || next.status === "error") && prev && prev.syncedAt && Array.isArray(prev.items) && prev.items.length)
    return { ...prev, status: "stale" };
  return next;
}
function secToggle(el) { el.open ? REM.open.add(el.dataset.sec) : REM.open.delete(el.dataset.sec); }

function remSettingsHtml() {
  const rm = DATA.reminders, lists = rm && Array.isArray(rm.lists) ? rm.lists : [];
  const row = (id, attrs, label, hint) => `<div class="nrow"><label class="ncheck"><input type="checkbox" ${id} ${attrs}>
    <span class="ttl">${esc(label)}${hint ? `<span class="tiny">${esc(hint)}</span>` : ""}</span></label></div>`;
  let h = row(`onchange="setRemShow(this.checked)"`, REM.show ? "checked" : "", "Show Jon's reminders on this device",
    "Read from Jon's Todoist. Chosen per device. Projects the backend hides (Work, unless changed) are never sent.");
  if (REM.show && lists.length) h += lists.map(l =>
    row(`data-list="${esc(l)}" onchange="setRemList(this.dataset.list, this.checked)"`, REM.hidden.includes(l) ? "" : "checked", l, "Show this project here")).join("");
  else if (REM.show && rm === undefined) h += `<div class="empty">Jon's Todoist tasks are sent to a parent's device only.</div>`;
  return h;
}
function redrawRemSettings() { const b = document.getElementById("remBox"); if (b) b.innerHTML = `<div class="block">${remSettingsHtml()}</div>`; }
async function setRemShow(on) {
  localStorage.setItem("fd_rem_show", on ? "1" : "0");
  if (!on) { DATA.reminders = undefined; localStorage.setItem("fd_cache", JSON.stringify(DATA)); render(); }
  redrawRemSettings();
  if (on) { await refresh(true); render(); redrawRemSettings(); }
}
function setRemList(list, show) {
  const hidden = REM.hidden.filter(l => l !== list);
  if (!show) hidden.push(list);
  localStorage.setItem("fd_rem_hidden", JSON.stringify(hidden));
  render();
}

function isoPlus(iso, days) {
  const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + days);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
const val = id => (document.getElementById(id) || {}).value || "";
/* The repeat a form describes ("new" adds, "ed" edits), in the stored text form. */
function currentRepeat(p = "new") {
  const preset = val(p + "Repeat");
  if (preset !== "custom") return preset;
  const n = Math.max(1, Math.min(99, parseInt(val(p + "RepN"), 10) || 1)), unit = val(p + "RepUnit");
  let rule = `every ${n} ${unit}${n > 1 ? "s" : ""}`;
  if (unit === "week") {
    const days = [...document.querySelectorAll(`#${p}RepDays input:checked`)].map(i => i.value);
    if (days.length) rule += " on " + days.join(",");
  }
  if ((unit === "month" || unit === "year") && val(p + "RepOn")) rule += " on " + val(p + "RepOn");
  return rule;
}
/* Shows the custom controls that fit, and says in words what will happen. */
function repeatUI(p = "new") {
  const box = document.getElementById(p + "Custom");
  if (!box) return;
  const custom = val(p + "Repeat") === "custom", unit = val(p + "RepUnit");
  const due = val(p + "Due") || todayStr(), d = new Date(due + "T12:00:00");
  box.classList.toggle("hidden", !custom);
  const dayBox = document.getElementById(p + "RepDays");
  dayBox.classList.toggle("hidden", unit !== "week");
  // The due date's weekday, until the days are picked by hand (or all unpicked).
  const days = [...dayBox.querySelectorAll("input")];
  if (!dayBox.dataset.touched || !days.some(i => i.checked)) {
    days.forEach((i, n) => { i.checked = n === d.getDay(); });
  }
  // "On the same date" or "on the third Saturday" (and "last", when it is), from the due date
  const on = document.getElementById(p + "RepOn"), keep = on.value, k = Math.ceil(d.getDate() / 7), wd = WD[d.getDay()];
  const isLast = d.getDate() + 7 > new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const choices = [["", `On day ${d.getDate()}`], [`${NTH_CODE[k]} ${wd}`, `On the ${NTH_WORD[k]} ${WD_LONG[d.getDay()]}`]]
    .concat(isLast && k !== 5 ? [[`last ${wd}`, `On the last ${WD_LONG[d.getDay()]}`]] : []);
  on.innerHTML = choices.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  if (choices.some(c => c[0] === keep)) on.value = keep;
  on.classList.toggle("hidden", unit !== "month" && unit !== "year");
  // A time with no day means today.
  const rule = currentRepeat(p), info = dueInfo(due), time = val(p + "Time");
  const when = (info.text.toLowerCase() === "today" ? "today" : info.text) + (time ? " at " + fmtTime(time) : "");
  say(p + "RepeatText", rule ? `↻ ${describeRepeat(rule, due)}, starting ${when}`
    : val(p + "Due") || time ? `Due ${when}` : "");
}
/* Puts a stored repeat back into the picker: a preset when it is one, otherwise the custom controls. */
function fillRepeat(p, text) {
  const sel = document.getElementById(p + "Repeat"), r = parseRepeat(text);
  if (!text || !r) { sel.value = ""; repeatUI(p); return; }
  if ([...sel.options].some(o => o.value === text)) { sel.value = text; repeatUI(p); return; }
  sel.value = "custom";
  document.getElementById(p + "RepN").value = r.n;
  document.getElementById(p + "RepUnit").value = r.unit;
  if (r.days) {
    const box = document.getElementById(p + "RepDays");
    box.dataset.touched = 1;
    box.querySelectorAll("input").forEach((i, n) => { i.checked = r.days.includes(n); });
  }
  repeatUI(p); // builds the "on the third Saturday" choices from the due date
  if (r.nth) { document.getElementById(p + "RepOn").value = `${NTH_CODE[r.nth.k]} ${WD[r.nth.wd]}`; repeatUI(p); }
}
/* Due date and time as a form gives them: a time alone means today, a repeat needs a day, and no day means no time. */
function formWhen(p, repeat) {
  let due = val(p + "Due"), time = val(p + "Time");
  if (!due && (time || repeat)) due = todayStr();
  return { due, time: due ? time : "" };
}
function addTask() {
  const title = document.getElementById("newTitle").value.trim();
  if (!title) return;
  const repeat = currentRepeat(), { due, time } = formWhen("new", repeat), parentId = val("newParent");
  const body = { action: "addTask", title, recurrence: "once", due, time, repeat, parentId, assignee: val("newWho"), by: cfg.user };
  const last = Math.max(0, ...subsOf(parentId).map(x => x.sort || 0));
  if (parentId) foldTask(parentId, false);
  DATA.tasks.push({ id: "tmp-" + Date.now(), title, recurrence: repeat ? "repeat" : "once", repeat, due, time, parentId,
    sort: parentId ? last + 1 : null, assignee: body.assignee, completed: false });
  clearDraft("fd_draft_task");
  expectNewRows();
  send(body);
}
function toggleTask(id) {
  if (id.startsWith("tmp")) { render(); return; } // still saving
  const t = DATA.tasks.find(x => x.id === id);
  if (t) { t.completed = !t.completed; t.completedBy = t.completed ? cfg.user : null; }
  LAST_TICK = t && t.completed ? id : null; // for the all-clear's Undo
  const row = document.querySelector(`#main [data-tid="${CSS.escape(id)}"]`);
  if (row && t) row.classList.toggle("done", t.completed);
  // Ticking a task ticks its open subtasks too (the server does the same); unticking leaves them.
  // A subtask with a repeat of its own keeps its own schedule.
  if (t && t.completed && !isSub(t)) subsOf(id).forEach(s => {
    if (!s.completed && s.recurrence !== "repeat") Object.assign(s, { completed: true, completedBy: cfg.user });
  });
  send({ action: "toggleTask", id, by: cfg.user });
}
function deleteTask(id) {
  const n = subsOf(id).length;
  if (!confirm(n ? `Delete this task and its ${n} subtask${n > 1 ? "s" : ""}?` : "Delete this task?")) { render(); return; }
  closeOverlay();
  const sel = CSS.escape(id);
  leaveRow([...document.querySelectorAll(`#main [data-tid="${sel}"], #main [data-parent="${sel}"], #main details[data-for="${sel}"]`)], () => {
    DATA.tasks = DATA.tasks.filter(x => x.id !== id && x.parentId !== id);
    send({ action: "deleteTask", id });
  });
}
/* Edits go one at a time, in order, so a quick run of moves can't land out of order. */
let TASK_Q = Promise.resolve();
function sendTask(body) { TASK_Q = TASK_Q.then(() => send(body)); return TASK_Q; }

/* ----- Editing a task -----
   Tap a task's title. Everything the add form sets can be changed, and a
   task can be put under another one (or taken out) as a subtask. */
function openTaskEdit(id) {
  const t = taskById(id);
  if (!t || String(id).startsWith("tmp-")) return; // still saving
  const subs = subsOf(id), who = FAMILY.includes(t.assignee) ? FAMILY : [""].concat(FAMILY);
  overlayHtml(`
    <header><span class="eyebrow">Edit task</span></header>
    <label class="f" for="edTitle">Task</label>
    <input type="text" id="edTitle" value="${esc(t.title)}" maxlength="200" onkeydown="if (event.key === 'Enter') saveTaskEdit('${esc(id)}')">
    <label class="f" for="edWho">Who</label>
    <select id="edWho">${who.map(f => `<option value="${esc(f)}" ${f === (t.assignee || "") ? "selected" : ""}>${esc(f || "Anyone")}</option>`).join("")}</select>
    <label class="f" for="edDue">Due</label>
    <div class="addrow">
      <input type="date" id="edDue" value="${esc(t.due || "")}" aria-label="Due date" onchange="repeatUI('ed')">
      <input type="time" id="edTime" value="${esc(t.time || "")}" aria-label="Due time" onchange="repeatUI('ed')">
      <button type="button" class="ghost" onclick="clearWhen()">Clear</button>
    </div>
    <label class="f" for="edRepeat">Repeat</label>
    <div class="addrow">${repeatSelect("ed")}</div>
    ${repeatCustom("ed")}
    <div class="tiny" id="edRepeatText" style="margin-top:var(--space-2)"></div>
    <label class="f" for="edParent">Subtask of</label>
    <select id="edParent" ${subs.length ? "disabled" : ""}>${parentOptions(isSub(t) ? t.parentId : "", id)}</select>
    ${subs.length ? `<div class="tiny" style="margin-top:var(--space-2)">It has ${subs.length} subtask${subs.length > 1 ? "s" : ""} of its own, so it can't go under another task.</div>` : ""}
    <div class="actions">
      <button class="primary" onclick="saveTaskEdit('${esc(id)}')">Save</button>
      <button class="ghost" onclick="closeOverlay()">Cancel</button>
      <button class="danger" onclick="deleteTask('${esc(id)}')">Delete</button>
    </div>
    <div class="tiny" style="margin-top:var(--space-5)">On the Tasks screen, drag a task by its handle: onto another task to make it a subtask, between tasks to move it, or onto Today, Tomorrow, Next week or No date.</div>`);
  fillRepeat("ed", t.repeat || "");
}
function clearWhen() {
  document.getElementById("edDue").value = "";
  document.getElementById("edTime").value = "";
  document.getElementById("edRepeat").value = "";
  repeatUI("ed");
}
function saveTaskEdit(id) {
  const t = taskById(id);
  if (!t) { closeOverlay(); return; }
  const title = val("edTitle").trim();
  if (!title) { document.getElementById("edTitle").focus(); return; }
  const repeat = currentRepeat("ed"), { due, time } = formWhen("ed", repeat);
  const parentId = subsOf(id).length ? "" : val("edParent");
  const body = { action: "updateTask", id, title, assignee: val("edWho"), due, time, repeat, parentId };
  // Show it straight away; the save answers with what the Sheet now holds.
  if (parentId !== (t.parentId || "")) t.sort = parentId ? Math.max(0, ...subsOf(parentId).map(x => x.sort || 0)) + 1 : null;
  if (parentId) foldTask(parentId, false);
  if (t.repeat && (due !== t.due || repeat !== t.repeat)) t.completed = false;
  Object.assign(t, { title, assignee: body.assignee, due, time, repeat, parentId,
    recurrence: repeat ? "repeat" : t.recurrence === "repeat" ? "once" : t.recurrence });
  closeOverlay();
  render();
  sendTask(body);
}

/* ----- Dragging tasks -----
   Press a task's handle and drag. Where it's dropped decides what happens:
   - onto the middle of a task: it becomes that task's last subtask
   - between tasks: it goes there, taking that spot's day and time
     (beside a subtask, it becomes a subtask of the same parent)
   - onto Today, Tomorrow, Next week or No date in the bar that appears: a new day
   Subtasks go one level deep. Arrow keys on the handle do the same moves. */
let TD = null;
const TD_EDGE = 0.28; // the top and bottom of a row (as a share of its height) place beside it; the middle nests
const TD_DATES = [["Today", 0], ["Tomorrow", 1], ["Next week", 7], ["No date", null]];

/* What dropping task t beside (or into) task r would do, or null if it can't go there. */
function planPlace(t, r, where) {
  if (!r || r.id === t.id || r.completed) return null;
  const hasSubs = subsOf(t.id).length > 0, ids = list => list.map(x => x.id);
  const open = x => !x.completed && x.id !== t.id;
  if (where === "into") {
    if (hasSubs || isSub(r)) return null;
    return { parentId: r.id, due: t.due || "", time: t.time || "",
      order: ids(subsOf(r.id).filter(open).sort(subOrder).concat(t)), hint: `Make it a subtask of “${r.title}”` };
  }
  if (isSub(r)) {
    if (hasSubs) return null;
    const sibs = subsOf(r.parentId).filter(open).sort(subOrder);
    sibs.splice(sibs.indexOf(r) + (where === "after" ? 1 : 0), 0, t);
    return { parentId: r.parentId, due: t.due || "", time: t.time || "", order: ids(sibs),
      hint: t.parentId === r.parentId ? "Move it here" : `Make it a subtask of “${taskById(r.parentId).title}”` };
  }
  // Beside a top-level task: it takes that task's day and time, so it sorts where it's dropped.
  let due = t.due || "", time = t.time || "";
  if (r.due) {
    if (t.recurrence !== "once" && t.recurrence !== "repeat") return null; // the Sheet's own daily/weekly lists keep no date
    due = r.due; time = r.time || "";
  } else if (due || t.recurrence !== r.recurrence) return null; // undated lists only reorder
  const group = tops().filter(x => open(x) && (x.due || "") === due && (x.time || "") === time &&
    (due || x.recurrence === t.recurrence)).sort(cmpTask);
  group.splice(group.indexOf(r) + (where === "after" ? 1 : 0), 0, t);
  return { parentId: "", due, time, order: ids(group), hint: planHint(t, due, time) || "Move it here" };
}
/* What dropping task t on a day in the bar would do. */
function planDate(t, due) {
  if (t.recurrence !== "once" && t.recurrence !== "repeat") return null;
  if (!due && t.repeat) return null; // a repeating task always has a next date
  const time = due ? t.time || "" : "";
  const group = tops().filter(x => !x.completed && x.id !== t.id && (x.due || "") === due && (x.time || "") === time &&
    (due || x.recurrence === "once")).sort(cmpTask).concat(t);
  return { parentId: "", due, time, order: group.map(x => x.id), hint: planHint(t, due, time) || "Leave it where it is" };
}
function planHint(t, due, time) {
  const parts = [];
  if (isSub(t)) parts.push("Take it out of “" + taskById(t.parentId).title + "”");
  if (due !== (t.due || "") || time !== (t.time || "")) {
    parts.push(due ? "Due " + dueInfo(due).text + (time ? " · " + fmtTime(time) : "") : "No due date");
  }
  return parts.join(" · ");
}
/* Saves a move: the new day, time and parent, and the order of the list it joined. */
function commitPlan(t, plan) {
  const body = { action: "updateTask", id: t.id, order: plan.order.filter(id => !String(id).startsWith("tmp-")) };
  if ((isSub(t) ? t.parentId : "") !== plan.parentId) body.parentId = plan.parentId;
  if (plan.parentId) foldTask(plan.parentId, false);
  if ((t.due || "") !== plan.due) body.due = plan.due;
  if ((t.time || "") !== plan.time) body.time = plan.time;
  if (t.repeat && "due" in body) t.completed = false;
  Object.assign(t, { parentId: plan.parentId, due: plan.due, time: plan.time });
  plan.order.forEach((id, i) => { const x = taskById(id); if (x) x.sort = i + 1; });
  render();
  return sendTask(body);
}

function tdStart(e, id) {
  const t = taskById(id);
  if (TD || DRAG || !t || String(id).startsWith("tmp-")) return;
  e.preventDefault();
  const row = e.currentTarget.closest(".task");
  e.currentTarget.setPointerCapture(e.pointerId);
  // The task and its fold of subtasks move together, and can't be dropped on themselves.
  const fold = r => r.nextElementSibling && r.nextElementSibling.matches("details.tsubs") ? r.nextElementSibling : null;
  const group = [row, fold(row)].filter(Boolean);
  const sy = window.scrollY;
  const rows = [...document.querySelectorAll("#main .task[data-tid]")]
    .filter(r => !group.some(g => g.contains(r)) && !r.classList.contains("done") && !r.closest("details:not([open])")) // nor a folded subtask
    .map(r => { const b = r.getBoundingClientRect(), f = fold(r);
      return { el: r, id: r.dataset.tid, parent: r.dataset.parent || "", top: b.top + sy, bottom: b.bottom + sy, left: b.left, width: b.width,
        end: (f ? f.getBoundingClientRect().bottom : b.bottom) + sy }; });
  const bar = document.createElement("div");
  bar.className = "td-bar";
  bar.innerHTML = `<div class="td-hint" id="tdHint" role="status">Drop onto a task to make it a subtask</div>
    <div class="td-chips">${TD_DATES.map(([label, days]) => {
      const due = days == null ? "" : isoPlus(todayStr(), days);
      return `<div class="td-chip ${planDate(t, due) ? "" : "off"}" data-due="${due}">${label}</div>`;
    }).join("")}</div>`;
  document.body.appendChild(bar);
  const line = document.createElement("div");
  line.className = "drop-line hidden";
  document.body.appendChild(line);
  TD = { t, group, rows, bar, line, sx: e.clientX, sy: e.clientY, scroll0: sy, x: e.clientX, y: e.clientY, plan: null, into: null, raf: 0 };
  row.classList.add("dragging");
  group.slice(1).forEach(r => r.classList.add("dragging-sub"));
  tdLoop();
}
function tdMove(e) {
  if (!TD) return;
  TD.x = e.clientX; TD.y = e.clientY;
  tdUpdate();
}
function tdUpdate() {
  const dy = TD.y - TD.sy + window.scrollY - TD.scroll0, dx = (TD.x - TD.sx) * 0.3;
  TD.group.forEach(r => { r.style.transform = `translate(${dx}px, ${dy}px)`; });
  let plan = null, into = null, lineAt = null;
  // On a day in the bar?
  TD.bar.querySelectorAll(".td-chip").forEach(c => {
    const b = c.getBoundingClientRect(), hit = TD.x >= b.left && TD.x <= b.right && TD.y >= b.top && TD.y <= b.bottom;
    const p = hit && planDate(TD.t, c.dataset.due);
    c.classList.toggle("on", !!p);
    if (p) plan = p;
  });
  // Over a row?
  const y = TD.y + window.scrollY, r = !plan && TD.y > TD.bar.getBoundingClientRect().bottom && TD.rows.find(x => y >= x.top && y < x.bottom);
  if (r) {
    const f = (y - r.top) / (r.bottom - r.top), target = taskById(r.id);
    if (r.parent) {
      const where = f < 0.5 ? "before" : "after";
      plan = planPlace(TD.t, target, where);
      lineAt = { r, y: where === "before" ? r.top : r.bottom };
    } else if (f > TD_EDGE && f < 1 - TD_EDGE) {
      plan = planPlace(TD.t, target, "into");
      if (plan) into = r.el;
    } else {
      const where = f <= TD_EDGE ? "before" : "after";
      plan = planPlace(TD.t, target, where);
      // "After" a task with subtasks means after its fold of them, open or not.
      lineAt = { r, y: where === "before" ? r.top : r.end };
    }
  }
  if (TD.into !== into) {
    if (TD.into) TD.into.classList.remove("drop-into");
    if (into) into.classList.add("drop-into");
    TD.into = into;
  }
  const showLine = plan && lineAt;
  TD.line.classList.toggle("hidden", !showLine);
  if (showLine) Object.assign(TD.line.style, { top: lineAt.y + "px", left: lineAt.r.left + "px", width: lineAt.r.width + "px" });
  TD.plan = plan;
  document.getElementById("tdHint").textContent = plan ? plan.hint
    : r || TD.bar.contains(document.elementFromPoint(TD.x, TD.y)) ? "It can't go there" : "Drop onto a task to make it a subtask";
}
/* Scrolls the page while the finger is held near the top (under the bar) or the bottom. */
function tdLoop() {
  if (!TD) return;
  const top = TD.bar.getBoundingClientRect().bottom, bottom = window.innerHeight - 90; // the nav sits at the bottom
  const v = TD.y > top && TD.y < top + 60 ? -Math.ceil((top + 60 - TD.y) / 6)
    : TD.y > bottom ? Math.ceil((TD.y - bottom) / 6) : 0;
  if (v) { window.scrollBy(0, Math.max(-12, Math.min(12, v))); tdUpdate(); }
  TD.raf = requestAnimationFrame(tdLoop);
}
function tdEnd(cancel) {
  if (!TD) return;
  const { t, plan, group, bar, line, into, raf } = TD;
  TD = null;
  cancelAnimationFrame(raf);
  bar.remove(); line.remove();
  if (into) into.classList.remove("drop-into");
  group.forEach(r => { r.style.transform = ""; r.classList.remove("dragging", "dragging-sub"); });
  if (!cancel && plan) commitPlan(t, plan);
  else render(); // picks up anything a refresh brought in mid-drag
}
/* The same moves from the keyboard: up and down within the list, right to go
   under the task above, left to come out from under its parent. */
function tdKey(e, id) {
  const t = taskById(id);
  if (!t || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
  e.preventDefault();
  if (String(id).startsWith("tmp-") || TD) return;
  const row = e.currentTarget.closest(".task");
  const peers = [...row.parentElement.querySelectorAll(".task[data-tid]:not(.done)")]
    .filter(r => (r.dataset.parent || "") === (row.dataset.parent || ""));
  const at = peers.indexOf(row), above = peers[at - 1], below = peers[at + 1];
  let plan = null;
  if (e.key === "ArrowUp" && above) plan = planPlace(t, taskById(above.dataset.tid), "before");
  if (e.key === "ArrowDown" && below) plan = planPlace(t, taskById(below.dataset.tid), "after");
  if (e.key === "ArrowRight" && !row.dataset.parent && above) plan = planPlace(t, taskById(above.dataset.tid), "into");
  if (e.key === "ArrowLeft" && isSub(t)) plan = planPlace(t, taskById(t.parentId), "after");
  if (!plan) return;
  const refocus = () => { const b = document.querySelector(`[data-tgrip="${CSS.escape(id)}"]`); if (b) b.focus(); };
  note(plan.hint);
  commitPlan(t, plan).then(refocus);
  refocus();
}
