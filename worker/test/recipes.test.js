// Recipes from Notion: pages parsed the way they're laid out, the list and pages read
// a few at a time, photos through signed links, and who may read them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHub, MfResponse } from "./harness.js";
import { parseRecipe, ingredientWords } from "../hub/recipes.js";

// ---- Notion's blocks, as its API gives them ----
const t = (s, bold) => ({ plain_text: s, annotations: { bold: !!bold } });
const blk = (type, ...rich) => ({ type, [type]: { rich_text: rich } });
const para = (...r) => blk("paragraph", ...r), todo = s => blk("to_do", t(s)), num = (...r) => blk("numbered_list_item", ...r);
const bullet = s => blk("bulleted_list_item", t(s)), h2 = s => blk("heading_2", t(s));

const POT_PIE = [
  para(t("Classic chicken pot pie filling under a crumbly Parmesan-biscuit topping.")),
  para(t("Time:", true), t(" 105 min · "), t("Serves:", true), t(" 6 · "), t("From:", true), t(" America's Test Kitchen")),
  h2("Ingredients"),
  para(t("Filling", true)),
  todo("1½ lb boneless, skinless chicken breasts and/or thighs"),
  todo("3 cups low-sodium chicken broth"),
  todo("10 oz cremini mushrooms, trimmed and sliced thin"),
  para(t("Crumble topping", true)),
  todo("2 cups (10 oz) all-purpose flour"),
  todo("1 oz Parmesan cheese, finely grated (about ½ cup)"),
  h2("Steps"),
  num(t("Poach the chicken.", true), t(" Put the chicken and broth in a Dutch oven, cover, and bring to a simmer.")),
  num(t("Move the chicken to a large bowl.")),
  num(t("Make the topping.", true), t(" Whisk together the flour, baking powder, salt, pepper, and cayenne.")),
  h2("Notes"),
  bullet("Pre-baking the crumble is what keeps it crunchy."),
];
const DIVAN = [
  para(t("Broccoli and chicken casserole in a lemony cream-of-chicken and mayo sauce.")),
  para(t("Time:", true), t(" about 1¼ hours · "), t("From:", true), t(" Susan (family cookbook, 02/15/10)")),
  h2("Ingredients"),
  todo("2 boxes frozen chopped broccoli"),
  todo("4 boneless, skinless chicken breasts"),
  todo("1 sleeve Ritz crackers, crushed"),
  h2("Steps"),
  num(t("Thaw the broccoli and cover the bottom of a Pyrex dish.")),
  num(t("Bake at 350°F for 45 minutes.")),
];
const CHILI = [
  para(t("Three-bean chili with corn and fire-roasted green chiles.")),
  h2("Ingredients"),
  para(t("Chili", true)), todo("2 Tbsp olive oil"), todo("1 (15 oz) can black beans, drained and rinsed"),
  para(t("Seasonings", true)), todo("1 Tbsp chili powder"), todo("2 tsp ground cumin"),
  h2("Steps"),
  num(t("Dice the onion and pepper and mince the garlic.")),
  num(t("Add the beans and corn, cover, and simmer 20 to 25 minutes.")),
  h2("Notes"),
  bullet("Works in a slow cooker."),
];
const ODD = [para(t("Mix it all up.")), bullet("A handful of this"), bullet("Some of that")]; // no headings

