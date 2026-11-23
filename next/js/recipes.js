// Recipes, from the Notion Recipes database (read by the Worker): browse and search them under
// Dinner, open one, cook it a step at a time, and add its ingredients to the grocery list.
// Read-only for now: ratings, favorites and planning a night come later (Stage 7c).
"use strict";

let DINNER_TAB = "week";  // "week" or "recipes"
let RECIPE_OPEN = null;   // the recipe being read, by id
const RECIPES = {
  list: null, at: 0, pagesLeft: 0, loading: null, failed: false,
  q: "", cat: "Dinner", on: new Set(),   // the search and the filter buttons
  ticked: {},                            // ingredients ticked off, by recipe: Set of indexes
  bodies: null,                          // recipe pages kept on this phone: { id: { edited, body } }
};
const RECIPE_CATS = [["Dinner", "Dinners"], ["Side", "Sides"], ["Dessert", "Desserts"], ["Breakfast", "Breakfast"], ["Lunch", "Lunch"], ["Snack", "Snacks"], ["", "Everything"]];
const RECIPE_FILTERS = [
  ["weeknight", "Weeknight", r => (r.method || []).includes("Weeknight")],
  ["quick", "Under 30 min", r => r.time > 0 && r.time <= 30],
  ["kids", "Kid approved", r => r.kid],
  ["fav", "Favorites", r => r.status === "Family Favorite"],
  ["tried", "Tried", r => r.status === "Tried" || r.status === "Family Favorite"],
  ["totry", "To try", r => r.status === "To Try"],
  ["family", "Family cookbook", r => !r.source || /family cookbook/i.test(r.notes || "")],
];
const PROTEINS = ["Chicken", "Beef", "Pork", "Fish", "Turkey", "Vegetarian"];
const RECIPE_CACHE_KEY = "fd_recipes", BODIES_KEY = "fd_recipe_pages", BODIES_KEPT = 40;

/* ----- the list: kept on this phone, so Recipes opens offline ----- */
function recipesKept() {
  if (RECIPES.list) return;
  try {
    const kept = JSON.parse(localStorage.getItem(RECIPE_CACHE_KEY) || "null");
    if (kept && Array.isArray(kept.list)) Object.assign(RECIPES, { list: kept.list, at: kept.at || 0, pagesLeft: kept.pagesLeft || 0 });
  } catch (e) {}
}
/* Fresh from the Worker when it's over half an hour old (or asked). */
function loadRecipes(force) {
  recipesKept();
  if (RECIPES.loading || (!force && RECIPES.list && Date.now() - RECIPES.at < 30 * 60000)) return RECIPES.loading;
  RECIPES.loading = apiGet("recipes").then(d => {
    if (!d || !d.ok) throw new Error((d && d.error) || "no answer");
    RECIPES.list = d.recipes || [];
    Object.assign(RECIPES, { at: Date.now(), pagesLeft: d.pagesLeft || 0, failed: false, off: d.on === false });
    try { localStorage.setItem(RECIPE_CACHE_KEY, JSON.stringify({ list: RECIPES.list, at: RECIPES.at, pagesLeft: RECIPES.pagesLeft })); } catch (e) {}
  }).catch(() => { RECIPES.failed = true; })
    .finally(() => {
      RECIPES.loading = null;
      if (VIEW === "meals" && DINNER_TAB === "recipes") { if (RECIPE_OPEN) render(); else paintResults(); }
    });
  return RECIPES.loading;
}
const recipeById = id => (RECIPES.list || []).find(r => r.id === id);

/* ----- Dinner's switch: This week · Recipes ----- */
function dinnerSwitch() {
  if (!fromNotion()) return "";
  return `<div class="segmented two dinner-switch" role="group" aria-label="Dinner">
    <button type="button" aria-pressed="${DINNER_TAB === "week"}" onclick="dinnerTab('week')">This week</button>
    <button type="button" aria-pressed="${DINNER_TAB === "recipes"}" onclick="dinnerTab('recipes')">Recipes</button></div>`;
}
function dinnerTab(tab) {
  if (tab === DINNER_TAB && !RECIPE_OPEN) return;
  slide(tab === "recipes" ? "forward" : "back", () => { DINNER_TAB = tab; RECIPE_OPEN = null; render(); window.scrollTo(0, 0); });
}

