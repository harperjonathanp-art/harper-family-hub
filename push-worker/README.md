# Push relay

A tiny Cloudflare Worker that delivers the Hub's notifications to phones.
Apps Script decides what to send; `worker.js` does the Web Push signing and
encryption Apps Script can't. It stores nothing, and it only sends to real
push services (Apple, Google, Mozilla, Microsoft).

Cloudflare's free plan covers this many times over.

## Setup

The Worker is named `harper-family-hub` and is connected to this repo in
Cloudflare (Workers Builds). `wrangler.jsonc` at the repo root tells it to
deploy `push-worker/worker.js`, so every push to `main` redeploys the relay
on its own. Keys added in the dashboard are kept across deploys.

1. **Make the keys.** Open
   [keys.html](https://harperjonathanp-art.github.io/harper-family-hub/push-worker/keys.html).
   It makes three values in your browser. Keep the page open until you've
   pasted them all in.
2. **Check the build.** In the Cloudflare dashboard, open the
   `harper-family-hub` Worker's **Deployments**. The latest build from `main`
   should have succeeded. If not, **Retry build**.
3. **Add the keys.** Go to the Worker's **Settings → Variables and Secrets**
   and add each of these:

   | Name                | Type   | Value |
   |---------------------|--------|-------|
   | `VAPID_PUBLIC_KEY`  | Text   | from keys.html |
   | `VAPID_PRIVATE_KEY` | Secret | from keys.html |
   | `PUSH_SECRET`       | Secret | from keys.html |
   | `VAPID_SUBJECT`     | Text   | optional: `mailto:` and an email push services can contact |

4. **Check it.** Open the Worker's address (shown on its overview, like
   `https://harper-family-hub.<name>.workers.dev`). It should say
   *Family Hub push relay is running.*
5. Copy that address into Apps Script as `PUSH_WORKER_URL`, along with
   `PUSH_SECRET` and `VAPID_PUBLIC_KEY`, then follow the Notifications steps in
   `apps-script/README.md`.

To run it without the repo link instead, create a Worker in the dashboard,
paste `worker.js` into **Edit code**, and deploy. Then do steps 3 to 5.

## Changing the keys

Phones sign up against `VAPID_PUBLIC_KEY`. If you ever make new keys, update
the Worker and Apps Script, then turn notifications off and on again on each
phone.