test("a recipe page parses the way it's laid out in Notion", () => {
  assert.deepEqual(parseRecipe(POT_PIE), {
    about: ["Classic chicken pot pie filling under a crumbly Parmesan-biscuit topping."],
    facts: "Time: 105 min · Serves: 6 · From: America's Test Kitchen",
    ingredients: [
      { h: "Filling" },
      { t: "1½ lb boneless, skinless chicken breasts and/or thighs" },
      { t: "3 cups low-sodium chicken broth" },
      { t: "10 oz cremini mushrooms, trimmed and sliced thin" },
      { h: "Crumble topping" },
      { t: "2 cups (10 oz) all-purpose flour" },
      { t: "1 oz Parmesan cheese, finely grated (about ½ cup)" },
    ],
    steps: [
      { lead: "Poach the chicken.", t: "Put the chicken and broth in a Dutch oven, cover, and bring to a simmer." },
      { t: "Move the chicken to a large bowl." },
      { lead: "Make the topping.", t: "Whisk together the flour, baking powder, salt, pepper, and cayenne." },
    ],
    notes: [{ t: "Pre-baking the crumble is what keeps it crunchy." }],
  });
  const divan = parseRecipe(DIVAN);
  assert.equal(divan.facts, "Time: about 1¼ hours · From: Susan (family cookbook, 02/15/10)");
  assert.deepEqual(divan.ingredients.map(x => x.t), ["2 boxes frozen chopped broccoli", "4 boneless, skinless chicken breasts", "1 sleeve Ritz crackers, crushed"]);
  assert.deepEqual(divan.steps, [{ t: "Thaw the broccoli and cover the bottom of a Pyrex dish." }, { t: "Bake at 350°F for 45 minutes." }]);
  assert.deepEqual(divan.notes, []);
  const chili = parseRecipe(CHILI);
  assert.deepEqual(chili.ingredients.filter(x => x.h).map(x => x.h), ["Chili", "Seasonings"]);
  assert.equal(chili.steps.length, 2);
  assert.equal(chili.raw, undefined, "a page that follows the layout has no raw text");
});

test("checkbox ingredients under their own headings, with no Ingredients heading (Poutine)", () => {
  const h2s = s => blk("heading_2", t(s));
  const poutine = parseRecipe([
    para(t("Not an everyday meal, but a favorite.")),
    para(t("Serves:", true), t(" 2 as a main · "), t("Cost:", true), t(" $7 total")),
    h2s("Fries"), todo("2 to 3 medium russet potatoes, sliced into sticks"), todo("2 tbsp vegetable oil"),
    h2s("Gravy"), todo("2 tbsp butter"), todo("1½ cups vegetable broth"),
    h2s("Steps"), num(t("Heat the oven to 400°F.")), num(t("Bake 20 minutes.")),
  ]);
  assert.deepEqual(poutine.about, ["Not an everyday meal, but a favorite."]);
  assert.deepEqual(poutine.ingredients, [{ h: "Fries" }, { t: "2 to 3 medium russet potatoes, sliced into sticks" }, { t: "2 tbsp vegetable oil" },
    { h: "Gravy" }, { t: "2 tbsp butter" }, { t: "1½ cups vegetable broth" }]);
  assert.equal(poutine.steps.length, 2);
  assert.ok(ingredientWords(poutine).includes("potatoes"));
  // An idea collection (checkboxes, no steps) is still shown as written
  const ideas = parseRecipe([h2s("Sweet"), todo("Peanut butter and banana"), h2s("Savory"), todo("Egg and chili crisp")]);
  assert.deepEqual([ideas.ingredients, ideas.raw.length], [[], 4]);
});

test("a page that doesn't follow the layout keeps its text as written", () => {
  const odd = parseRecipe(ODD);
  assert.deepEqual(odd.raw, [{ t: "Mix it all up." }, { t: "A handful of this", list: "bulleted_list_item" }, { t: "Some of that", list: "bulleted_list_item" }]);
  assert.deepEqual([odd.ingredients, odd.steps], [[], []]);
});

test("ingredient words leave out amounts and kitchen words", () => {
  const w = ingredientWords(parseRecipe(POT_PIE)).split(" ");
  for (const want of ["chicken", "broth", "cremini", "mushrooms", "flour", "parmesan", "cheese"]) assert.ok(w.includes(want), want);
  for (const not of ["cups", "oz", "sliced", "thin", "about"]) assert.ok(!w.includes(not), not);
});

