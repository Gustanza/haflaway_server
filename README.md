# Haflaway Card Server

A standalone Node.js/Express backend meant to run on our own VPS (Contabo) instead of
Firebase Cloud Functions — starting with card rendering + sending. It talks to the same
Firebase project (`haflaway-f14aa`) via the Admin SDK, so it has the same level of trust
as `functions/` (full Firestore/Storage read-write access).

This folder is its own thing, deliberately excluded from the main repo's git tracking
(see the "Access Control Stuff" section of the root `.gitignore`) — same pattern as
`functions/`, which is checked out here as a separate repo. Give this folder its own
git remote when you're ready to deploy it.

**Deploying to the actual VPS?** See [DEPLOY.md](./DEPLOY.md) for the full,
self-contained runbook — VPS prerequisites, getting the code and secrets over
safely, running it persistently with pm2, HTTPS, and the exact order to test
a real send in.

## 1. Get a service account key

1. Firebase Console → Project Settings → **Service Accounts** tab (project: `haflaway-f14aa`).
2. Click **Generate new private key** — downloads a JSON file.
3. Save it into this folder as `serviceAccountKey.json`. It's already gitignored —
   never commit this file, anywhere.

## 2. Configure environment

```
cp .env.example .env
```

Edit `.env` if your key file has a different name/location, or the storage bucket
name differs from the default.

## 3. Install & run

```
npm install
npm start
```

## 4. Verify it's wired up correctly

- `GET /health` — confirms the process is running (no Firebase involved).
- `GET /health/firebase` — confirms the service account can actually read Firestore.

## Endpoints

- `POST /events/:eventId/attendees/:attendeeId/cards/:purpose/render` — renders
  (or reuses an already-rendered) card for one attendee. Requires
  `Authorization: Bearer <Firebase ID token>`.
- `POST /events/:eventId/campaigns/:campaignId/send` — batch render + dispatch
  for a list of attendees (`{ attendeeIds, channel, purpose }`). Responds
  immediately with `{ runId }`; the batch itself keeps running afterwards and
  streams progress into `events/{eventId}/campaigns/{campaignId}/sendRuns/{runId}`,
  which the SPA listens to live.

## Render concurrency

Each concurrent render job is a full headless Chromium instance, so this is
capped rather than left unbounded — see `src/config.js` for the full
reasoning. It defaults to `min(RAM-bound, CPU-bound)` concurrency, where the
CPU figure assumes **6 vCPU** (a documented guess matching Contabo's Cloud VPS
tier that ships with 24GB RAM — not a detected value). Once deployed, run
`nproc` on the VPS and set `CARD_SERVER_VPS_CORES` in `.env` to the real
number; `CARD_RENDER_CONCURRENCY` overrides the calculation entirely if you'd
rather set it directly.

## Known gaps

- **⚠️ Blocking, pre-existing, NOT introduced by this app — likely breaks every
  WhatsApp card send today.** `functions/whatsapp/invitation.js` (and the
  identical line in `contribution.js`) derives the WhatsApp content variable
  for the card image via `cardUrl.split(".app/")[1]`. The card URLs this
  server (and the untouched `functions/attendees/imagen.js`) actually produce
  are `https://storage.googleapis.com/haflaway-f14aa.appspot.com/Level0/...`
  — confirmed live via the real default bucket name — which does **not**
  contain the literal substring `.app/`. Verified directly: that split
  returns `undefined`, which trips `invitation.js`'s "Invalid cardUrl" skip
  for every attendee, every time. This predates this build (only the
  surrounding `if` condition changed) and affects the existing
  invitation-lifecycle flow too, not just card-purpose campaigns — but it's
  the linchpin for whether "send card via WhatsApp" can work at all. I did
  **not** guess at a fix here since it depends on the actual Twilio Content
  Template's var 6 contract (full URL? a relative Storage path? something
  else?), which isn't visible from code — needs a real send test, or
  confirmation of what that template variable actually expects.
- **WhatsApp template categories for `thank_you`/`enclosure`** — dispatch
  looks up a pre-approved WhatsApp Content Template by category
  (`WHATSAPP_TEMPLATE_CATEGORY_BY_PURPOSE` in `src/routes/campaigns.js`).
  Only `invitation` and `save_the_date` have a real category today (matching
  what the existing Invitations screen already uses); the other two are
  best-guess names. Sends for those purposes will fail per-recipient with a
  clear "no template found" error until an approved template exists under
  that category — create one in `messageTemplates`, or update the category
  name in that file to match whatever's actually approved.
- **Default SMS copy** — a card-purpose campaign has no message composer in
  the SPA (the card itself is the content), so SMS sends fall back to a
  generic per-purpose string in `DEFAULT_SMS_CONTENT_BY_PURPOSE` unless the
  campaign doc's own `smsMessage` is set. Worth customizing per event.
- **Puppeteer/Chromium is Linux-targeted** (`@sparticuz/chromium`) — rendering
  won't work when running this server directly on Windows; test the actual
  render pipeline on the Linux VPS (or WSL) once deployed.
