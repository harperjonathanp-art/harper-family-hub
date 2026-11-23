// The Check-in screen: the Family Huddle and the Weekly Check-In, one question per card.
"use strict";

/* ----- Check-ins ----- */
let CHECKIN_OPEN = null; // "huddle" | "couples" | null

let CHECKIN_AT = 0;      // which card is showing, kept across a background refresh

/* The two check-ins, and what each one asks. */
const CHECKIN_KINDS = {
  huddle: { name: "Family Huddle", who: "Everyone", marker: "team", when: "Sundays 6:30 PM · 20 min",
    blurb: "Rose / Thorn / Bud, the week ahead, chores, the fun pick, gratitude",
    note: "Clayton is Calendar Captain · Heidi is Fun Picker. Notes are optional; saving marks this week done.",
    cards: () => HUDDLE_FIELDS.map(([k, title, hint]) => ({ id: "hud-" + k, title, hint })), save: "Save huddle" },
  couples: { name: "Weekly Check-In", who: "Jon & Maggie", marker: "ceremony", when: "Sundays 8:00 PM · 30 min",
    blurb: "The seven questions, then the week's logistics",
    note: "Part one: the seven questions. Big topics get their own time. Hard stop at 30.",
    cards: () => COUPLES_QUESTIONS.map((q, i) => ({ id: "cpl-q" + i, title: q, hint: "" })), save: "Save check-in" },
};
const lastCheckin = type => DATA.checkins.filter(c => c.type === type).map(c => c.date).sort().pop();
const niceDate = iso => /^\d{4}-\d{2}-\d{2}$/.test(iso || "")
  ? new Date(iso + "T12:00:00").toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : iso || "";

function renderCheckins() {
  if (CHECKIN_OPEN) return renderCheckinCards(CHECKIN_OPEN);
  let h = Object.entries(CHECKIN_KINDS).map(([type, k]) => {
    const draft = !!localStorage.getItem("fd_draft_" + type), last = lastCheckin(type);
    return `<button type="button" class="ckstart ${type}" onclick="openCheckin('${type}')">
      <span class="ck-top"><span class="marker ${k.marker}">${esc(k.who)}</span>${draft ? `<span class="ck-progress">Notes in progress</span>` : ""}</span>
      <span class="ttl-lg">${k.name}</span>
      <span class="muted">${k.when} · ${k.blurb}</span>
      <span class="ck-foot"><span class="tiny">${last ? "Last one " + esc(niceDate(last)) : "Not done yet"}</span>
        <span class="ck-go">${draft ? "Continue" : "Start"}<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></span></span>
    </button>`;
  }).join("");

  h += `<h2>Past check-ins</h2>`;
  if (!DATA.checkins.length) {
    h += `<div class="block"><div class="empty">History appears here after your first saved check-in.</div></div>`;
  } else {
    h += `<div class="block">` + DATA.checkins.map(c => {
      const label = c.type === "couples" ? "Jon & Maggie" : "Family Huddle";
      const parts = Object.entries(c.answers || {}).filter(([, v]) => v).map(([k, v]) => {
        const name = c.type === "couples"
          ? "Q" + (parseInt(k.replace("q", ""), 10) + 1) + " — " + COUPLES_QUESTIONS[parseInt(k.replace("q", ""), 10)]
          : (HUDDLE_FIELDS.find(f => f[0] === k) || [,""])[1];
        return `<b>${esc(name)}</b>${esc(v)}`;
      }).join("");
      return `<details class="hist"><summary>${esc(niceDate(c.date))} · ${label}</summary>
        <div class="ans">${parts || '<span class="tiny">Completed — no notes saved.</span>'}</div></details>`;
    }).join("") + `</div>`;
  }
  return h;
}
function openCheckin(type) { slide("forward", () => { CHECKIN_OPEN = type; CHECKIN_AT = 0; render(); window.scrollTo(0, 0); }); }
/* Closing keeps whatever's been typed (as a draft on this phone) for next time. */
function closeCheckin() {
  saveDraft();
  slide("back", () => { CHECKIN_OPEN = null; render(); window.scrollTo(0, 0); });
}

/* One question per card. Swipe or tap Next; the bar fills as you go; the last card saves. Every
   card's notes box is on the page the whole time, so drafts and saving work as they always have. */