// ---- the Worker ----
const page = (id, name, extra) => Object.assign({
  object: "page", id, url: "https://www.notion.so/" + id, last_edited_time: "2026-11-10T00:00:00.000Z",
  icon: { type: "emoji", emoji: "🍲" }, cover: null,
  properties: {
    Recipe: { title: [{ plain_text: name }] }, Category: { select: { name: "Dinner" } }, Protein: { select: { name: "Chicken" } },
    Method: { multi_select: [{ name: "Weeknight" }] }, Cuisine: { multi_select: [] }, Status: { select: { name: "Tried" } },
    Rating: { select: { name: "4 ⭐" } }, "Total Time (min)": { number: 40 }, Servings: { number: 6 }, "Cost per Serving": { number: 1.65 },
    "Cost per Recipe": { number: 9.93 }, "Kid Approved": { checkbox: true }, "Last Made": { date: { start: "2026-11-07" } },
    Source: { url: "https://www.budgetbytes.com/x/" }, Photo: { files: [] }, Notes: { rich_text: [] },
  },
}, extra || {});
const notion = {
  recipes: [
    page("potpie", "Chicken Pot Pie", { cover: { type: "external", external: { url: "https://img.example/potpie.jpg" } } }),
    page("divan", "Chicken Divan"),
    page("chili", "Vegetarian Chili"),
    page("odd", "Grandma's Mystery Salad"),
  ],
  blocks: { potpie: POT_PIE, divan: DIVAN, chili: CHILI, odd: ODD },
  reads: [],   // the pages whose blocks were read
  queries: 0, photos: 0, dinners: [], patched: [], made: [],
};
notion.recipes[1].properties.Photo = { files: [{ type: "file", name: "divan.jpeg", file: { url: "https://files.notion.example/divan.jpeg?sig=1" } }] };
notion.recipes[1].properties.Source = { url: null };

let h, jon, kid;
const at = async when => { await h.mf.setOptions(Object.assign({}, h.options, { bindings: Object.assign({}, h.options.bindings, { TEST_NOW: when }) })); };
const tick = async when => { if (when) await at(when); await (await h.mf.getWorker()).scheduled({ cron: "*/5 * * * *" }); };
const get = async (q, token) => (await h.get("/api?" + q, token === undefined ? jon : token)).json();

before(async () => {
  h = await startHub({ TEST_NOW: "2026-11-23T15:01:00Z", NOTION_TOKEN: "ntok", NOTION_MEALS_SOURCE: "meals-src" });
  h.site = async (request, url) => {
    if (url.host === "api.notion.com") {
      const path = url.pathname.replace("/v1", "");
      if (request.method === "GET" && path === "/data_sources/meals-src")
        return MfResponse.json({ properties: { Recipe: { type: "relation", relation: { data_source_id: "recipes-src" } } } });
      if (path === "/data_sources/meals-src/query") return MfResponse.json({ results: notion.dinners });
      if (path === "/data_sources/recipes-src/query") { // two at a time, to read every page of the answer
        notion.queries++;
        const body = JSON.parse(await request.text()), from = Number(body.start_cursor || 0);
        const more = from + 2 < notion.recipes.length;
        return MfResponse.json({ results: notion.recipes.slice(from, from + 2), has_more: more, next_cursor: more ? String(from + 2) : null });
      }
      const m = /^\/blocks\/([^/]+)\/children$/.exec(path);
      if (m) { notion.reads.push(m[1]); return MfResponse.json({ results: notion.blocks[m[1]] || [para(t("Just a note."))], has_more: false }); }
      const pg = /^\/pages\/([^/]+)$/.exec(path);
      if (pg && request.method === "PATCH") { // a write: only the columns sent change
        const body = JSON.parse(await request.text()), r = notion.recipes.find(x => x.id === pg[1]);
        if (notion.refuse) return MfResponse.json({ message: "Insufficient permissions for this endpoint." }, { status: 403 });
        notion.patched.push({ id: pg[1], properties: body.properties });
        Object.assign(r.properties, body.properties);
        r.last_edited_time = "2026-11-24T12:00:00.000Z";
        return MfResponse.json(r);
      }
      if (pg) return MfResponse.json(notion.recipes.find(r => r.id === pg[1]) || {});
      if (path === "/pages" && request.method === "POST") {
        const body = JSON.parse(await request.text());
        notion.made.push(body);
        const props = JSON.parse(JSON.stringify(body.properties)); // as Notion gives it back: its text as plain_text
        props.Meal.title.forEach(t => { t.plain_text = t.text.content; });
        notion.dinners.push({ properties: props }); // the meal plan now has it
        return MfResponse.json({ id: "new-page" });
      }
    }
    if (url.host === "img.example" || url.host === "files.notion.example") {
      notion.photos++;
      return new MfResponse(new Uint8Array([0xff, 0xd8, 0xff, notion.photos]), { headers: { "Content-Type": "image/jpeg" } });
    }
  };
  jon = await h.signIn("jon@example.com", "Jon");
  kid = await h.signIn("clayton@example.com", "Clayton");
});
after(() => h.mf.dispose());

