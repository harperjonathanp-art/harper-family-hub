# Push relay

A tiny Cloudflare Worker that delivers the Hub's notifications to phones.
Apps Script decides what to send; `worker.js` does the Web Push signing and
encryption Apps Script can't. It stores nothing, and it only sends to real
push services (Apple, Google, Mozilla, Microsoft).

Cloudflare's free plan covers this many times over.

## Setup

1. **Make the keys.** Open
   [keys.html](https://harperjonathanp-art.github.io/harper-family-hub/push-worker/keys.html).
   It makes three values in your browser. Keep the page open until you've
   pasted them all in.
2. **Create the Worker.** In the Cloudflare dashboard: **Workers & Pages →
   Create → Create Worker**. Name it `family-hub-push` and press **Deploy**.
3. **Add the code.** Press **Edit code**, replace everything with `worker.js`,
   and press **Deploy**.
4. **Add the keys.** Go to the Worker's **Settings → Variables and Secrets**
   and add each of these:

   | Name                | Type   | Value |
   |---------------------|--------|-------|
   | `VAPID_PUBLIC_KEY`  | Text   | from keys.html |
   | `VAPID_PRIVATE_KEY` | Secret | from keys.html |
   | `PUSH_SECRET`       | Secret | from keys.html |
   | `VAPID_SUBJECT`     | Text   | optional: `mailto:` and an email push services can contact |

5. **Check it.** Open the Worker's address (shown on its overview, like
   `https://family-hub-push.<name>.workers.dev`). It should say
   *Family Hub push relay is running.*
6. Copy that address into Apps Script as `PUSH_WORKER_URL`, along with
   `PUSH_SECRET` and `VAPID_PUBLIC_KEY`, then follow the Notifications steps in
   `apps-script/README.md`.

## Changing the keys

Phones sign up against `VAPID_PUBLIC_KEY`. If you ever make new keys, update
the Worker and Apps Script, then turn notifications off and on again on each
phone.
