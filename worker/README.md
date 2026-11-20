# The Hub's Worker

One Cloudflare Worker, named `family-hub-push`: the Worker that already runs
the push relay, so its address and keys stay as they are. Once it is connected
to this repo (step 1 below), every push to `main` deploys it
(`wrangler.jsonc` at the repo root).

| Path | File | What it does |
|------|------|--------------|
| `/send` | `../push-worker/worker.js` | The push relay, unchanged. See `push-worker/README.md` |
| `/auth/…` | `auth.js` | Sign-in: with Google, or by a parent's say-so |
| `/api` | `proxy.js` | The Hub's data for a signed-in device: answered here for a feature that has moved, passed to Apps Script for the rest |
| | `groceries.js` | The grocery list, once it has moved (see "Moving a feature") |

This is the start of moving the backend off Apps Script. Only the grocery
list has moved: tasks, meals, check-ins, notifications and the rest still run
in `apps-script/`, and every phone that uses the PIN keeps working as
before. What's new is that a device can sign in instead of holding the PIN,
and that a signed-in device gets its grocery list from the Worker.

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
hash of it, in the `sessions` table of its D1 database. A parent sees every
signed-in device in Settings and can sign any of them out.

A signed-in device never holds the family PIN: the Worker adds it when it
passes a request on to Apps Script. Who ticked a task or added one comes from
the sign-in, not from what the page says.

**Until the PIN is retired, sign-in doesn't lock anything.** A device that
still has the PIN saved goes back to using it when it's signed out.

## Setup

About 40 minutes, once. The names in the two consoles move around; the steps
are the same.

### 1. Cloudflare: connect the repo

Until this is done, nothing in `worker/` is running: the Worker is still the
copy of the push relay pasted into the dashboard.

1. In the Cloudflare dashboard, open **Workers & Pages → `family-hub-push` →
   Settings → Builds** and choose **Connect** (a Git repository).
2. Pick GitHub and the `harper-family-hub` repo. Cloudflare may ask GitHub for
   access to it first.
3. Branch `main`, root directory `/`, no build command, deploy command
   `npx wrangler deploy` (the defaults).
4. Save, then start a deployment (or push anything to `main`). The build log
   should end with the Worker's address.
5. Open that address. It should still say *Family Hub push relay is running.*
   Then open it with `/auth/me` on the end: `{"ok":false,"error":"signed_out"}`
   means the new code is live. In the Hub, ⚙ → **Send a test** should still
   arrive.

The relay's keys (`VAPID_…`, `PUSH_SECRET`) are kept: `wrangler.jsonc` says to
keep the dashboard's variables, and secrets are always kept.

### 2. Google: an OAuth client

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and make
   a project, e.g. "Family Hub".
2. Open **Google Auth Platform** (older name: *APIs & Services → OAuth consent
   screen*). Set it up as **External**, with any app name and your email.
3. Under **Audience**, leave it in **Testing** and add each family member's
   Google account as a **test user**. Only those accounts can get through
   Google at all. (The Hub asks Google only for the account's email address,
   once, at sign-in, so Testing's seven-day limit never comes into it.)
4. Under **Clients**, create a client of type **Web application**. Add one
   **Authorized redirect URI**: the Worker's address followed by
   `/auth/callback`, e.g.
   `https://family-hub-push.<name>.workers.dev/auth/callback`.
5. Copy the **Client ID** and **Client secret**.

### 3. Cloudflare: the Worker's variables

In the dashboard, open the `family-hub-push` Worker's **Settings → Variables
and Secrets** and add:

| Name | Type | Value |
|------|------|-------|
| `GOOGLE_CLIENT_ID` | Text | from step 2 |
| `GOOGLE_CLIENT_SECRET` | Secret | from step 2 |
| `FAMILY_ACCOUNTS` | Secret | Who each Google account is: `Jon=…@gmail.com, Maggie=…@gmail.com`. Add `Clayton=…` or `Heidi=…` only if they have accounts of their own |
| `APPS_SCRIPT_URL` | Secret | The Apps Script web app's address (`…/exec`), as in the Hub's Settings today |
| `FAMILY_PIN` | Secret | The same PIN as the `FAMILY_PIN` Script Property |

None of these belong in this repo, which is public.

The push relay's own variables (`VAPID_…`, `PUSH_SECRET`) stay as they are.

### 4. The database

Nothing to do. `wrangler.jsonc` asks for a D1 database bound as `DB` without
naming one, so the first deploy creates it and links it to the Worker. The
Worker makes its own tables the first time it needs them. To look inside:
dashboard → **Storage & Databases → D1**.

If a deploy ever fails on the database, the previous version of the Worker
keeps running, so the push relay isn't interrupted.

### 5. Try it on one phone

1. Open the Hub from its Home Screen icon and tap ⚙. Under **Sign in** there
   is a four-digit code and a **Sign in with Google** button. (The Worker's
   address is `HUB`, near the top of the script in `index.html`.)
2. Tap **Sign in with Google**, pick your account, check the code matches, and
   tap **Sign in**.
3. Go back to the Hub. Within a few seconds Settings shows *Signed in*.

For a device whose owner has no Google account, a signed-in parent opens ⚙ →
**Sign in another device** on their own Hub and types that device's code.

To go back to the PIN on a phone: ⚙ → **Sign out**.

## Moving a feature

A feature moves out of Apps Script when the list in `moved.js` names it, so a
move is a one-line commit, and taking the name out again undoes it. (In a
hurry, a Text variable named `MOVED` on the Worker replaces that list until
it's deleted: `none` moves everything back at once.)

| In `moved.js` | Since | What changes |
|---------------|-------|--------------|
| `groceries` | 20 Nov 2026 | The grocery list is kept in the Worker's database. The first request after the switch copies the list over from the Sheet, once, keeping every item's id, tick and place. From then on grocery actions never touch Apps Script, and the Sheet's `Groceries` tab is no longer read or written |

**A phone has to be signed in to see a moved feature.** A phone still on the
PIN talks to Apps Script directly and goes on seeing the Sheet's copy, which
stops changing at the move. Signing it in fixes that.

Undoing a move sends the Hub back to the Sheet's copy as it was at the move;
anything added since stays in the Worker's database but isn't shown.

## Other settings

| Name | Type | Value |
|------|------|-------|
| `HUB_ORIGIN` | Text | Optional. Where the Hub's page is served from, if not GitHub Pages. Only pages from here may read the Worker's answers |

## Tests

```
cd worker
npm install
npm test
```

They run the Worker in Cloudflare's local simulator with a pretend Google and
a pretend Apps Script. For a feature that has moved, they also run the real
`apps-script/Code.gs` over a pretend Sheet and check the Worker gives the same
answers, action for action. `package.json` here is only for the tests;
Cloudflare never reads it.
