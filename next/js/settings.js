// Sign-in, Settings, the calendar connection, devices and notifications.
"use strict";

/* A device that isn't signed in sees only this. */
function showSetup() {
  overlayHtml(`
    <header><span class="eyebrow">Harper Family Hub</span><h1>Sign in</h1>
      <div class="subtitle">Once per device. It's remembered after that.</div></header>
    <div id="signinBox"></div>`);
  renderSignin();
}
function openSettings() {
  if (!cfg.signedIn) { showSetup(); return; }
  overlayHtml(`
    <header><span class="eyebrow">Settings</span></header>
    <h2>Look &amp; feel<span class="hint">on this device</span></h2>
    <div id="lookBox">${lookHtml()}</div>
    <div id="signinBox"></div>
    <div class="actions"><button class="primary" onclick="closeOverlay()">Done</button></div>
    <div class="tiny" style="margin-top:var(--space-5)">Data refreshes every 60 seconds and whenever the app is reopened.</div>
    <h2>Todoist<span class="hint">on this device</span></h2>
    <div id="remBox"><div class="block">${remSettingsHtml()}</div></div>
    <h2>Notifications<span class="hint">for ${esc(cfg.user)}</span></h2>
    <div id="notifyBox"><div class="empty">Loading…</div></div>`);
  renderSignin();
  loadNotify();
}

/* ----- Look & feel: the theme and light/dark, kept on this device (js/theme.js) ----- */
const THEME_SWATCH = {
  fridge:    { light: ["#f3f0e8", "#1b1b1f", "#ffffff", "#1f7a52", "#c8461f", "#2f5fcc"],
               dark:  ["#101114", "#f3f3f6", "#1c1e23", "#6fd3a2", "#ffa586", "#9db8ff"], weight: 800,
               font: '"Bricolage Grotesque", sans-serif' },
  evergreen: { light: ["#eef1ea", "#17201b", "#ffffff", "#2f5d46", "#a8456a", "#3e6e9e"],
               dark:  ["#0e1411", "#eaf0ea", "#18201b", "#86c29e", "#e79ab0", "#8db6dd"], weight: 700,
               font: '"Schibsted Grotesk", sans-serif' },
  journal:   { light: ["#f4eee4", "#2a211c", "#fbf8f2", "#a44c2b", "#a04f4a", "#3f5f86"],
               dark:  ["#1b1613", "#f2eadf", "#252019", "#e8957a", "#e5a3a0", "#9fb8d6"], weight: 600,
               font: 'Fraunces, Georgia, serif' },
};
/* Each card shows its theme's own lettering, so the other themes' fonts load once Settings opens
   (and only then: an everyday open loads just the chosen theme's fonts). */
function loadPreviewFonts() {
  if (document.getElementById("previewFonts")) return;
  const link = document.createElement("link");
  link.id = "previewFonts";
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?" + Object.values(THEMES).map(t => t.fonts).join("&") + "&display=swap";
  document.head.appendChild(link);
}
function lookHtml() {
  loadPreviewFonts();
  const { theme, scheme } = themeChoice();
  const shade = document.documentElement.dataset.scheme === "dark" ? "dark" : "light";
  const cards = Object.keys(THEMES).map(k => {
    const sw = THEME_SWATCH[k], [bg, ink, card, ...dots] = sw[shade];
    return `<button type="button" class="themecard" aria-pressed="${k === theme}" onclick="pickLook('${k}', null)"
        style="background:${bg};color:${ink}">
      <span class="tc-face" style="font-family:${esc(sw.font)};font-weight:${sw.weight}">Aa</span>
      <span class="tc-dots">${dots.map(c => `<span style="background:${c}"></span>`).join("")}</span>
      <span class="tc-name" style="background:${card}">${esc(THEMES[k].name)}</span>
    </button>`;
  }).join("");
  const modes = [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]].map(([k, label]) =>
    `<button type="button" aria-pressed="${k === scheme}" onclick="pickLook(null, '${k}')">${label}</button>`).join("");
  return `<div class="themecards" role="group" aria-label="Theme">${cards}</div>
    <div class="segmented" role="group" aria-label="Light or dark">${modes}</div>
    <div class="tiny" style="margin-top:var(--space-2)">Auto follows your phone's light or dark setting.</div>`;
}
function pickLook(theme, scheme) {
  setTheme(theme, scheme);
  const box = document.getElementById("lookBox");
  if (box) box.innerHTML = lookHtml();
}

