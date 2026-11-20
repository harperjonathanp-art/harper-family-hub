# Push relay

A tiny Cloudflare Worker that delivers the Hub's notifications to phones.
Apps Script decides what to send; `worker.js` does the Web Push signing and
encryption Apps Script can't. It stores nothing, and it only sends to real
push services (Apple, Google, Mozilla, Microsoft).

Cloudflare's free plan covers this many times over.

## Setup

The Worker is named `family-hub-push`. It was first made by pasting
`worker.js` into the Cloudflare dashboard. Once it is connected to this repo
(Workers Builds; see "Connect the repo" in `worker/README.md`), `wrangler.jsonc`
at the repo root tells Cloudflare to deploy `worker/index.js`, which hands
`/send` to `worker.js` here, so every push to `main` redeploys the relay on
its own. Keys added in the dashboard are kept across deploys. The same Worker
then also does the Hub's sign-in.

1. **Make the keys.** Open
   [keys.html](https://harperjonathanp-art.github.io/harper-family-hub/push-worker/keys.html).
   It makes three values in your browser. Keep the page open until you've
   pasted them all in.
2. **Check the Worker.** In the Cloudflare dashboard, open the
   `family-hub-push` Worker. Once the repo is connected, its **Deployments**
   show a build for each push to `main`; if the latest failed, **Retry build**.
3. **Add the keys.** Go to the Worker's **Settings → Variables and Secrets**
   and add each of these:

   | Name                | Type   | Value |
   |---------------------|--------|-------|
   | `VAPID_PUBLIC_KEY`  | Text   | from keys.html |
   | `VAPID_PRIVATE_KEY` | Secret | from keys.html |
   | `PUSH_SECRET`       | Secret | from keys.html |
   | `VAPID_SUBJECT`     | Text   | optional: `mailto:` and an email push services can contact |

4. **Check it.** Open the Worker's address (shown on its overview, like
   `https://family-hub-push.<name>.workers.dev`). It should say
   *Family Hub push relay is running.*
5. Copy that address into Apps Script as `PUSH_WORKER_URL`, along with
   `PUSH_SECRET` and `VAPID_PUBLIC_KEY`, then follow the Notifications steps in
   `apps-script/README.md`.

To run only the relay without the repo link, create a Worker in the dashboard,
paste `worker.js` into **Edit code**, and deploy. Then do steps 3 to 5.

## Changing the keys

Phones sign up against `VAPID_PUBLIC_KEY`. If you ever make new keys, update
the Worker and Apps Script, then turn notifications off and on again on each
phone.
