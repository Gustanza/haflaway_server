# Deploying `haflaway-card-server` to the Contabo VPS

This is a full, self-contained runbook — written so it can be picked up cold,
without needing the conversation that produced it. Read the whole thing before
running anything; several steps have real financial/messaging consequences
(WhatsApp/SMS dispatch is billed, and sends real messages to real event guests).

## What this app is and why it exists

`server/` is a standalone Node/Express app that replaces the card-*rendering*
half of a Firebase Cloud Functions pipeline. Rendering a card means launching
a full headless Chromium (Puppeteer) instance per card — heavy, slow-cold-start
work that fits a persistent VPS process far better than a serverless function.
It talks to Firestore/Storage directly via the Firebase Admin SDK (same
project as the rest of Haflaway: `haflaway-f14aa`).

**Rendering AND dispatch both happen here now.** This started as
render-only, proxying actual sends through the existing Firebase Functions
— that's no longer the case. `src/dispatch/` (`whatsapp.js`, `sms.js`,
`billing.js`, `pricing.js`, `senderId.js`) now calls Twilio/Beem/OnFon/Smtz/
Wasambazie directly, carefully ported from `functions/whatsapp/invitation.js`
and `functions/sms/indesms.js` (a *separate* git repo checked out at
`../functions` relative to this one) — same billing/quota model, same
`messageLogs` doc shape (so the existing delivery-status webhooks there keep
working unchanged). **This means real provider credentials must be
configured on this app now** (step 3 below) — without them, nothing sends,
regardless of how correctly everything else is deployed.

The admin panel SPA (`haflaway_spa/`) calls this server directly from the
browser, from `src/views/event/EventCampaigns.vue` — search that file for
`CARD_SERVER_URL` to see exactly how.

## Before you start: known gaps that affect a real send

These are documented in full in `server/README.md`'s "Known gaps" section —
read that too. The one that matters most for deployment:

- The real Storage bucket is `haflaway-f14aa.firebasestorage.app` (confirmed
  against an actual already-rendered card URL in Firestore) — an earlier
  guess used the legacy `.appspot.com` domain, which doesn't exist for this
  project and broke every render. Already fixed in `.env`/`.env.example`;
  mentioned here so it isn't reintroduced. This also cleared up an earlier
  false alarm about WhatsApp card sends being broken — that concern was
  based on the same wrong bucket guess and doesn't actually apply.