/* ============ sign-in ============
   A device asks the Hub's Worker for a sign-in and is given a short code. It is
   approved either by signing in with Google in the page the button opens, or by
   a parent typing the code into their own Hub. This device just keeps asking
   whether it's been approved, so nothing has to come back from Google's page. */
let SIGNIN = null;      // the sign-in this device is waiting on: { hub, secret, id, code, until, google }
let SIGNIN_POLL = null;
const signinShowing = () => !!document.getElementById("signinBox") && !document.getElementById("overlay").classList.contains("hidden");

function loadSignin() {
  if (!SIGNIN) { try { SIGNIN = JSON.parse(localStorage.getItem("fd_signin") || "null"); } catch (e) {} }
  if (SIGNIN && (SIGNIN.until < Date.now() || SIGNIN.hub !== cfg.hub)) dropSignin();
  return SIGNIN;
}
function dropSignin() {
  SIGNIN = null;
  localStorage.removeItem("fd_signin");
  clearInterval(SIGNIN_POLL); SIGNIN_POLL = null;
}
function deviceName() {
  const m = /iPhone|iPad|Android|Macintosh|Windows/.exec(navigator.userAgent);
  return m ? m[0].replace("Macintosh", "Mac") : "Browser";
}

async function renderSignin(msg) {
  const box = document.getElementById("signinBox");
  if (!box) return;
  if (cfg.signedIn) { box.innerHTML = signedInHtml(); loadDevices(); loadCalendar(); return; }
  if (!cfg.hub) {
    box.innerHTML = `<div class="tiny">This copy of the Hub doesn't know where its Worker is. Paste the Worker's address.</div>
      <div class="addrow" style="margin-top:var(--space-2)">
        <input type="url" id="setHub" class="grow" placeholder="https://family-hub-push.….workers.dev" data-nodraft="1">
        <button class="ghost" onclick="saveHub()">Use it</button>
      </div>`;
    return;
  }
  if (!loadSignin()) {
    box.innerHTML = `<div class="empty">Getting a sign-in code…</div>`;
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const secret = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
      const id = Array.from(hash, b => b.toString(16).padStart(2, "0")).join("");
      const d = await hubFetch("/auth/begin", { id, device: deviceName() });
      if (!d.ok) throw new Error(d.error);
      SIGNIN = { hub: cfg.hub, secret, id, code: d.code, google: d.google, until: Date.now() + (d.minutes || 10) * 60000 };
      localStorage.setItem("fd_signin", JSON.stringify(SIGNIN));
    } catch (e) {
      box.innerHTML = `<div class="empty">Couldn't reach the Hub's Worker to sign in.</div>
        <div class="actions"><button class="ghost" onclick="renderSignin()">Try again</button>
        ${HUB ? "" : `<button class="ghost" onclick="saveHub('')">Change its address</button>`}</div>`;
      return;
    }
  }
  if (!document.getElementById("signinBox") || cfg.signedIn) return; // Settings was redrawn meanwhile
  const google = SIGNIN.google
    ? `<div class="actions" style="margin-top:0"><a class="primary" target="_blank" rel="noopener"
         href="${esc(SIGNIN.hub)}/auth/google?d=${SIGNIN.id}">Sign in with Google</a></div>
       <div class="tiny" style="margin-top:var(--space-3)">Google will show this code. Check it matches before you tap Sign in there.</div>`
    : `<div class="tiny">Google sign-in isn't set up on the Hub's Worker yet. A parent who is signed in can still use this code.</div>`;
  document.getElementById("signinBox").innerHTML = `${google}
    <div class="signcode" aria-label="Sign-in code">${esc(SIGNIN.code)}</div>
    <div class="tiny">No Google account? A parent can sign this device in from their own Hub: ⚙, then Sign in another device, with this code.</div>
    <div class="tiny" id="signinMsg" role="status" style="margin-top:var(--space-2)">${esc(msg || "This finishes by itself once the sign-in is approved.")}</div>`;
  if (!SIGNIN_POLL) SIGNIN_POLL = setInterval(pollSignin, 2500);
}

