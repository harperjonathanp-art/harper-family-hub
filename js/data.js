// Sign-in state, talking to the Hub's Worker, and drafts that survive a refresh.
"use strict";

/* ============ state ============ */
const FAMILY = ["Jon", "Maggie", "Clayton", "Heidi", "Family"];
const RECURS = ["once", "daily", "weekly", "monthly", "quarterly", "yearly"];
const RECUR_LABEL = { once: "One-off", daily: "Daily", weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" };
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Mirrored in worker/hub/notion.js (CHECKINS_QUESTIONS) for the Notion copy: change both together.
const HUDDLE_FIELDS = [
  ["rose",  "Rose / Thorn / Bud", "Everyone shares a high, a low, and something they're looking forward to"],
  ["week",  "Week ahead", "Calendar Captain walks the week — practices, events, lunch menu peek"],
  ["chores","Home team check", "How did chores go? Any trades for this week?"],
  ["fun",   "Fun pick", "Fun Picker chooses one family thing for the week"],
  ["grat",  "Gratitude & prayer", "Close with one gratitude each"]
];
const COUPLES_QUESTIONS = [
  "What are you grateful for and appreciate about me this week?",
  "What brought you joy this week?",
  "What is something that was hard this week?",
  "What is one thing I can do for you this week?",
  "Is there any unconfessed sin, conflict, or hurt that we need to resolve and/or seek forgiveness for?",
  "What is a dream, craving, or desire that has been on the forefront of your mind?",
  "How can I pray for you this week?"
];

let DATA = { tasks: [], meals: {}, events: [], checkins: [], groceries: [] };
let VIEW = "today";
let POLL = null;

// The Hub's Worker: where a device signs in, and where it gets and saves everything
// (see worker/README.md). It is a public address; what it serves is behind the sign-in.
const HUB = "https://family-hub-push.harper-jonathan-p.workers.dev";

const cfg = {
  get user()  { return localStorage.getItem("fd_user") || "Jon"; }, // who this device was signed in as
  get hub()   { return (localStorage.getItem("fd_hub") || HUB || "").replace(/\/+$/, ""); }, // fd_hub: one device pointed elsewhere, for testing
  get token() { return localStorage.getItem("fd_token") || ""; },   // set once this device has signed in
  get signedIn() { return !!(this.hub && this.token); },
};

/* ============ networking ============ */
async function apiGet(action, withReminders) {
  return hubFetch("/api?action=" + (action || "all") + (withReminders ? "&reminders=1" : ""));
}
async function apiPost(body) {
  return hubFetch("/api", body);
}
/* Everything goes through the Hub's Worker, which knows who a device is from its token. */
async function hubFetch(path, body) {
  const r = await fetch(cfg.hub + path, {
    method: body ? "POST" : "GET",
    headers: cfg.token ? { Authorization: "Bearer " + cfg.token } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json();
  // Signed out from another device: this one forgets its token and asks to sign in again.
  if (r.status === 401 && d.error === "signed_out") localStorage.removeItem("fd_token");
  return d;
}
const SYNC_ERRORS = {
  signed_out: "Signed out — sign in again",
  no_database: "The Hub's Worker isn't set up yet",
};

async function refresh(quiet, asked) {
  if (!cfg.signedIn) { showSetup(); return; }
  if (!quiet) note("Syncing…");
  try {
    const d = await apiGet("all", REM.show);
    if (!d.ok) {
      note(SYNC_ERRORS[d.error] || "Sync error");
      if (!cfg.signedIn) showSetup(); // signed out from another device
      return;
    }
    DATA = { tasks: d.tasks || [], meals: d.meals || {}, events: d.events || [], checkins: d.checkins || [],
             groceries: d.groceries,
             mealsFrom: d.mealsFrom, // set when the dinners come from the Notion meal plan
             reminders: REM.show ? keepGoodReminders(d.reminders) : undefined }; // never kept on a device that hides them
    localStorage.setItem("fd_cache", JSON.stringify(DATA));
    note(asked ? "Updated just now" : "Updated " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    if (asked && VIEW === "meals" && DINNER_TAB === "recipes") loadRecipes(true); // pulled down on Recipes: those too
    flushNotionWrites(); // recipe changes saved on this phone while Notion couldn't be reached
    if (hasUnsavedEdits()) { note("Synced — your unsaved edits are kept"); return; }
    render();
  } catch (e) {
    note("Offline — showing last saved");
  }
}

async function send(body) {
  note("Saving…");
  try {
    const d = await apiPost(body);
    if (d.ok) {
      DATA.tasks = d.tasks || DATA.tasks;
      DATA.meals = d.meals || DATA.meals;
      DATA.checkins = d.checkins || DATA.checkins;
      DATA.groceries = d.groceries || DATA.groceries; // a settings answer carries no list
      localStorage.setItem("fd_cache", JSON.stringify(DATA));
      note("Saved ✓");
    } else { note("Save failed"); }
  } catch (e) { note("Save failed — offline?"); }
  render();
}

/* The sync pill in the header. Every message about saving and syncing comes through here, and the
   pill shows what it means: busy ("Syncing…", "Saving…"), fine ("Up to date"), or a problem, which
   says so in words. The time of the last good sync stays in its label. Tapping it syncs now. */
const SYNC = { at: 0, glow: 0 };
function note(t) {
  const pill = document.getElementById("syncNote");
  if (!pill) return;
  const busy = /…$/.test(t), bad = !busy && /fail|offline|error|isn't set up|signed out/i.test(t);
  let text = t;
  if (!busy && !bad) {
    SYNC.at = Date.now();
    text = /just now/.test(t) ? "Updated just now" : "Up to date";
    clearTimeout(SYNC.glow);
    if (/just now/.test(t)) SYNC.glow = setTimeout(() => {
      if (pill.dataset.state !== "fresh") return;
      pill.dataset.state = "ok"; pill.querySelector(".txt").textContent = "Up to date";
    }, 4000);
  } else if (/^offline/i.test(t) && SYNC.at) {
    text = "Offline · showing " + new Date(SYNC.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  pill.dataset.state = busy ? "busy" : bad ? "bad" : /just now/.test(text) ? "fresh" : "ok";
  pill.querySelector(".txt").textContent = text;
  const at = SYNC.at ? " Last synced " + new Date(SYNC.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + "." : "";
  pill.setAttribute("aria-label", `${text}.${at} Tap to sync now.`);
}

/* ============ drafts (survive refreshes & app switches) ============ */
function draftKey() {
  if (VIEW === "meals") return "fd_draft_meals";
  if (VIEW === "checkins" && CHECKIN_OPEN) return "fd_draft_" + CHECKIN_OPEN;
  return null;
}
function saveDraft(e) {
  // Only typed text is a draft: not the grocery box, and not ticking a checkbox.
  if (e && e.target && (e.target.type === "checkbox" || (e.target.dataset && e.target.dataset.nodraft))) return;
  const key = draftKey(); if (!key) return;
  const d = {};
  document.querySelectorAll("#main input[type=text], #main textarea, #main select").forEach(el => { if (el.id && !el.dataset.nodraft) d[el.id] = el.value; });
  if (Object.values(d).some(v => v && v.trim && v.trim())) localStorage.setItem(key, JSON.stringify(d));
  else localStorage.removeItem(key);
}
function restoreDraft() {
  const key = draftKey(); if (!key) return;
  let d = {}; try { d = JSON.parse(localStorage.getItem(key) || "{}"); } catch (e) {}
  Object.entries(d).forEach(([id, v]) => { const el = document.getElementById(id); if (el && v) el.value = v; });
}
function clearDraft(key) { localStorage.removeItem(key); }
function hasUnsavedEdits() {
  if (DRAG || TD) return true; // mid-drag: a background refresh would pull the row out from under the finger
  const key = draftKey();
  if (!key) return false;
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest("#main") &&
      /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return true;
  return !!localStorage.getItem(key);
}