test("before the timer has run, the list is empty but answers", async () => {
  const d = await get("action=recipes");
  assert.deepEqual([d.ok, d.on, d.recipes], [true, true, []]);
});

test("the timer reads the list (every page of it) and the recipe pages", async () => {
  await tick();
  assert.equal(notion.queries, 2, "four recipes, two to an answer");
  assert.deepEqual(notion.reads.slice().sort(), ["chili", "divan", "odd", "potpie"]);
  const d = await get("action=recipes");
  assert.deepEqual(d.recipes.map(r => r.name), ["Chicken Divan", "Chicken Pot Pie", "Grandma's Mystery Salad", "Vegetarian Chili"]);
  assert.equal(d.pagesLeft, 0);
  const pie = d.recipes.find(r => r.id === "potpie");
  assert.deepEqual([pie.emoji, pie.category, pie.protein, pie.method, pie.status, pie.rating, pie.time, pie.servings, pie.cost, pie.kid, pie.lastMade],
    ["🍲", "Dinner", "Chicken", ["Weeknight"], "Tried", 4, 40, 6, 1.65, true, "2026-11-07"]);
  assert.equal(pie.photo, undefined, "the photo's address isn't sent");
  assert.match(pie.img, /^https:\/\/hub\.example\/recipe-photo\?id=potpie&e=\d+&s=[\w-]+$/);
  assert.ok(pie.words.includes("mushrooms"), "its ingredients can be searched");
  assert.equal(d.recipes.find(r => r.id === "odd").img, undefined, "no photo, no link");

  // Kids may read recipes too
  assert.equal((await get("action=recipes", kid)).recipes.length, 4);
  // but not without signing in
  assert.equal((await h.get("/api?action=recipes")).status, 401);
});

test("one recipe comes with its page", async () => {
  const d = await get("action=recipe&id=potpie");
  assert.equal(d.ok, true);
  assert.deepEqual(d.recipe.body, parseRecipe(POT_PIE));
  assert.equal(d.recipe.name, "Chicken Pot Pie");
  assert.deepEqual(await get("action=recipe&id=nope"), { ok: false, error: "not_found" });
});

test("photos come through signed links, and are kept", async () => {
  const d = await get("action=recipes");
  const pie = d.recipes.find(r => r.id === "potpie").img, divan = d.recipes.find(r => r.id === "divan").img;
  const path = u => u.replace("https://hub.example", "");
  let res = await h.call(path(pie));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "image/jpeg");
  assert.match(res.headers.get("Cache-Control"), /max-age=604800/);
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())].slice(0, 3), [0xff, 0xd8, 0xff]);
  const fetched = notion.photos;
  assert.equal((await h.call(path(pie))).status, 200);
  assert.equal(notion.photos, fetched, "the second time it's the kept copy");

  // A photo kept in Notion: its link is fetched fresh
  res = await h.call(path(divan));
  assert.equal(res.status, 200);
  assert.equal(notion.photos, fetched + 1);

  // A changed signature, or another recipe's, is refused
  assert.equal((await h.call(path(pie).replace(/s=[\w-]+/, "s=AAAA"))).status, 403);
  assert.equal((await h.call(path(pie).replace("id=potpie", "id=divan"))).status, 403);
  // and so is a link past its date
  await at("2027-01-30T12:00:00Z");
  assert.equal((await h.call(path(pie))).status, 403);
  await at("2026-11-23T15:01:00Z");
});

