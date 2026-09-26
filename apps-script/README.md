# Apps Script backend

The Hub reads from and writes to this Google Apps Script web app. The live
copy runs in Google's Apps Script editor; this folder is the tracked copy.
Change it here, then paste it into the editor and publish a new version.

| File | What it does |
|------|--------------|
| `Code.gs` | The web app: tasks, meals, calendar, check-ins |
| `Notify.gs` | Notifications: what to send, to whom, and when |
| `appsscript.json` | Project settings (time zone, web app access) |

## Script Properties

Anything private stays out of this public repo. Add these under
**Project Settings → Script Properties**:

| Property           | What it is                                             |
|--------------------|--------------------------------------------------------|
| `FAMILY_PIN`       | The PIN the Hub sends with every request               |
| `SHEET_ID`         | The Google Sheet that holds tasks, meals and check-ins |
| `CAL_JON`          | Jon's calendar ID (his Google account email)           |
| `CAL_MAGGIE`       | Maggie's calendar ID (her Google account email)        |
| `CAL_FAMILY`       | The shared Family calendar (`…@group.calendar.google.com`) |
| `CAL_MCHS`         | The MCHS school calendar                               |
| `PUSH_WORKER_URL`  | The push relay's address, e.g. `https://harper-family-hub.<name>.workers.dev` |
| `PUSH_SECRET`      | The shared secret from `push-worker/keys.html`         |
| `VAPID_PUBLIC_KEY` | The public key from `push-worker/keys.html`            |

A calendar whose property is missing is left out of the Hub.
`NOTIFY_STATE` appears there too once notifications run. It's the
notifications' own bookkeeping, so leave it alone.

## Publishing a change

Editing the code does not change the live Hub until you publish a new version:
**Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.**
Editing the existing deployment keeps the same web app URL, so the Hub's
Settings don't need to change. **New deployment** would create a new URL.

## Notifications

Phones get notifications through the push relay in `push-worker/`, which
does the Web Push encryption Apps Script can't. Set that up first (see
`push-worker/README.md`), then:

1. Add `PUSH_WORKER_URL`, `PUSH_SECRET` and `VAPID_PUBLIC_KEY` to Script Properties.
2. In the editor, add a script file named `Notify` (**+ → Script**) and paste
   `Notify.gs` into it. Replace `Code.gs` with this folder's copy too.
3. Pick **setupNotifications** in the function menu at the top and press **Run**.
   Google asks for permission once (to reach the push relay and run on a
   timer). The execution log then shows a checklist of what's working.
4. Publish a new version (above).
5. On each iPhone, open the Hub from its Home Screen icon, tap ⚙, then
   **Turn on notifications**, and **Send a test**.

What gets sent, and when, is set per person in the Hub's Settings: the
morning summary, the dinner nudge, the Family Huddle and Weekly Check-In
reminders, new to-dos, the meal plan being ready, and quiet hours. Quiet
hours hold back new to-do and meal-plan alerts until they end. The
scheduled reminders go at the times each person picks.

The meal-plan alert goes once every day has a dinner and the plan has sat
unchanged for 10 minutes (`MEALS_SETTLE_MIN` in `Notify.gs`). It isn't
sent to whoever saved the plan in the Hub. A plan changed straight in the
Sheet goes to everyone.

## Tasks: due dates and repeats

A task can have a due date and a repeat, set in the Hub or typed straight into
the Tasks tab's `due` and `repeat` columns. Repeats are written the way Apple
Reminders words them:

| `repeat` | Means |
|----------|-------|
| `every 1 week` | Weekly, on the due date's weekday |
| `every 2 weeks` | Every other week |
| `every 1 week on sun,tue,thu` | Those days each week |
| `every 3 months` | Every 3 months, on the due date's day of the month |
| `every 3 months on 3rd sat` | Every 3 months, on the third Saturday |
| `every 1 year on last fri` | Yearly, on the last Friday of the due date's month |

Ticking a repeating task moves `due` to its next date, as Reminders does.
Unticking it the same day puts it back. Tasks with no repeat keep the older
daily/weekly/monthly reset behaviour.