/* Asks whether the sign-in has been approved. Also run when the app comes back to the front. */
async function pollSignin() {
  if (!loadSignin()) {
    clearInterval(SIGNIN_POLL); SIGNIN_POLL = null;
    // A new code only while someone is looking at the old one.
    if (signinShowing() && !cfg.signedIn && cfg.hub) renderSignin("That code ran out. Here's a new one.");
    return;
  }
  if (document.visibilityState !== "visible") return;
  let d;
  try { d = await hubFetch("/auth/poll", { secret: SIGNIN.secret }); } catch (e) { return; }
  if (d.ok && d.status === "done") {
    dropSignin();
    localStorage.setItem("fd_token", d.token);
    localStorage.setItem("fd_user", d.person);
    localStorage.removeItem("fd_push_sync"); // this device's notifications now belong to the person signed in
    note("Signed in as " + d.person);
    if (signinShowing()) { if (document.getElementById("notifyBox")) openSettings(); else closeOverlay(); }
    refresh(true);
    syncPush();
  } else if (d.ok && d.status === "expired") {
    dropSignin();
    if (signinShowing()) renderSignin("That code ran out. Here's a new one.");
  }
}

function saveHub(value) {
  const v = value != null ? value : document.getElementById("setHub").value.trim();
  if (v && !/^https:\/\//.test(v)) { alert("The address starts with https://"); return; }
  if (v) localStorage.setItem("fd_hub", v); else localStorage.removeItem("fd_hub");
  dropSignin();
  renderSignin();
}

function signedInHtml() {
  const parent = ["Jon", "Maggie"].includes(cfg.user);
  const who = [cfg.user, "Clayton", "Heidi"];
  return `<div class="sheet"><span class="marker team">Signed in</span>
      <div class="muted">This device is ${esc(cfg.user)}'s.</div>
      <div class="actions"><button class="ghost" onclick="signOut()">Sign out</button></div></div>
    ${parent ? `<h2>Sign in another device<span class="hint">for someone with no Google account</span></h2>
    <div class="tiny">On that device, open the Hub. Type the code it shows here.</div>
    <div class="addrow" style="margin-top:var(--space-2)">
      <input type="text" id="apCode" inputmode="numeric" maxlength="4" placeholder="Code" aria-label="Sign-in code" style="width:104px" data-nodraft="1">
      <select id="apWho" aria-label="Whose device">${who.map(p => `<option>${p}</option>`).join("")}</select>
      <button class="ghost" onclick="approveDevice()">Sign it in</button>
    </div>
    <div class="tiny" id="apMsg" role="status" style="margin-top:var(--space-2)"></div>
    <h2>Signed-in devices</h2>
    <div id="devBox"><div class="empty">Loading…</div></div>
    <h2>Calendar<span class="hint">read from Google</span></h2>
    <div id="calBox"><div class="empty">Loading…</div></div>` : ""}`;
}

/* A parent lets the Hub read the family's Google calendars, once. As with sign-in,
   Google's page opens beside the Hub and this just keeps asking whether it's done. */
let CAL_POLL = null;
async function loadCalendar(msg) {
  const box = document.getElementById("calBox");
  if (!box) return;
  clearInterval(CAL_POLL); CAL_POLL = null;
  try {
    const d = await hubFetch("/auth/calendar");
    if (!d.ok) throw new Error(d.error);
    if (d.connected) {
      const bad = Object.keys(d.errors || {});
      const when = d.readAt ? "Last read " + new Date(d.readAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + "." : "It will be read within five minutes.";
      box.innerHTML = `<div class="sheet"><span class="marker ${bad.length ? "scheduled" : "team"}">${bad.length ? "Check" : "Connected"}</span>
        <div class="muted">${esc((d.calendars || []).join(", ") || "No calendars are set up on the Worker yet")}. ${esc(when)}</div>
        ${bad.map(k => `<div class="tiny" style="color:var(--warn);margin-top:var(--space-2)">${esc(k === "all" ? "Google" : k)}: ${esc(d.errors[k])}</div>`).join("")}
        <div class="actions"><button class="ghost" onclick="disconnectCalendar()">Disconnect</button></div>
        <div class="tiny" role="status" style="margin-top:var(--space-2)">${esc(msg || "")}</div></div>`;
      return;
    }
    const b = await hubFetch("/auth/calendar/begin", {});
    if (!b.ok) throw new Error(b.error);
    box.innerHTML = `<div class="tiny">Lets the Hub read your Google calendars (it can't change them). Use your own Google account.</div>
      <div class="actions"><a class="primary" target="_blank" rel="noopener" href="${esc(b.url)}">Connect the calendar</a></div>
      <div class="tiny" role="status" style="margin-top:var(--space-2)">${esc(msg || "This finishes by itself once Google's page is done.")}</div>`;
    const until = Date.now() + (b.minutes || 10) * 60000;
    CAL_POLL = setInterval(async () => {
      if (!document.getElementById("calBox") || document.getElementById("overlay").classList.contains("hidden")) { clearInterval(CAL_POLL); CAL_POLL = null; return; }
      if (Date.now() > until) { loadCalendar("That link ran out. Here's a new one."); return; }
      if (document.visibilityState !== "visible") return;
      try { const s = await hubFetch("/auth/calendar"); if (s.ok && s.connected) loadCalendar("Connected ✓"); } catch (e) {}
    }, 3000);
  } catch (e) {
    box.innerHTML = `<div class="empty">Couldn't load the calendar's connection.</div>`;
  }
}
async function disconnectCalendar() {
  if (!confirm("Stop the Hub reading your Google calendars?")) return;
  try { await hubFetch("/auth/calendar/disconnect", {}); } catch (e) {}
  loadCalendar();
}

async function approveDevice() {
  const code = document.getElementById("apCode").value.trim(), person = document.getElementById("apWho").value;
  if (!/^\d{4}$/.test(code)) { say("apMsg", "The code is four digits."); return; }
  say("apMsg", "Signing it in…");
  try {
    const d = await hubFetch("/auth/approve", { code, person });
    if (d.ok) { document.getElementById("apCode").value = ""; setTimeout(loadDevices, 4000); }
    say("apMsg", d.ok ? `Done ✓ — that device is now ${person}'s. It finishes within a few seconds.`
      : d.error === "no_such_code" ? "No device is showing that code. Codes last ten minutes." : "Couldn't sign it in (" + d.error + ").");
  } catch (e) { say("apMsg", "Couldn't sign it in — offline?"); }
}

async function loadDevices() {
  const box = document.getElementById("devBox");
  if (!box) return;
  const day = ms => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
  try {
    const d = await hubFetch("/auth/devices");
    if (!d.ok) throw new Error(d.error);
    box.innerHTML = `<div class="block">${d.devices.map(v => `<div class="nrow"><div class="addrow">
      <div class="grow"><div style="font-weight:500">${esc(v.person)}${v.device ? " · " + esc(v.device) : ""}${v.here ? " (this one)" : ""}</div>
        <div class="tiny">Signed in ${day(v.addedAt)}${v.by && v.by !== v.person ? " by " + esc(v.by) : ""} · last used ${day(v.lastSeen)}</div></div>
      ${v.here ? "" : `<button class="ghost" onclick="signOut('${esc(v.id)}')">Sign out</button>`}
    </div></div>`).join("")}</div>`;
  } catch (e) {
    box.innerHTML = `<div class="empty">Couldn't load the devices.</div>`;
  }
}

/* Signs this device out, or (a parent) the device named. */
async function signOut(device) {
  if (device) {
    if (!confirm("Sign that device out? It will need signing in again.")) return;
    try { await hubFetch("/auth/signout", { device }); } catch (e) {}
    loadDevices();
    return;
  }
  if (!confirm("Sign this device out?")) return;
  try { await hubFetch("/auth/signout", {}); } catch (e) {}
  localStorage.removeItem("fd_token");
  localStorage.removeItem("fd_push_sync");
  closeOverlay();
  refresh(); // back to sign-in
}

/* ============ notifications ============ */
let NOTIFY = null; // { publicKey, ready, lastTick, parents, prefs, devices } from the server
const NOTIFY_ROWS = [
  ["summary", "Morning summary", "Your to-dos, the kids', today's calendar and dinner", "time"], // Jon's adds his Todoist tasks
  ["dinner", "Dinner nudge", "Only if tonight's dinner isn't planned", "time"],
  ["huddle", "Family Huddle reminder", "Skipped once this week's huddle is saved", "day"],
  ["couples", "Weekly Check-In reminder", "Skipped once this week's check-in is saved", "day"],
  ["assigned", "New to-dos", "When someone adds one for you or the family", ""],
  ["meals", "Meal plan ready", "Once every day has a dinner and the plan has sat unchanged for 10 minutes", ""],
];

async function loadNotify() {
  const box = document.getElementById("notifyBox");
  try {
    const d = await apiGet("notify");
    if (!d.ok) throw new Error(d.error);
    NOTIFY = d;
  } catch (e) {
    box.innerHTML = `<div class="empty">Couldn't load notification settings — offline?</div>`;
    return;
  }
  if (!NOTIFY.prefs) {
    box.innerHTML = `<div class="empty">Couldn't load notification settings.</div>`;
    return;
  }
  const p = NOTIFY.prefs[cfg.user];
  const time = (k, f, label) => `<input type="time" id="n-${k}-${f}" value="${esc(p[k][f])}" aria-label="${esc(label)}">`;
  const rows = NOTIFY_ROWS.filter(([k]) => k !== "couples" || NOTIFY.parents.includes(cfg.user)).map(([k, label, hint, when]) => {
    const day = when === "day" ? `<select id="n-${k}-day" aria-label="${esc(label)} day">${DAYS.map(d =>
      `<option ${d === p[k].day ? "selected" : ""}>${d}</option>`).join("")}</select>` : "";
    if (k === "summary" && cfg.user === "Jon") hint = hint.replace(" and dinner", ", dinner and your Todoist tasks");
    return `<div class="nrow">
      <label class="ncheck"><input type="checkbox" id="n-${k}-on" ${p[k].on ? "checked" : ""}>
        <span class="ttl">${label}<span class="tiny">${hint}</span></span></label>
      ${when ? `<div class="nwhen">${day}${time(k, "at", label + " time")}</div>` : ""}
    </div>`;
  }).join("");
  box.innerHTML = `<div class="sheet" id="pushState"><div class="muted">Checking this device…</div></div>
    <div class="block">${rows}
      <div class="nrow">
        <label class="ncheck"><input type="checkbox" id="n-quiet-on" ${p.quiet.on ? "checked" : ""}>
          <span class="ttl">Quiet hours<span class="tiny">New to-do and meal-plan alerts wait until quiet hours end. Reminders still come at the times you set above.</span></span></label>
        <div class="nwhen">${time("quiet", "from", "Quiet hours start")}<span class="muted">to</span>${time("quiet", "to", "Quiet hours end")}</div>
      </div>
    </div>
    <div class="actions">
      <button class="primary" onclick="saveNotifyPrefs()">Save notification settings</button>
      <span class="tiny" id="prefsMsg" role="status"></span>
    </div>`;
  renderPushState();
}

async function pushStatus() {
  if (!NOTIFY.ready) return "server";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

async function renderPushState(msg) {
  const el = document.getElementById("pushState");
  if (!el) return;
  const state = await pushStatus();
  const text = {
    server: "Notifications aren't set up on the Hub's Worker yet: it needs its push keys (worker/README.md in the repo).",
    unsupported: "Notifications need the Home Screen app. Open Family Hub from its Home Screen icon (iPhone: iOS 16.4 or later) and come back here.",
    blocked: "Notifications are blocked for Family Hub. Turn them on in the iPhone's Settings → Notifications → Family Hub, then come back here.",
    off: "Off on this device.",
    on: "On for this device.",
  }[state];
  const buttons = {
    off: `<button class="primary" onclick="enablePush()">Turn on notifications</button>`,
    on: `<button class="ghost" onclick="sendTestPush()">Send a test</button>
         <button class="ghost" onclick="disablePush()">Turn off here</button>`,
  }[state] || "";
  const stale = state === "on" && (!NOTIFY.lastTick || Date.now() - NOTIFY.lastTick > 30 * 60000)
    ? `<div class="tiny" style="color:var(--warn);margin-top:var(--space-2)">Scheduled reminders haven't run in the last half hour. Check the Hub's Worker in Cloudflare.</div>` : "";
  el.innerHTML = `<span class="marker ${state === "on" ? "team" : "scheduled"}">${state === "on" ? "On" : "Off"}</span>
    <div class="muted">${text}</div>${stale}
    ${buttons ? `<div class="actions">${buttons}</div>` : ""}
    <div class="tiny" id="pushMsg" role="status" style="margin-top:var(--space-2)">${esc(msg || "")}</div>`;
}

function say(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

function b64uBytes(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function enablePush() {
  try {
    // Must be the first await: iOS only asks from a direct tap.
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { renderPushState(); return; }
    say("pushMsg", "Turning on…");
    const reg = await navigator.serviceWorker.ready;
    const key = b64uBytes(NOTIFY.publicKey);
    let sub = await reg.pushManager.getSubscription();
    const oldKey = sub && sub.options && sub.options.applicationServerKey;
    if (sub && oldKey && new Uint8Array(oldKey).join() !== key.join()) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const d = await apiPost({ action: "pushSubscribe", person: cfg.user, subscription: sub.toJSON() });
    if (!d.ok) throw new Error(d.error);
    localStorage.setItem("fd_push_sync", cfg.user + "|" + todayStr());
    renderPushState("Turned on ✓ — try Send a test.");
  } catch (e) {
    say("pushMsg", "Couldn't turn on notifications (" + e.message + ").");
  }
}

async function sendTestPush() {
  say("pushMsg", "Sending…");
  try {
    const d = await apiPost({ action: "pushTest", person: cfg.user });
    const s = d.sent || {};
    say("pushMsg", s.delivered ? `Sent to ${s.delivered} device${s.delivered > 1 ? "s" : ""} ✓`
      : "Didn't send — " + (s.error || "no devices signed up"));
  } catch (e) { say("pushMsg", "Couldn't send — offline?"); }
}

async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await apiPost({ action: "pushUnsubscribe", endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
    localStorage.removeItem("fd_push_sync");
    renderPushState("Turned off for this device.");
  } catch (e) { say("pushMsg", "Couldn't turn off (" + e.message + ")."); }
}

async function saveNotifyPrefs() {
  const p = JSON.parse(JSON.stringify(NOTIFY.prefs[cfg.user]));
  Object.keys(p).forEach(k => {
    const on = document.getElementById(`n-${k}-on`);
    if (on) p[k].on = on.checked;
    ["at", "day", "from", "to"].forEach(f => {
      const el = document.getElementById(`n-${k}-${f}`);
      if (el && el.value) p[k][f] = el.value.slice(0, 5);
    });
  });
  say("prefsMsg", "Saving…");
  try {
    const d = await apiPost({ action: "savePrefs", person: cfg.user, prefs: p });
    if (!d.ok) throw new Error(d.error);
    NOTIFY.prefs[cfg.user] = d.prefs;
    say("prefsMsg", "Saved ✓");
  } catch (e) { say("prefsMsg", "Couldn't save — " + (e.message || "offline?")); }
}

/* Re-register this device once a day (and when its person changes), so the
   server's list stays current even if a subscription rotates. */
async function syncPush() {
  try {
    if (!cfg.signedIn || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (Notification.permission !== "granted") return;
    const key = cfg.user + "|" + todayStr();
    if (localStorage.getItem("fd_push_sync") === key) return;
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (!sub) return;
    const d = await apiPost({ action: "pushSubscribe", person: cfg.user, subscription: sub.toJSON() });
    if (d.ok) localStorage.setItem("fd_push_sync", key);
  } catch (e) {}
}

/* A tapped notification opens the screen it's about. */
function openFromNotification(d) {
  if (!d || !VIEWS[d.view]) return;
  closeOverlay();
  if (d.checkin === "huddle" || d.checkin === "couples") CHECKIN_OPEN = d.checkin;
  go(d.view);
}