/* ----- browsing ----- */
function renderRecipes() {
  recipesKept();
  loadRecipes(false);
  if (RECIPE_OPEN) return renderRecipe(RECIPE_OPEN);
  const cats = RECIPE_CATS.map(([v, label]) =>
    `<button type="button" class="chipbtn" aria-pressed="${RECIPES.cat === v}" onclick="recipeCat('${v}')">${label}</button>`).join("");
  const toggles = RECIPE_FILTERS.map(([k, label]) => [k, label]).concat(PROTEINS.map(p => ["p:" + p, p])).map(([k, label]) =>
    `<button type="button" class="chipbtn" aria-pressed="${RECIPES.on.has(k)}" onclick="recipeToggle('${k}')">${esc(label)}</button>`).join("");
  return `${dinnerSwitch()}
    <div class="rsearch">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
      <input type="search" id="recipeQ" data-nodraft="1" value="${esc(RECIPES.q)}" placeholder="Search names and ingredients"
        aria-label="Search recipes" autocomplete="off" enterkeyhint="search" oninput="recipeSearch(this.value)">
    </div>
    <div class="chips scroll" role="group" aria-label="Kind">${cats}</div>
    <div class="chips scroll" role="group" aria-label="Filters">${toggles}</div>
    <div id="recipeResults">${resultsHtml()}</div>`;
}
function recipeMatches() {
  const words = RECIPES.q.toLowerCase().split(/\s+/).filter(Boolean);
  const proteins = [...RECIPES.on].filter(k => k.startsWith("p:")).map(k => k.slice(2));
  const checks = RECIPE_FILTERS.filter(f => RECIPES.on.has(f[0])).map(f => f[2]);
  const hits = [];
  (RECIPES.list || []).forEach(r => {
    if (RECIPES.cat && r.category !== RECIPES.cat) return;
    if (proteins.length && !proteins.includes(r.protein)) return;
    if (!checks.every(c => c(r))) return;
    let score = 0;
    if (words.length) {
      const name = r.name.toLowerCase(), rest = [r.words, r.protein, (r.cuisine || []).join(" "), (r.method || []).join(" "), r.notes].join(" ").toLowerCase();
      for (const w of words) {
        if (name.includes(w)) score += 2; else if (rest.includes(w)) score += 1; else return;
      }
    }
    hits.push([score, r]);
  });
  hits.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name));
  return hits.map(x => x[1]);
}
function resultsHtml() {
  const list = RECIPES.list;
  if (!list) {
    return RECIPES.failed ? `<div class="block"><div class="empty">The recipes couldn't be loaded. Pull down to try again.</div></div>`
      : `<div class="rloading" role="status"><span class="spin" aria-hidden="true"></span>Getting the recipes from Notion…</div>`;
  }
  if (!list.length) {
    return `<div class="block"><div class="empty">${RECIPES.off ? "Recipes come from Notion, which isn't connected." :
      "No recipes yet. The Hub reads them from Notion every few hours, so check back soon."}</div></div>`;
  }
  const hits = recipeMatches(), browsing = !RECIPES.q.trim() && !RECIPES.on.size;
  let h = "";
  if (browsing && RECIPES.cat === "Dinner") {
    const recent = list.filter(r => r.lastMade && r.category === "Dinner").sort((a, b) => b.lastMade.localeCompare(a.lastMade)).slice(0, 8);
    if (recent.length) {
      h += `<h2>Cooked lately</h2><div class="rcards" role="list">${recent.map(r =>
        `<button type="button" class="rcard" role="listitem" onclick="openRecipe('${esc(r.id)}')">${thumb(r, "big")}
          <span class="rc-name">${esc(r.name)}</span><span class="rc-meta">${esc(madeAgo(r.lastMade))}</span></button>`).join("")}</div>`;
    }
  }
  const label = RECIPES.cat ? (RECIPE_CATS.find(c => c[0] === RECIPES.cat) || [])[1] : "Recipes";
  h += `<h2>${browsing ? "All " + esc(label.toLowerCase()) : "Found"}<span class="hint"><span class="count">${hits.length}</span></span>
      ${hits.length > 1 ? `<button type="button" class="linkish" onclick="surpriseMe()">Surprise me</button>` : ""}</h2>`;
  h += hits.length ? `<div class="block rlist">${hits.map(recipeRow).join("")}</div>`
    : `<div class="block"><div class="empty">Nothing matches${RECIPES.q.trim() ? ` “${esc(RECIPES.q.trim())}”` : ""}. Try fewer filters.</div></div>`;
  if (RECIPES.pagesLeft) h += `<p class="tiny rnote">Still reading ${RECIPES.pagesLeft} recipe pages from Notion, so searching by ingredient will find more soon.</p>`;
  return h;
}
function paintResults() {
  const box = document.getElementById("recipeResults");
  if (box) box.innerHTML = resultsHtml();
}
function thumb(r, size) {
  const emoji = `<span class="rthumb-emoji" aria-hidden="true">${esc(r.emoji || "🍽️")}</span>`;
  return `<span class="rthumb ${size || ""}">${emoji}${r.img ? `<img src="${esc(r.img)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ""}</span>`;
}
function stars(n) { return n ? `<span class="rstars" aria-label="${n} of 5 stars">${"★".repeat(n)}<span aria-hidden="true">${"★".repeat(5 - n)}</span></span>` : ""; }
function recipeMeta(r) {
  return [r.time ? r.time + " min" : "", r.protein && r.protein !== "Other" ? r.protein : "", (r.method || [])[0] || ""].filter(Boolean).join(" · ");
}
function recipeRow(r) {
  return `<button type="button" class="rrow" onclick="openRecipe('${esc(r.id)}')">${thumb(r)}
    <span class="rr-text"><span class="rr-name">${esc(r.name)}</span>
      <span class="rr-meta">${esc(recipeMeta(r))}${r.status === "Family Favorite" ? ' <span class="rfav" aria-label="Family favorite">♥</span>' : ""}${r.kid ? ' <span class="rkid">Kids ✓</span>' : ""}</span></span>
    ${stars(r.rating)}</button>`;
}
function madeAgo(iso) {
  const days = Math.round((new Date(todayStr() + "T12:00:00") - new Date(iso + "T12:00:00")) / 86400000);
  return days <= 0 ? "Made today" : days === 1 ? "Made yesterday" : days < 14 ? `Made ${days} days ago` : `Made ${shortDate(iso)}`;
}
function recipeSearch(v) { RECIPES.q = v; paintResults(); }
function recipeCat(v) { RECIPES.cat = v; render(); }
function recipeToggle(k) { RECIPES.on.has(k) ? RECIPES.on.delete(k) : RECIPES.on.add(k); render(); }
/* A dinner from what's showing, leaning towards ones not made in the last month. */
function surpriseMe() {
  const hits = recipeMatches(), month = isoPlus(todayStr(), -30);
  const fresh = hits.filter(r => !r.lastMade || r.lastMade < month), pool = fresh.length ? fresh : hits;
  if (pool.length) openRecipe(pool[Math.floor(Math.random() * pool.length)].id);
}

