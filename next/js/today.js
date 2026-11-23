// The Today screen: a greeting and the day in a sentence, Up next (counting down live), tonight's
// dinner and the grocery list, what's on your plate (with the all-clear when it's done), the
// schedule, and what's on deck.
"use strict";

let LAST_TICK = null; // the last thing ticked done here ("<task id>" or "rem:<key>"), for the all-clear's Undo

/* ----- the greeting and the day in a sentence ----- */
function greeting(d = new Date()) {
  const h = d.getHours() + d.getMinutes() / 60, who = cfg.user;
  if (h < 5 || h >= 22) return `Still up, ${who}?`;
  if (h < 12) return `Good morning, ${who}.`;
  if (h < 17) return `Good afternoon, ${who}.`;
  return `Good evening, ${who}.`;
}
/* "4:15 PM" → "4:15pm", "6:00 PM" → "6pm" */
function clock(s) {
  const m = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(s || "");
  return m ? m[1] + (m[2] === "00" ? "" : ":" + m[2]) + m[3].toLowerCase() : String(s || "");
}
function listJoin(xs) {
  return xs.length < 2 ? xs.join("") : xs.length === 2 ? xs.join(" and ") : xs.slice(0, -1).join(", ") + ", and " + xs[xs.length - 1];
}
/* A timed event's start and end as moments, on its own day (home time, as the Worker sends it). */
function evWhen(e) {
  const at = s => {
    const m = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(s || "");
    if (!m) return null;
    const d = new Date(e.date + "T00:00:00");
    d.setHours(Number(m[1]) % 12 + (/p/i.test(m[3]) ? 12 : 0), Number(m[2]), 0, 0);
    return d;
  };
  const start = at(e.start);
  let end = at(e.end);
  if (start && end && end <= start) end = null; // runs past midnight: treat it as open-ended
  return { start, end };
}
function tonightsDinner() {
  const m = DATA.meals[DAYS[(new Date().getDay() + 6) % 7]] || {};
  return { text: m.meal || "", note: m.note || "", parts: mealParts(m.meal) };
}
function daySentence(now = new Date()) {
  const t = todayStr(), evs = DATA.events.filter(e => onDay(e, t));
  // all day, or carrying on from an earlier day; the same title from two calendars, once
  const allDay = [...new Set(evs.filter(e => e.allDay || e.date < t).map(e => e.title.trim()))];
  const left = evs.filter(e => !e.allDay && e.date === t).map(e => ({ e, ...evWhen(e) }))
    .filter(x => x.start && (x.end ? x.end > now : x.start > now)).sort((a, b) => a.start - b.start);
  const bits = left.slice(0, 2).map(x => x.start <= now && x.end
    ? `${x.e.title} until ${clock(x.e.end)}` : `${x.e.title} at ${clock(x.e.start)}`);
  if (left.length > 2) bits.push(`${left.length - 2} more`);
  const dinner = tonightsDinner().parts.name;
  let s;
  if (bits.length) s = listJoin(bits) + (dinner ? `, then ${dinner} for dinner.` : ".");
  else if (evs.some(e => !e.allDay && e.date === t)) s = "Nothing else on the calendar today" + (dinner ? `, and it's ${dinner} for dinner.` : ".");
  else s = "A clear calendar today" + (dinner ? `, and it's ${dinner} for dinner.` : ".");
  if (!dinner) s += " Dinner isn't planned yet.";
  if (allDay.length) s = `${listJoin(allDay)} today. ${s}`;
  return s;
}