test("six hours on, only an edited page is read again", async () => {
  notion.reads.length = 0;
  await tick("2026-11-23T15:06:00Z");
  assert.deepEqual(notion.reads, [], "nothing new to read");
  assert.equal(notion.queries, 2, "the list isn't read again so soon");
  notion.recipes[2].last_edited_time = "2026-11-23T16:00:00.000Z";
  await tick("2026-11-23T21:06:00Z");
  assert.equal(notion.queries, 4);
  assert.deepEqual(notion.reads, ["chili"]);
});

test("a long list is read a few pages each run", async () => {
  for (let i = 0; i < 30; i++) notion.recipes.push(page("extra" + i, "Extra " + String(i).padStart(2, "0")));
  notion.reads.length = 0;
  const q = notion.queries;
  await tick("2026-11-24T03:06:00Z");
  const listRequests = notion.queries - q; // 34 recipes, two to an answer: 17
  assert.equal(listRequests, 17);
  assert.equal(notion.reads.length, 0, "the list used this run's requests");
  await tick("2026-11-24T03:11:00Z");
  assert.equal(notion.reads.length, 15, "fifteen pages a run");
  assert.equal((await get("action=recipes")).pagesLeft, 15);
  await tick("2026-11-24T03:16:00Z");
  assert.equal(notion.reads.length, 30);
  assert.equal((await get("action=recipes")).pagesLeft, 0);
});

test("a recipe opened before its page is read is read right then", async () => {
  notion.recipes.push(page("fresh", "Fresh One"));
  notion.blocks.fresh = DIVAN;
  await tick("2026-11-24T09:06:00Z"); // the list (18 requests) leaves nothing for pages this run
  notion.reads.length = 0;
  const d = await get("action=recipe&id=fresh");
  assert.deepEqual([d.ok, d.recipe.body.steps.length, notion.reads], [true, 2, ["fresh"]]);
});

test("the week's dinners carry their recipes", async () => {
  notion.dinners = [{ properties: {
    Date: { date: { start: "2026-11-23" } }, Meal: { title: [{ plain_text: "Chicken Pot Pie" }] },
    "Meal Type": { select: { name: "Dinner" } }, Recipe: { relation: [{ id: "potpie" }] } } }];
  await tick("2026-11-24T09:15:00Z"); // the dinners run on the other five minutes
  const d = await get("action=all");
  assert.deepEqual(d.mealsFrom.recipes, { "2026-11-23": ["potpie"] });
  assert.match(d.meals.Mon.meal, /^Chicken Pot Pie \| https:\/\/www\.budgetbytes\.com\/x\/$/);
});

// ---- 7c: writing back to Notion, a parent only ----
const post = async (body, token) => (await h.post("/api", body, token === undefined ? jon : token)).json();

test("only a parent may rate, favorite or plan", async () => {
  for (const action of ["rateRecipe", "favoriteRecipe", "planRecipe"]) {
    assert.deepEqual(await post({ action, id: "potpie", stars: 5, on: true, date: "2026-11-26" }, kid), { ok: false, error: "parents_only" }, action);
  }
  assert.equal(notion.patched.length + notion.made.length, 0, "nothing reached Notion");
});