/* ----- one recipe ----- */
function openRecipe(id) {
  const from = VIEW;
  slide("forward", () => {
    VIEW = "meals"; DINNER_TAB = "recipes"; RECIPE_OPEN = id;
    render(); window.scrollTo(0, 0);
    if (from !== "meals") announce(VIEWS.meals.title());
  });
  loadRecipeBody(id);
}
function closeRecipe() { slide("back", () => { RECIPE_OPEN = null; render(); window.scrollTo(0, 0); }); }
function keptBodies() {
  if (!RECIPES.bodies) { try { RECIPES.bodies = JSON.parse(localStorage.getItem(BODIES_KEY) || "{}") || {}; } catch (e) { RECIPES.bodies = {}; } }
  return RECIPES.bodies;
}
/* The recipe's page: from this phone if it's kept and current, and fresh from the Worker either way. */
async function loadRecipeBody(id) {
  const kept = keptBodies();
  try {
    const d = await hubFetch("/api?action=recipe&id=" + encodeURIComponent(id));
    if (d && d.ok && d.recipe) {
      delete kept[id]; // re-added last, so the most lately opened are the ones kept
      kept[id] = { edited: d.recipe.edited, body: d.recipe.body, info: d.recipe };
      const ids = Object.keys(kept);
      ids.slice(0, Math.max(0, ids.length - BODIES_KEPT)).forEach(k => delete kept[k]);
      try { localStorage.setItem(BODIES_KEY, JSON.stringify(kept)); } catch (e) {}
    } else if (!kept[id]) kept[id] = { failed: true };
  } catch (e) { if (!kept[id]) kept[id] = { failed: true }; }
  if (VIEW === "meals" && RECIPE_OPEN === id && !COOK) render();
}
function renderRecipe(id) {
  const kept = keptBodies()[id] || {}, r = recipeById(id) || kept.info;
  if (!r) return `${backToRecipes()}<div class="block"><div class="empty">${kept.failed ? "That recipe couldn't be found." : "Opening the recipe…"}</div></div>`;
  const b = kept.body;
  const facts = [r.time ? `<span><b>${r.time}</b> min</span>` : "", r.servings ? `<span>Serves <b>${r.servings}</b></span>` : "",
    r.cost ? `<span><b>$${r.cost.toFixed(2)}</b> a serving</span>` : ""].filter(Boolean).join("");
  const tags = [r.category, r.protein && r.protein !== "Other" ? r.protein : "", ...(r.method || []), ...(r.cuisine || [])].filter(Boolean);
  const from = b && b.facts && !r.source ? (/(?:^|·)\s*From:\s*([^·]+)/.exec(b.facts) || [])[1] : "";
  let h = `${backToRecipes()}
    <div class="rhero ${r.img ? "" : "noimg"}">${r.img ? `<img src="${esc(r.img)}" alt="" onerror="this.parentElement.classList.add('noimg');this.remove()">` : ""}
      <span class="rhero-emoji" aria-hidden="true">${esc(r.emoji || "🍽️")}</span></div>
    <h2 class="rtitle">${esc(r.name)}</h2>
    <div class="rbadges">${r.status ? `<span class="rbadge ${r.status === "Family Favorite" ? "fav" : r.status === "To Try" ? "try" : ""}">${r.status === "Family Favorite" ? "♥ " : ""}${esc(r.status)}</span>` : ""}
      ${r.kid ? `<span class="rbadge kid">Kid approved</span>` : ""}${stars(r.rating)}
      ${r.lastMade ? `<span class="tiny">${esc(madeAgo(r.lastMade))}</span>` : ""}</div>
    ${facts ? `<div class="rfacts">${facts}</div>` : ""}
    ${tags.length ? `<div class="rtags">${tags.map(t => `<span>${esc(t)}</span>`).join("")}</div>` : ""}`;
  if (b) {
    (b.about || []).forEach(p => { h += `<p class="rabout">${esc(p)}</p>`; });
    if (from) h += `<p class="muted">From ${esc(from.trim())}</p>`;
  }
  const hasSteps = b && (b.steps || []).some(s => s.t);
  h += `<div class="ractions">
    ${hasSteps ? `<button type="button" class="primary" onclick="startCooking('${esc(id)}')">Start cooking</button>` : ""}
    ${b && (b.ingredients || []).some(x => x.t) ? `<button type="button" class="ghost" onclick="openGroceryPick('${esc(id)}')">Add to groceries</button>` : ""}
  </div>
  <div class="rlinks">${r.source ? `<a class="recipe" href="${esc(r.source)}" target="_blank" rel="noopener">${esc(siteName(r.source))} ↗︎</a>` : ""}
    ${r.url ? `<a class="recipe" href="${esc(r.url)}" target="_blank" rel="noopener">Open in Notion ↗︎</a>` : ""}</div>`;
  if (!b) {
    h += kept.failed ? `<div class="block"><div class="empty">This recipe's page couldn't be read just now${r.url ? ", but it's in Notion" : ""}.</div></div>`
      : `<div class="rloading" role="status"><span class="spin" aria-hidden="true"></span>Reading the recipe…</div>`;
    return h;
  }
  h += ingredientsHtml(id, b);
  if (hasSteps) {
    h += `<h2>Steps</h2><ol class="rsteps">`;
    let n = 0;
    b.steps.forEach(s => {
      if (s.h) { h += `</ol><h3 class="rsub">${esc(s.h)}</h3><ol class="rsteps" start="${n + 1}" style="counter-reset: step ${n}">`; return; }
      n++;
      h += `<li>${s.lead ? `<b>${esc(s.lead)}</b> ` : ""}${esc(s.t)}</li>`;
    });
    h += `</ol>`;
  }
  const notes = (b.notes || []).slice();
  if (r.notes && !notes.some(x => x.t === r.notes)) notes.push({ t: r.notes });
  if (notes.length) h += `<h2>Notes</h2><ul class="rnotes">${notes.map(x => (x.h ? `<li class="h">${esc(x.h)}</li>` : `<li>${esc(x.t)}</li>`)).join("")}</ul>`;
  if (b.raw && b.raw.length) {
    h += `<h2>From the page</h2><div class="rraw">${b.raw.map(x => (x.h ? `<h3 class="rsub">${esc(x.h)}</h3>` : `<p>${x.list ? "• " : ""}${esc(x.t)}</p>`)).join("")}</div>
      <p class="tiny">This page doesn't use the usual Ingredients and Steps headings, so it's shown as written.</p>`;
  }
  return h;
}
function backToRecipes() {
  return `<button type="button" class="backlink" onclick="closeRecipe()"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>Recipes</button>`;
}
function siteName(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return "Original"; } }
/* Ingredients you can tick off as you go (on this phone, while it's open). */
function ingredientsHtml(id, b) {
  const items = b.ingredients || [];
  if (!items.some(x => x.t)) return "";
  const ticked = RECIPES.ticked[id] || new Set();
  return `<h2>Ingredients<span class="hint">${items.filter(x => x.t).length}</span></h2><div class="block ringr">${items.map((x, i) => x.h
    ? `<div class="rsub">${esc(x.h)}</div>`
    : `<div class="task ${ticked.has(i) ? "done" : ""}"><input type="checkbox" id="ing-${i}" ${ticked.has(i) ? "checked" : ""} onchange="tickIngredient('${esc(id)}', ${i}, this)">
        <label class="ttl" for="ing-${i}">${esc(x.t)}</label></div>`).join("")}</div>`;
}
function tickIngredient(id, i, box) {
  const s = RECIPES.ticked[id] || (RECIPES.ticked[id] = new Set());
  box.checked ? s.add(i) : s.delete(i);
  box.closest(".task").classList.toggle("done", box.checked);
}