/* ----- Up next: what's next today (or first thing tomorrow), counting down ----- */
function upNext(now = new Date()) {
  const t = todayStr(), tom = isoPlus(t, 1);
  const timed = DATA.events.filter(e => !e.allDay && (e.date === t || e.date === tom))
    .map(e => ({ e, ...evWhen(e) })).filter(x => x.start).sort((a, b) => a.start - b.start);
  const starting = timed.find(x => x.start <= now && now - x.start < 10 * 60000); // just begun: "Starting now"
  if (starting) return { ...starting, state: "now" };
  const next = timed.find(x => x.start > now);
  return next ? { ...next, state: next.e.date === t ? "soon" : "tomorrow" } : null;
}
const upKey = u => (u ? `${u.e.date}|${u.e.start}|${u.e.title}|${u.state}` : "");
const RING = 2 * Math.PI * 28; // the ring's length: it empties over the last hour
function upWhen(u, now) {
  if (u.state === "now") return { text: "Starting now", frac: 0 };
  if (u.state === "tomorrow") return { text: "Tomorrow", frac: 1 };
  const mins = Math.max(1, Math.ceil((u.start - now) / 60000)), h = Math.floor(mins / 60), m = mins % 60;
  return { text: "In " + (h ? `${h} hr${m ? ` ${m} min` : ""}` : `${m} min`), frac: Math.min(1, mins / 60) };
}
function upNextHtml(u, now = new Date()) {
  if (!u) return "";
  const w = upWhen(u, now), e = u.e;
  const [hm, ap] = String(e.start).split(" ");
  return `<button type="button" class="upnext ${u.state === "now" ? "is-now" : ""}" data-key="${esc(upKey(u))}" onclick="go('calendar')"
      aria-label="${esc(`Up next: ${e.title}, ${w.text.toLowerCase()}, at ${e.start}. Opens the calendar.`)}">
    <span class="un-text">
      <span class="un-eyebrow">Up next · <span class="un-when">${esc(w.text)}</span></span>
      <span class="un-title">${esc(e.title)}</span>
      <span class="un-meta">${esc(e.cal)} · ${esc(e.start)}${e.end ? "–" + esc(e.end) : ""}</span>
    </span>
    <span class="un-ring" aria-hidden="true">
      <svg viewBox="0 0 64 64"><circle class="un-track" cx="32" cy="32" r="28"/>
        <circle class="un-fill" cx="32" cy="32" r="28" style="stroke-dasharray:${RING.toFixed(1)};stroke-dashoffset:${(RING * (1 - w.frac)).toFixed(1)}"/></svg>
      <span class="un-clock">${esc(hm || "")}<small>${esc(ap || "")}</small></span>
    </span>
  </button>`;
}
/* Every few seconds while Today is open: the countdown and ring move, the greeting turns with the day,
   and when what's next changes the screen is redrawn (unless someone's typing or a panel is up). */
function tickToday() {
  if (VIEW !== "today" || document.hidden || TD || DRAG) return;
  const now = new Date(), title = document.getElementById("viewTitle"), g = greeting(now);
  if (title.textContent !== g) title.textContent = g;
  const card = document.querySelector("#main .upnext"), u = upNext(now);
  if ((card ? card.dataset.key : "") !== upKey(u)) { if (!hasUnsavedEdits() && !panelUp()) render(); return; }
  if (!card) return;
  const w = upWhen(u, now);
  card.querySelector(".un-when").textContent = w.text;
  card.querySelector(".un-fill").style.strokeDashoffset = (RING * (1 - w.frac)).toFixed(1);
}
setInterval(tickToday, 15000);

/* ----- the all-clear ----- */
function allClearHtml(party, hadAny) {
  const h = new Date().getHours();
  const line = !hadAny ? "Nothing on your plate today."
    : h >= 17 ? "Everything on today's list is done. Go enjoy your evening."
    : h >= 12 ? "Everything on today's list is done. Enjoy the rest of the day."
    : "Everything on today's list is done. What a start.";
  const colors = ["--p-jon", "--p-maggie", "--p-clayton", "--p-heidi", "--accent"];
  const bits = party ? Array.from({ length: 24 }, (_, i) =>
    `<span class="cf c${i % 6 + 1}" style="left:${44 + ((i * 7) % 13) - 6}%;background:var(${colors[i % 5]});animation-delay:${(i * 0.025).toFixed(3)}s"></span>`).join("") : "";
  return `<div class="allclear ${party ? "party" : ""}" role="status">
    <span class="cf-box" aria-hidden="true">${bits}</span>
    <span class="ac-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>
    <h3>${hadAny ? "All clear." : "A light day."}</h3>
    <p>${line}</p>
    ${LAST_TICK ? `<button type="button" class="ghost" onclick="undoLastTick()">Undo the last one</button>` : ""}
  </div>`;
}
function undoLastTick() {
  const last = LAST_TICK;
  LAST_TICK = null;
  if (!last) return;
  if (last.startsWith("rem:")) tickReminder(last.slice(4), false);
  else toggleTask(last);
}

