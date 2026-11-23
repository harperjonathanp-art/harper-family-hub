# The Hub's Worker

The Hub's whole backend: one Cloudflare Worker, `family-hub-push`, with a D1
database. Cloudflare deploys it from this repo on every push to `main`
(`wrangler.jsonc` at the repo root; Workers Builds). The page it serves data to
is `index.html`, on GitHub Pages.

| Path | File | What it does |
|------|------|--------------|
| `/auth/…` | `auth.js` | Sign-in: with Google, or by a parent's say-so |
| `/auth/calendar…` | `calendar-auth.js` | A parent letting the Hub read the Google calendars |
| `/api` | `api.js` | What a signed-in Hub asks for and saves |
| | `groceries.js` | The grocery list |
| | `hub/core.js` | Tasks, repeats, subtasks, dinners, check-ins |
| | `hub/notify.js` | Notifications: what to send, to whom, and when |
| | `hub/todoist.js` | Jon's Todoist tasks, read-only |
| | `hub/notion.js` | Dinners in from Notion; check-ins out to Notion |
| | `hub/recipes.js` | The Recipes database: `?action=recipes` (the list) and `?action=recipe&id=…` (one, with its page); and, for a parent only, three writes back to Notion: `rateRecipe` (Rating, Status, Kid Approved, Last Made), `favoriteRecipe` (Status) and `planRecipe` (a Dinner row in the meal plan, linked to the recipe). A write changes only those columns, never a page's text. The Notion integration needs *Update content* and *Insert content* |
| `/recipe-photo` | `hub/recipes.js` | A recipe's photo, by a signed link the list gives (an `<img>` can't carry the sign-in) |
| | `hub/calendar.js` | The next 14 days of the family's Google calendars |
| | `hub/api.js` | The requests and the timer that tie those together |
| | `hub/time.js` | What day and time it is at home (a Worker runs on UTC) |
| | `store.js` | Where the rows are kept, and how two savers at once are kept apart |
| | `push.js`, `webpush.js` | Sending notifications to phones |
| every 5 min | `index.js` → `hub/api.js` | The timer |

## How sign-in works

A device asks the Worker for a sign-in and is shown a four-digit code that
lasts ten minutes. It is approved in one of two ways:

- **With Google.** *Sign in with Google* opens the Worker's page, which hands
  over to Google. Google says which account it is; if that account is in
  `FAMILY_ACCOUNTS`, a confirm page shows the same code and a **Sign in**
  button. A parent's account can sign the device in as themselves or as either
  child. A child's account signs in only as that child.
- **By a parent.** A parent who is already signed in opens ⚙ → *Sign in
  another device* on their own Hub, types the code and picks whose device it
  is. For anyone without a Google account.

The device keeps asking the Worker whether it has been approved, so nothing
has to come back from Google's page to the Hub. That is what makes it work in
an iPhone Home Screen app, where pop-ups and redirects often don't.

Once approved, the device holds a token of its own. The Worker stores only a
hash of it. A parent sees every signed-in device in Settings and can sign any
of them out. Who ticked a task or added one comes from the sign-in, not from
what the page says.

Two things go only to a parent's device: the Jon & Maggie check-ins, and Jon's
Todoist tasks.

## The timer

Every five minutes (`triggers` in `wrangler.jsonc`). Each job stands alone, so
one failing doesn't stop the rest.

| How often | What |
|-----------|------|
| every run | The calendar's events are read from Google; then whatever notifications are due are sent |
| every 10 min | Todoist is read; the week's dinners are read from Notion |
| every 30 min | New check-ins are copied to Notion |
| every run | Recipes: the list is read every 6 hours, and up to 15 requests' worth of recipe pages each run (new or edited ones), so the first full read takes a few hours |
| once a day | Ticks for days and weeks already over are set aside (kept, but no longer loaded with every request) |

What gets sent, and when, is described in "Notifications" in
`apps-script/README.md`, which is still the description of the behaviour.

## Settings

All on the Worker: **Settings → Variables and Secrets** in Cloudflare. None of
them belong in this repo, which is public. `wrangler.jsonc` says to keep them
across deploys.

| Name | Type | What it is |
|------|------|------------|
| `GOOGLE_CLIENT_ID` | Text | The OAuth client's ID (see "Google") |
| `GOOGLE_CLIENT_SECRET` | Secret | The OAuth client's secret |
| `FAMILY_ACCOUNTS` | Text or Secret | Who each Google account is: `Jon=…@gmail.com, Maggie=…@gmail.com`. Add `Clayton=…` or `Heidi=…` only if they have accounts of their own |
| `VAPID_PUBLIC_KEY` | Text | For notifications; made with `keys.html` |
| `VAPID_PRIVATE_KEY` | Secret | For notifications; made with `keys.html` |
| `CAL_JON`, `CAL_MAGGIE`, `CAL_FAMILY`, `CAL_MCHS` | Secret | The calendar IDs. One left out is left off the Hub |
| `TODOIST_TOKEN` | Secret | Jon's Todoist API token. Leave it out to do without Todoist |
| `REMINDERS_HIDE_LISTS` | Text | Optional. Todoist projects that are never read into the Hub, comma separated. Left unset it hides `Work`, whose tasks name students. Hidden projects are dropped as they are read: they are never stored |
| `NOTION_TOKEN` | Secret | The Notion integration's secret. Leave it out to plan dinners in the Hub |
| `NOTION_MEALS_SOURCE` | Secret | The Meal Plan database's data source ID |
| `NOTION_CHECKINS_SOURCE` | Secret | The Weekly Check-Ins database's data source ID |
| `NOTION_RECIPES_SOURCE` | Text | Optional. The Recipes database's data source ID. Left unset, it's the database the meal plan's Recipe column links to |
| `VAPID_SUBJECT` | Text | Optional: `mailto:` and an address push services can contact |
| `HUB_ORIGIN` | Text | Optional. Where the Hub's page is served from, if not GitHub Pages. Only pages from here may read the Worker's answers |