/* ----- add to groceries: a checklist, with salt, oil and spices left unticked ----- */
const STAPLES = /\b((table|kosher|sea|flaky) )?salt\b|\b(black|ground|white) pepper\b|\bsalt and pepper\b|\b(olive|vegetable|canola|neutral|sesame|cooking|avocado) oil\b|^\s*(\d[^a-z]*)?oil\b|\bcooking spray\b|\bwater\b|\bice\b|\b(chili|garlic|onion|curry) powder\b|\b(ground )?(cumin|paprika|oregano|cinnamon|nutmeg|cayenne|turmeric|coriander|thyme|allspice|cloves)\b|\bbay lea|\bred pepper flakes\b|\bitalian seasoning\b|\bspices?\b|\bbaking (soda|powder)\b|\bvanilla\b/i;
const PREP = /^(chopped|diced|minced|sliced|trimmed|peeled|drained|cut|divided|grated|shredded|crushed|melted|softened|at room|finely|thinly|roughly|cubed|halved|quartered|rinsed|torn|beaten|patted|seeded|stemmed|cored|for |to taste|plus|optional|thawed|cooked|warmed|chilled|packed|lightly|well|juiced|zested|smashed)/i;
/* "10 oz cremini mushrooms, trimmed and sliced thin" → "10 oz cremini mushrooms" */
function groceryLine(text) {
  const parts = text.split(/,\s*/);
  let keep = parts[0];
  for (let i = 1; i < parts.length && !PREP.test(parts[i]); i++) keep += ", " + parts[i];
  return keep.replace(/\s*\((about|approx\.?|roughly)[^)]*\)/gi, "").trim();
}
function openGroceryPick(id) {
  const b = (keptBodies()[id] || {}).body, r = recipeById(id) || {};
  if (!b) return;
  const rows = b.ingredients.map((x, i) => x.h ? `<div class="rsub">${esc(x.h)}</div>`
    : `<label class="gp-row"><input type="checkbox" value="${i}" ${STAPLES.test(x.t) ? "" : "checked"} onchange="groceryPickCount()">
        <span>${esc(groceryLine(x.t))}</span></label>`).join("");
  overlayHtml(`<div class="tp-head"><h2 class="tp-title">Add to groceries</h2>
      <button type="button" class="icon-btn" onclick="closeOverlay()" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <p class="muted">From ${esc(r.name || "this recipe")}. Salt, oil and spices start unticked; tick anything you're out of.</p>
    <div class="gp-list" id="gpList">${rows}</div>
    <div class="actions"><button type="button" class="primary" id="gpAdd" onclick="addPicked('${esc(id)}')"></button>
      <button type="button" class="ghost" onclick="closeOverlay()">Cancel</button></div>`);
  groceryPickCount();
}
function groceryPickCount() {
  const n = document.querySelectorAll("#gpList input:checked").length, btn = document.getElementById("gpAdd");
  if (!btn) return;
  btn.textContent = n ? `Add ${n} to the list` : "Nothing ticked";
  btn.disabled = !n;
}
function addPicked(id) {
  const b = (keptBodies()[id] || {}).body;
  const lines = [...document.querySelectorAll("#gpList input:checked")].map(x => groceryLine(b.ingredients[Number(x.value)].t)).filter(Boolean);
  if (!lines.length) return;
  closeOverlay();
  lines.forEach((item, i) => DATA.groceries.push({ id: "tmp-" + Date.now() + "-" + i, item, done: false }));
  toast(`Added ${lines.length} to the grocery list`);
  send({ action: "addGroceries", text: lines.join("\n"), by: cfg.user });
}