test("How was it? fills Rating, Status, Kid Approved and Last Made, and nothing else", async () => {
  notion.recipes.find(r => r.id === "divan").properties["Kid Approved"] = { checkbox: false };
  notion.recipes.find(r => r.id === "divan").properties.Status = { select: { name: "To Try" } };
  await tick("2026-11-24T15:07:00Z"); // the list read again (six hours on), with those
  const d = await post({ action: "rateRecipe", id: "divan", stars: 4, favorite: false, kids: true, date: "2026-11-23" });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.deepEqual(notion.patched.at(-1), { id: "divan", properties: {
    Rating: { select: { name: "4 ⭐" } }, Status: { select: { name: "Tried" } },
    "Kid Approved": { checkbox: true }, "Last Made": { date: { start: "2026-11-23" } } } });
  assert.deepEqual([d.recipe.rating, d.recipe.status, d.recipe.kid, d.recipe.lastMade], [4, "Tried", true, "2026-11-23"]);
  // The list's copy changed at once, and the page isn't read again for it
  notion.reads.length = 0;
  const listed = (await get("action=recipes")).recipes.find(r => r.id === "divan");
  assert.deepEqual([listed.rating, listed.status, listed.lastMade], [4, "Tried", "2026-11-23"]);
  await tick("2026-11-24T15:12:00Z");
  assert.ok(!notion.reads.includes("divan"), "the page text didn't change, so it isn't read again");

  // Family favorite; "the kids didn't like it" never un-ticks Kid Approved; an older night doesn't move Last Made back
  await post({ action: "rateRecipe", id: "divan", stars: 5, favorite: true, kids: false, date: "2026-11-20" });
  assert.deepEqual(notion.patched.at(-1).properties, { Rating: { select: { name: "5 ⭐" } }, Status: { select: { name: "Family Favorite" } } });
  assert.deepEqual(await post({ action: "rateRecipe", id: "divan", stars: 9 }), { ok: false, error: "bad_stars" });
  assert.deepEqual(await post({ action: "rateRecipe", id: "divan", stars: 3, date: "2026-12-30" }), { ok: false, error: "bad_date" });
});

test("the heart sets Family Favorite, and takes it off again", async () => {
  let d = await post({ action: "favoriteRecipe", id: "chili", on: true });
  assert.deepEqual([d.ok, d.recipe.status, notion.patched.at(-1)], [true, "Family Favorite", { id: "chili", properties: { Status: { select: { name: "Family Favorite" } } } }]);
  d = await post({ action: "favoriteRecipe", id: "chili", on: false });
  assert.deepEqual([d.recipe.status, notion.patched.at(-1).properties], ["Tried", { Status: { select: { name: "Tried" } } }]);
  const n = notion.patched.length;
  await post({ action: "favoriteRecipe", id: "chili", on: false });
  assert.equal(notion.patched.length, n, "no change, no write");
});

test("Plan it adds a night to the meal plan, and the week shows it at once", async () => {
  const d = await post({ action: "planRecipe", id: "chili", date: "2026-11-26", who: "Maggie" });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.deepEqual(notion.made.at(-1), {
    parent: { type: "data_source_id", data_source_id: "meals-src" },
    properties: {
      Meal: { title: [{ type: "text", text: { content: "Vegetarian Chili" } }] }, Date: { date: { start: "2026-11-26" } },
      "Meal Type": { select: { name: "Dinner" } }, Status: { select: { name: "Planned" } },
      Recipe: { relation: [{ id: "chili" }] }, "Who Cooks": { select: { name: "Maggie" } },
    },
  });
  assert.equal(d.meals.Thu.meal.split(" | ")[0], "Vegetarian Chili");
  assert.equal(d.meals.Thu.note, "Maggie cooks");
  assert.deepEqual(d.mealsFrom.recipes["2026-11-26"], ["chili"]);
  assert.deepEqual(await post({ action: "planRecipe", id: "chili", date: "2026-11-01" }), { ok: false, error: "bad_date" });
});

test("when Notion refuses a write, the Hub is told why", async () => {
  notion.refuse = true;
  const d = await post({ action: "favoriteRecipe", id: "potpie", on: true });
  notion.refuse = false;
  assert.deepEqual([d.ok, d.error], [false, "notion"]);
  assert.match(d.message, /Notion 403: Insufficient permissions/);
});