How the Notion databases and the Todoist token are set up on their own side is
in `apps-script/README.md` ("Meal plan from Notion", "Check-ins to Notion",
"Todoist"): those steps haven't changed, only where the values go.

## Google

One Google Cloud project holds an OAuth client of type **Web application**,
used for both sign-in and the calendar.

- **Authorized redirect URIs**: the Worker's address followed by
  `/auth/callback`, and again followed by `/auth/calendar/callback`.
- **Google Calendar API**: enabled.
- **Audience**: published (*In production*). In *Testing*, Google ends calendar
  access after seven days. Publishing needs a home page and a privacy policy
  link: the Hub's address, and `privacy.html` beside it. Google shows a
  "hasn't verified this app" notice when the calendar is connected; that is
  expected for an app only a family uses. Who can sign in to the Hub is
  decided by `FAMILY_ACCOUNTS`, not by Google.

### The calendar

The Worker reads the calendars as Jon, read-only. He grants that once: ⚙ →
**Calendar → Connect the calendar**, with his own Google account, leaving the
box for seeing calendars ticked. Only a parent's own account is accepted.

What Google gives is kept in the database encrypted with a key made from the
Worker's own secret, so the database alone can't be used to read a calendar.
**Disconnect** forgets it and withdraws it at Google. A calendar that can't be
read keeps showing what was last read from it, and Settings says which. If
Settings ever says Google returned `invalid_grant`, the access has lapsed or
been withdrawn: connect again.

## Notifications

`keys.html` makes the two push keys in your browser:
<https://harperjonathanp-art.github.io/harper-family-hub/worker/keys.html>.
Phones sign up against `VAPID_PUBLIC_KEY`, so if new keys are ever made, every
phone has to turn notifications off and on again.

On each iPhone: open the Hub from its Home Screen icon, ⚙ → **Turn on
notifications**, then **Send a test**. A phone that has dropped its
subscription is forgotten the next time something is sent to it.

## The database

D1, bound as `DB`. `wrangler.jsonc` names no database ID: the first deploy made
one and linked it. The Worker makes its own tables the first time it needs
them. To look inside: Cloudflare dashboard → **Storage & Databases → D1**.

| Table | Holds |
|-------|-------|
| `sessions`, `signins` | Signed-in devices (a hash of each token), and sign-ins waiting to be approved |
| `groceries` | The grocery list |
| `hub_tasks`, `hub_completions`, `hub_completions_old` | Tasks and their ticks; ticks for periods that are over |
| `hub_meals`, `hub_checkins` | The week's dinners; check-ins |
| `hub_devices`, `hub_notifyprefs` | Phones signed up for notifications; each person's notification settings |
| `recipe_store`, `recipe_bodies`, `recipe_photos` | The recipe list as one copy, each recipe page as read (and the words its ingredients use, for search), and photos, kept a week |
| `props` | Bookkeeping, as text by key: what notifications have gone out, the last good copy of Todoist, the calendar's events and the (encrypted) access to it, and `rev` |

Two phones saving at once can't undo each other: every change carries the
`rev` the data had when it was read and is applied only if that is still
current; otherwise the work is redone on fresh rows (`store.js`).

## Where this came from

Until 22 November 2026 the backend was a Google Apps Script web app over a
Google Sheet, reached with a shared family PIN. It moved here feature by
feature: sign-in and the grocery list on 20 November, everything else on the
21st after 55 clean rehearsal runs against the real data, and the calendar on
the 22nd after 232 comparisons with Apps Script's, all identical.

`apps-script/` is kept. Nothing runs it any more, but it is what this Worker
is tested against.

## Tests

```
cd worker
npm install
npm test
```

They run the Worker in Cloudflare's local simulator with a pretend Google,
Todoist, Notion and push service. For the rules themselves they also run the
real `apps-script/*.gs` files over a pretend Sheet (`test/appsscript-sim.js`)
and check the Worker gives the same answers: action for action for tasks and
groceries, timer run for timer run for notifications, sync for sync for
Todoist and Notion, and event for event for the calendar, across midnights,
New Year and both daylight-saving changes. `package.json` here is only for the
tests; Cloudflare never reads it.