/* ----- cooking: one step at a time, the screen kept awake ----- */
let COOK = null; // { id, at, steps, timer: { end, label, tick }, lock }
const TIME_RE = /(\d+(?:\.\d+)?)(?:\s*(?:–|-|to)\s*(\d+(?:\.\d+)?))?\s*(minutes?|mins?|hours?|hrs?)\b/i;
function startCooking(id) {
  const b = (keptBodies()[id] || {}).body, r = recipeById(id) || (keptBodies()[id] || {}).info || {};
  if (!b) return;
  const steps = [];
  let group = "";
  b.steps.forEach(s => { if (s.h) group = s.h; else steps.push(Object.assign({ group }, s)); });
  COOK = { id, name: r.name || "", at: 0, steps, timer: COOK && COOK.timer, lock: null };
  let el = document.getElementById("cook");
  if (!el) {
    el = document.createElement("div");
    el.id = "cook"; el.className = "cook"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true");
    document.body.appendChild(el);
    el.addEventListener("pointerdown", cookDown);
  }
  el.setAttribute("aria-label", "Cooking " + COOK.name);
  el.innerHTML = cookHtml();
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("up"));
  document.documentElement.classList.add("cooking");
  keepAwake();
  cookPaint(false);
  setTimeout(() => { const n = document.getElementById("cookNext"); if (n) n.focus({ preventScroll: true }); }, 50);
}
function cookHtml() {
  const n = COOK.steps.length;
  const cards = COOK.steps.map((s, i) => {
    const m = TIME_RE.exec(s.t || "");
    const timer = m ? `<button type="button" class="ck-timer" onclick="startTimer(${i})">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/></svg>
        Timer · ${esc(m[1])}${/^h/i.test(m[3]) ? (m[1] === "1" ? " hour" : " hours") : " min"}</button>` : "";
    return `<section class="cook-card" aria-label="Step ${i + 1} of ${n}">
      ${s.group ? `<div class="cook-group">${esc(s.group)}</div>` : ""}
      <div class="cook-num">Step ${i + 1}</div>
      ${s.lead ? `<p class="cook-lead">${esc(s.lead)}</p>` : ""}<p class="cook-text">${esc(s.t)}</p>${timer}</section>`;
  }).join("") + `<section class="cook-card done" aria-label="Done"><div class="cook-num">All done</div>
      <p class="cook-lead">Enjoy ${esc(COOK.name)}.</p>
      <button type="button" class="primary" onclick="stopCooking()">Back to the recipe</button></section>`;
  return `<div class="cook-top">
      <button type="button" class="icon-btn" onclick="stopCooking()" aria-label="Stop cooking"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <div class="cook-name">${esc(COOK.name)}</div>
      <button type="button" class="chipbtn" onclick="cookIngredients()">Ingredients</button>
    </div>
    <div class="cook-bar"><span id="cookFill"></span></div>
    <div class="cook-timer" id="cookTimer" role="timer" hidden></div>
    <div class="cook-deck"><div class="cook-track" id="cookTrack">${cards}</div></div>
    <div class="cook-nav">
      <button type="button" class="ghost" id="cookPrev" onclick="cookGo(COOK.at - 1)">Back</button>
      <span class="cook-count" id="cookCount" aria-live="polite"></span>
      <button type="button" class="primary" id="cookNext" onclick="cookGo(COOK.at + 1)">Next</button>
    </div>`;
}
function cookPaint(animate) {
  if (!COOK) return;
  const n = COOK.steps.length, track = document.getElementById("cookTrack");
  track.classList.toggle("still", !animate || calm());
  track.style.transform = `translateX(calc(${-COOK.at} * (100% + 16px)))`;
  [...track.children].forEach((c, i) => { c.inert = i !== COOK.at; });
  document.getElementById("cookFill").style.width = (Math.min(COOK.at + 1, n) / n * 100) + "%";
  document.getElementById("cookCount").textContent = COOK.at < n ? `${COOK.at + 1} of ${n}` : "Done";
  document.getElementById("cookPrev").disabled = COOK.at === 0;
  document.getElementById("cookNext").hidden = COOK.at >= n;
  document.getElementById("cookNext").textContent = COOK.at === n - 1 ? "Finish" : "Next";
}
function cookGo(i) {
  if (!COOK) return;
  COOK.at = Math.max(0, Math.min(COOK.steps.length, i));
  cookPaint(true);
}
function stopCooking() {
  const el = document.getElementById("cook");
  if (el) { el.classList.remove("up"); setTimeout(() => { if (!COOK) el.hidden = true; }, calm() ? 0 : 320); }
  document.documentElement.classList.remove("cooking");
  if (COOK && COOK.lock) { try { COOK.lock.release(); } catch (e) {} }
  const timer = COOK && COOK.timer;
  COOK = null;
  if (timer) { clearInterval(timer.tick); toast("The timer was stopped"); }
  render();
}
/* The screen stays on while cooking (where the phone allows it), and again after switching back. */
async function keepAwake() {
  if (!COOK || !navigator.wakeLock || document.visibilityState !== "visible") return;
  try { COOK.lock = await navigator.wakeLock.request("screen"); } catch (e) {}
}
document.addEventListener("visibilitychange", () => { if (COOK && document.visibilityState === "visible") keepAwake(); });
function cookIngredients() {
  const b = (keptBodies()[COOK.id] || {}).body;
  overlayHtml(`<div class="tp-head"><h2 class="tp-title">Ingredients</h2>
    <button type="button" class="icon-btn" onclick="closeOverlay()" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    ${ingredientsHtml(COOK.id, b).replace(/^<h2>[\s\S]*?<\/h2>/, "")}`);
}
/* A timer for the step that names one: counts down at the top, and buzzes when it's done. */
function startTimer(i) {
  const m = TIME_RE.exec(COOK.steps[i].t), mins = Number(m[1]) * (/^h/i.test(m[3]) ? 60 : 1);
  if (COOK.timer) clearInterval(COOK.timer.tick);
  const t = COOK.timer = { end: Date.now() + mins * 60000, label: "Step " + (i + 1) };
  const paint = () => {
    const el = document.getElementById("cookTimer");
    const left = Math.max(0, Math.round((t.end - Date.now()) / 1000));
    if (el) {
      el.hidden = false;
      el.innerHTML = `<span>${esc(t.label)}</span><b>${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}</b>
        <button type="button" class="linkish" onclick="cancelTimer()">Cancel</button>`;
    }
    if (!left) {
      clearInterval(t.tick);
      if (COOK) COOK.timer = null;
      if (el) el.classList.add("rang");
      try { navigator.vibrate && navigator.vibrate([300, 150, 300, 150, 300]); } catch (e) {}
      beep();
      toast(`${t.label}: time's up`);
      setTimeout(() => { if (el) { el.hidden = true; el.classList.remove("rang"); } }, 6000);
    }
  };
  t.tick = setInterval(paint, 1000);
  paint();
}
function cancelTimer() {
  if (!COOK || !COOK.timer) return;
  clearInterval(COOK.timer.tick); COOK.timer = null;
  document.getElementById("cookTimer").hidden = true;
}
function beep() {
  try {
    const A = window.AudioContext || window.webkitAudioContext, ctx = new A();
    [0, 0.45, 0.9].forEach(at => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.35);
      o.start(ctx.currentTime + at); o.stop(ctx.currentTime + at + 0.4);
    });
  } catch (e) {}
}
/* Swipe between steps, as on the check-in cards. */
const COOKSWIPE = { x0: null, on: false, dx: 0 };
function cookDown(e) {
  if (!e.target.closest(".cook-deck") || e.target.closest("button") || (e.button && e.button > 0)) return;
  Object.assign(COOKSWIPE, { x0: e.clientX, y0: e.clientY, dx: 0, on: false, pid: e.pointerId });
  const deck = e.target.closest(".cook-deck"), track = document.getElementById("cookTrack");
  const move = ev => {
    if (ev.pointerId !== COOKSWIPE.pid) return;
    const dx = ev.clientX - COOKSWIPE.x0, dy = ev.clientY - COOKSWIPE.y0;
    if (!COOKSWIPE.on) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.3) { COOKSWIPE.on = true; try { deck.setPointerCapture(ev.pointerId); } catch (err) {} }
      else if (Math.abs(dy) > 10) { stop(); return; } else return;
    }
    COOKSWIPE.dx = dx;
    track.classList.add("still");
    track.style.transform = `translateX(calc(${-COOK.at} * (100% + 16px) + ${dx}px))`;
  };
  const up = () => {
    const was = COOKSWIPE.on, dx = COOKSWIPE.dx;
    stop();
    if (!was) return;
    if (dx < -60) cookGo(COOK.at + 1); else if (dx > 60) cookGo(COOK.at - 1); else cookPaint(true);
  };
  const stop = () => {
    deck.removeEventListener("pointermove", move); deck.removeEventListener("pointerup", up); deck.removeEventListener("pointercancel", up);
    COOKSWIPE.on = false;
  };
  deck.addEventListener("pointermove", move); deck.addEventListener("pointerup", up); deck.addEventListener("pointercancel", up);
}
document.addEventListener("touchmove", e => { if (COOKSWIPE.on) e.preventDefault(); }, { passive: false });
document.addEventListener("keydown", e => {
  if (!COOK || panelUp() || e.defaultPrevented) return; // Escape on the ingredients panel closes just that
  if (e.key === "ArrowRight") cookGo(COOK.at + 1);
  else if (e.key === "ArrowLeft") cookGo(COOK.at - 1);
  else if (e.key === "Escape") stopCooking();
});

/* ----- tonight's (or any night's) recipe, from Today and This week ----- */
function dayRecipes(day) { return ((DATA.mealsFrom && DATA.mealsFrom.recipes) || {})[day] || []; }
function openRecipeButtons(day) {
  return dayRecipes(day).map((id, i, all) => `<button type="button" class="recipe open-recipe" onclick="openRecipe('${esc(id)}')">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 5v16M8 7h7"/></svg>${all.length > 1 ? "Recipe " + (i + 1) : "Recipe"}</button>`).join("");
}