function renderCheckinCards(type) {
  const k = CHECKIN_KINDS[type], cards = k.cards(), n = cards.length;
  CHECKIN_AT = Math.max(0, Math.min(n, CHECKIN_AT));
  const tints = ["warm", "cool", "gold", "accent", "warm", "cool", "gold"];
  return `<div class="ck-head">
      <span class="marker ${k.marker}">${esc(k.who)}</span>
      <button type="button" class="icon-btn ck-close" onclick="closeCheckin()" aria-label="Close. Your notes stay on this phone.">✕&#xFE0E;</button>
    </div>
    <div class="ck-bar" role="progressbar" aria-label="Progress" aria-valuemin="1" aria-valuemax="${n}" aria-valuenow="${Math.min(CHECKIN_AT + 1, n)}">
      ${cards.map(() => `<span></span>`).join("")}<b class="ck-count"></b></div>
    <div class="ck-deck" onpointerdown="ckDown(event)">
      <div class="ck-track" id="ckTrack">
        ${cards.map((c, i) => `<section class="ck-card tint-${tints[i % tints.length]}" aria-label="Question ${i + 1} of ${n}">
            <span class="ck-num">Question ${i + 1} of ${n}</span>
            <p class="ck-q">${esc(c.title)}</p>
            ${c.hint ? `<p class="ck-hint">${esc(c.hint)}</p>` : ""}
            <label class="f" for="${c.id}">Notes, if you want them</label>
            <textarea id="${c.id}" rows="4" placeholder="Optional"></textarea>
          </section>`).join("")}
        <section class="ck-card ck-end" aria-label="Finish">
          <span class="ac-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>
          <p class="ck-q">That's all ${n === 7 ? "seven" : n === 5 ? "five" : n}.</p>
          <p class="ck-hint">${type === "couples" ? "Next: the week's logistics. Calendar, meals and anything else that needs a plan." : "Saving marks this week's huddle done."}</p>
          <button type="button" class="primary" onclick="saveCheckin('${type}')">${k.save}</button>
        </section>
      </div>
    </div>
    <div class="ck-nav">
      <button type="button" class="ghost" id="ckBack" onclick="ckGo(CHECKIN_AT - 1)">Back</button>
      <button type="button" class="primary" id="ckNext" onclick="ckGo(CHECKIN_AT + 1)">Next</button>
    </div>
    <p class="tiny ck-note">${esc(k.note)}</p>`;
}
/* Shows the card CHECKIN_AT is on: slides the row of cards, fills the bar, and keeps the cards off
   screen out of reach of the keyboard and VoiceOver. Called after each draw and each move. */
function ckPaint(animate) {
  const track = document.getElementById("ckTrack");
  if (!track) return;
  const cards = [...track.children], n = cards.length - 1, at = CHECKIN_AT;
  track.classList.toggle("still", !animate);
  track.style.transform = `translateX(calc(${-at} * (100% + 16px)))`;
  cards.forEach((c, i) => { c.inert = i !== at; c.classList.toggle("on", i === at); });
  document.querySelectorAll(".ck-bar span").forEach((s, i) => s.className = i < at ? "done" : i === at ? "now" : "");
  document.querySelector(".ck-count").textContent = at < n ? `${at + 1} of ${n}` : "Done";
  document.querySelector(".ck-bar").setAttribute("aria-valuenow", Math.min(at + 1, n));
  const back = document.getElementById("ckBack"), next = document.getElementById("ckNext");
  back.disabled = at === 0;
  next.hidden = at === n;
  next.textContent = at === n - 1 ? "Finish" : "Next";
}
function ckGo(i) {
  const track = document.getElementById("ckTrack");
  if (!track) return;
  CHECKIN_AT = Math.max(0, Math.min(track.children.length - 1, i));
  ckPaint(!calm());
  announce(CHECKIN_AT < track.children.length - 1 ? `Question ${CHECKIN_AT + 1}` : "Finish");
}
/* Swiping the cards: a sideways move of more than about 70 px goes to the next or previous one. */
const CK = { x0: null, y0: 0, dx: 0, on: false, pid: null };
function ckDown(e) {
  if (e.target.closest("textarea, button, input") || (e.button && e.button > 0)) return;
  Object.assign(CK, { x0: e.clientX, y0: e.clientY, dx: 0, on: false, pid: e.pointerId });
  const deck = e.currentTarget;
  const move = ev => {
    if (ev.pointerId !== CK.pid) return;
    const dx = ev.clientX - CK.x0, dy = ev.clientY - CK.y0;
    if (!CK.on) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.3) { CK.on = true; try { deck.setPointerCapture(ev.pointerId); } catch (err) {} }
      else if (Math.abs(dy) > 10) { stop(); return; } else return;
    }
    CK.dx = dx;
    const track = document.getElementById("ckTrack");
    track.classList.add("still");
    track.style.transform = `translateX(calc(${-CHECKIN_AT} * (100% + 16px) + ${dx}px))`;
  };
  const up = () => {
    const was = CK.on, dx = CK.dx;
    stop();
    if (!was) return;
    if (dx < -70) ckGo(CHECKIN_AT + 1); else if (dx > 70) ckGo(CHECKIN_AT - 1); else ckPaint(true);
  };
  const stop = () => {
    deck.removeEventListener("pointermove", move); deck.removeEventListener("pointerup", up); deck.removeEventListener("pointercancel", up);
    CK.x0 = null; CK.on = false;
  };
  deck.addEventListener("pointermove", move); deck.addEventListener("pointerup", up); deck.addEventListener("pointercancel", up);
}
document.addEventListener("touchmove", e => { if (CK.on) e.preventDefault(); }, { passive: false });
document.addEventListener("keydown", e => {
  if (VIEW !== "checkins" || !CHECKIN_OPEN || panelUp() || /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement.tagName)) return;
  if (e.key === "ArrowRight") ckGo(CHECKIN_AT + 1);
  if (e.key === "ArrowLeft") ckGo(CHECKIN_AT - 1);
});
function saveCheckin(type) {
  const answers = {};
  if (type === "huddle") HUDDLE_FIELDS.forEach(([k]) => { answers[k] = document.getElementById("hud-" + k).value.trim(); });
  else COUPLES_QUESTIONS.forEach((_, i) => { answers["q" + i] = document.getElementById("cpl-q" + i).value.trim(); });
  clearDraft("fd_draft_" + type);
  slide("back", () => { CHECKIN_OPEN = null; render(); window.scrollTo(0, 0); });
  toast(`Saved: ${CHECKIN_KINDS[type].name}. See you next Sunday.`);
  send({ action: "saveCheckin", type, answers });
}