- Only `invitation` and `save_the_date` have a real WhatsApp template category
  configured (`thank_you`/`enclosure` don't yet).
- `requireEventAccess` (in `src/middleware/eventAccess.js`) only checks
  `event.authorId === uid` — it does not yet know about team/org-shared event
  access, if that's a real thing in this app.

None of these block getting the app *running* — they block a real WhatsApp
send from actually working end to end. Deploy, verify health, then do one
careful SMS test to yourself before anything else.

## 1. VPS prerequisites

SSH into the Contabo VPS. This assumes Ubuntu/Debian; adjust package manager
commands if it's something else.

```bash
# Node.js 22 (matches functions/'s engine) via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

node -v   # confirm v22.x
npm -v
```

**Puppeteer/Chromium system libraries.** `@sparticuz/chromium` bundles its own
Chromium binary, but it still needs these shared libs present on a bare
Ubuntu/Debian box:

```bash
sudo apt-get update
sudo apt-get install -y \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
  libasound2 libpango-1.0-0 libpangocairo-1.0-0 libatspi2.0-0 libxshmfence1 \
  ca-certificates fonts-liberation
```

If Chromium still fails to launch after this (check `server.log` — see step
5), `src/render/renderCard.js`'s `launchBrowser()` already falls back to a
system-installed Chrome/Chromium at `/usr/bin/google-chrome` or
`/usr/bin/chromium-browser`/`/usr/bin/chromium` if `@sparticuz/chromium`'s own
binary throws. As a fallback, install a real browser:

```bash
sudo apt-get install -y chromium-browser
```

**Confirm the real core count** — the render concurrency calculation in
`src/config.js` currently assumes 6 vCPU as a placeholder:

```bash
nproc
```

Remember this number for step 4.

## 2. Get the code onto the VPS

`server/` was `git init`'d locally but has **no remote yet** — this repo is
deliberately excluded from the main `haflaway-admin` repo's git tracking
(see the "Access Control Stuff" section of its root `.gitignore`), the same
way `functions/` is checked out separately. Two ways to get it onto the VPS,
pick one:

**Option A — quick, no GitHub repo needed yet** (good for a first deploy):

```bash
# from your dev machine, in c:\Users\Administrator\Documents\CODEZ\haflaway-admin
scp -r server/ user@your-vps-ip:/opt/haflaway-card-server
```

Exclude `node_modules/` first if it exists locally (it's gitignored but scp
doesn't know that) — either `rm -rf server/node_modules` before copying, or
`rsync -av --exclude node_modules --exclude .env --exclude serviceAccountKey.json server/ user@your-vps-ip:/opt/haflaway-card-server`
to also skip the secrets (send those separately, see step 3).

**Option B — proper git remote** (better for ongoing updates):

Create a new repo (e.g. `Gustanza/haflaway-card-server` on GitHub, matching
the naming pattern `haflaway-admin-functions` already uses), then:

```bash
cd server
git remote add origin <the-new-repo-url>
git add -A
git commit -m "Initial commit"
git push -u origin main
```

Then on the VPS: `git clone <the-new-repo-url> /opt/haflaway-card-server`.
Future updates become `git pull` + restart instead of re-copying files.

## 3. Get the secrets onto the VPS — never via git

The service account key is a live credential. It must travel by a channel
that doesn't end up in any git history, ever.

```bash
scp server/serviceAccountKey.json user@your-vps-ip:/opt/haflaway-card-server/serviceAccountKey.json
```

On the VPS:

```bash
cd /opt/haflaway-card-server
cp .env.example .env
nano .env   # or vim/your editor of choice
```

Fill in / confirm:
- `GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json` (default is fine
  if you scp'd the key to the same directory)
- `FIREBASE_PROJECT_ID=haflaway-f14aa`
- `FIREBASE_STORAGE_BUCKET=haflaway-f14aa.firebasestorage.app` (confirmed
  against real data — see `.env.example`'s comment; don't change without
  re-verifying against an actual `cards.*.url` value in Firestore)
- `CARD_SERVER_VPS_CORES=<the real number from `nproc` in step 1>`
- `PORT=8080` (fine to leave — it stays behind the reverse proxy in step 6,
  never exposed directly to the internet)
- **`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`,
  `BEEM_API_KEY`, `BEEM_SECRET_KEY`, `ONFON_USERNAME`, `ONFON_PASSWORD`,
  `SMTZ_API_KEY`, `WASAMBAZIE_PUBLIC_KEY`, `WASAMBAZIE_SECRET_KEY`** — real
  values live in `functions/utils/constants.js` and
  `functions/sms/{beem,onfon,smtz,wasambazie}.js`. These are live credentials
  same as the service account key — copy them directly into `.env` on the
  VPS, never through a commit, never pasted into a chat session. Without
  these, rendering still works but every dispatch attempt fails.

## 4. Install dependencies

```bash
cd /opt/haflaway-card-server
npm install --omit=dev
```

## 5. Verify it runs, before wiring it into anything

```bash
node src/index.js
```

In another terminal (or from your dev machine if the port's reachable):

```bash
curl http://localhost:8080/health
curl http://localhost:8080/health/firebase
```

Both must return `{"ok":true,...}` before continuing. `Ctrl+C` to stop this
foreground run once confirmed — step 6 makes it a persistent service.

If `/health/firebase` fails: check `.env`'s `GOOGLE_APPLICATION_CREDENTIALS`
path and that `serviceAccountKey.json` actually landed where it's pointed at.

If you want to sanity-check rendering itself works on this box before wiring
up the whole app, you can exercise `renderAttendeeCard` directly against a
real event/attendee/card-blueprint you know exists — ask whoever owns this
task which IDs are safe to use for a test, since this writes
`attendee.cards[purpose]` on a real record:

```bash
node -e "
require('./src/render/renderAttendeeCard').renderAttendeeCard('REAL_EVENT_ID', 'REAL_ATTENDEE_ID', 'invitation')
  .then(r => console.log('OK:', r))
  .catch(e => console.error('FAILED:', e));
"
```

## 6. Run it persistently with pm2

A Cloud Function restarts itself on every invocation; this is a long-lived
process that needs to survive crashes and reboots.

```bash
sudo npm install -g pm2
cd /opt/haflaway-card-server
pm2 start src/index.js --name haflaway-card-server
pm2 save
pm2 startup   # prints a command to run — copy/paste and run it, enables start-on-boot
```

Useful commands going forward:

```bash
pm2 logs haflaway-card-server     # tail logs
pm2 restart haflaway-card-server  # after a deploy/config change
pm2 status
```

## 7. Put it behind HTTPS (required — not optional)

The SPA calls this server directly from the browser, carrying a Firebase ID
token in the `Authorization` header. That cannot go over plain HTTP — modern
browsers block "mixed content" (HTTPS page calling an HTTP API) outright, and
even where they don't, sending an auth token over plaintext is unacceptable.
Port 8080 itself should never be exposed to the public internet — only
reachable via `localhost`, fronted by a reverse proxy that terminates TLS.

Pick a subdomain (e.g. `cards.haflaway.com`) and point its DNS A record at
the VPS's IP first, then:

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/haflaway-card-server`:

```nginx
server {
    listen 80;
    server_name cards.haflaway.com;

    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/haflaway-card-server /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d cards.haflaway.com   # issues + auto-configures HTTPS, sets up renewal
```

Firewall: only 80/443 need to be open to the world (80 for the Let's Encrypt
challenge and HTTP→HTTPS redirect certbot sets up); 8080 should not be
reachable from outside the VPS at all (nginx talks to it over localhost).

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable   # if not already enabled — check `sudo ufw status` first
```

Confirm from your dev machine:

```bash
curl https://cards.haflaway.com/health
curl https://cards.haflaway.com/health/firebase
```

## 8. Tighten CORS (recommended before real use)

`src/index.js` currently does `app.use(cors())` with no origin restriction —
fine for local dev, looser than necessary once this has a public HTTPS URL.
Every route already requires a verified Firebase ID token regardless of
origin, so this isn't a gaping hole, but restricting it is easy and
worthwhile. Edit `src/index.js`:

```js
app.use(cors({ origin: 'https://haflaway-f14aa.web.app' })) // or your real admin panel domain(s)
```

Then `pm2 restart haflaway-card-server`.

## 9. Point the SPA at the deployed server

The frontend defaults to `http://localhost:8080` (see `CARD_SERVER_URL` in
`haflaway_spa/src/views/event/EventCampaigns.vue`). Set the real URL for
whatever build/deploy pipeline builds the SPA:

```
VITE_CARD_SERVER_URL=https://cards.haflaway.com
```

Rebuild and redeploy the SPA (`npm run build` in `haflaway_spa/`, then
whatever your normal Firebase Hosting deploy step is) for this to take
effect.

## 10. First real test — do this before anything else

1. In the admin panel, go to a **test event** (not a real one with real
   guests), Guest List → Send → Card → Invitation. Confirm it either opens
   the designer (no blueprint yet) or reaches the send screen (blueprint
   exists).
2. On the send screen, pick **SMS** as the channel (not WhatsApp — see the
   known bug above), select just yourself/a test phone number as the sole
   recipient.
3. Click Send. Watch the live progress panel. Confirm it shows `sent`, not
   `render_failed` or `send_failed`.
4. Check `pm2 logs haflaway-card-server` on the VPS for anything unexpected
   during that request.
5. Only after that works: try WhatsApp.

Do not run a real batch send to actual event guests until this single-
recipient SMS test has succeeded.

## Updating the deployment later

```bash
# Option A (scp'd, no git remote):
#   scp the changed files over again, or re-run the rsync from step 2
# Option B (git remote):
cd /opt/haflaway-card-server
git pull
npm install --omit=dev   # only if package.json changed
pm2 restart haflaway-card-server
```