/* ----- the screen ----- */
function renderToday() {
  const t = todayStr(), now = new Date();
  // Subtasks show under their parents, so only top-level tasks are sorted into these lists.
  const top = tops();
  const daily = top.filter(x => x.recurrence === "daily" || isDailyRepeat(x));
  // Dated tasks once they're due (overdue first); undated one-offs as before.
  const oneOff = top.filter(x => !x.completed && !isDailyRepeat(x) &&
      (x.due ? x.due <= t : x.recurrence === "once")).sort(cmpTask);
  const onDeck = top.filter(x => ["weekly", "monthly", "quarterly", "yearly"].includes(x.recurrence) && !x.completed);
  const rems = reminderTops().filter(r => r.due && r.due <= t); // Jon's Todoist tasks due today or overdue
  const plate = oneOff.concat(daily.filter(x => !oneOff.includes(x)));

  let h = `<p class="daysentence">${esc(daySentence(now))}</p>`;
  h += upNextHtml(upNext(now), now);

  // Tonight, then the grocery list in one line
  const din = tonightsDinner();
  h += `<section class="tonight lineup" aria-label="Tonight's dinner"><span class="marker now">Tonight</span>
    <h3>${din.text ? esc(din.parts.name || "Tonight's recipe") : "Dinner isn't planned yet"}</h3>
    ${din.note ? `<div class="muted">${esc(din.note)}</div>` : ""}
    ${din.text ? "" : `<div class="muted">${fromNotion() ? "Nothing in the Notion meal plan for tonight." : "Plan the week on the Dinner tab."}</div>`}
    <div class="tonight-actions">${recipeLinks(din.parts.links, openRecipeButtons(DAYS[(new Date().getDay() + 6) % 7]))}<button type="button" class="linkish" onclick="go('meals')">The whole week</button></div>
  </section>`;
  if (Array.isArray(DATA.groceries)) {
    const want = DATA.groceries.filter(g => !g.done).map(g => g.item);
    const names = want.length ? want.slice(0, 4).join(", ") + (want.length > 4 ? ` and ${want.length - 4} more` : "") : "Everything's got";
    h += `<button type="button" class="grorow" onclick="go('meals')" aria-label="${esc(`Groceries: ${want.length} to get. Opens Dinner.`)}">
      <span class="count" data-count="gro">${want.length}</span>
      <span class="gr-text"><span class="gr-label">Groceries to get</span><span class="gr-items">${esc(names)}</span></span>
      <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>`;
  }

  // On your plate: today's and overdue to-dos, the daily rhythm and Jon's Todoist tasks, in one list
  const open = plate.filter(x => !x.completed).length + rems.filter(r => !r.ticked).length;
  const any = plate.length + rems.length > 0;
  h += `<h2>On your plate<span class="hint">${open ? `<span class="count" data-count="plate">${open}</span> left` : ""}</span></h2>${remStale()}`;
  if (!open) {
    let party = false;
    if (LAST_TICK && localStorage.getItem("fd_allclear") !== t) { party = true; localStorage.setItem("fd_allclear", t); } // once a day
    h += allClearHtml(party, any || !!LAST_TICK);
  }
  if (any) h += `<div class="block">${mixRows(plate, rems).join("")}</div>`;

  // The whole day, with what's over dimmed
  const todays = eventsOn(t);
  h += `<h2>Today's schedule</h2>`;
  h += todays.length ? `<div class="block">${todays.map(e => eventRow(e, evOver(e, t, now), t)).join("")}</div>`
                     : `<div class="block"><div class="empty">Nothing on the calendar today.</div></div>`;
  if (onDeck.length) h += `<h2>On deck this period</h2><div class="block">${onDeck.map(taskRow).join("")}</div>`;
  return h;
}
