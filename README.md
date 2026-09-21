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
name differs from the default. If you're actually dispatching (not just
rendering), also fill in the Twilio/Beem/OnFon/Smtz/Wasambazie credentials —
real values live in `functions/utils/constants.js` and
`functions/sms/{beem,onfon,smtz,wasambazie}.js`. Never put real secrets in
`.env.example` itself — it's committed.

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

- ~~Blocking bucket-URL mismatch affecting WhatsApp sends~~ — **retracted.**
  An earlier version of this doc flagged `functions/whatsapp/invitation.js`'s
  `cardUrl.split(".app/")[1]` as likely broken, based on an assumed default
  bucket of `haflaway-f14aa.appspot.com`. That assumption was wrong — see the
  bucket-name story below — and was never checked against real data at the
  time. The actual bucket, `haflaway-f14aa.firebasestorage.app`, **does**
  contain `.app/` as a substring, so that split works correctly. No fix
  needed here after all.
- **The real Storage bucket is `haflaway-f14aa.firebasestorage.app`, not
  `.appspot.com`.** `src/firebase.js` requires this explicitly — bucket
  auto-detection only works inside GCP's own runtime (Cloud Functions/Run),
  not for a service-account-authenticated app on a plain VPS. An earlier
  guess here used the legacy `.appspot.com` domain and broke every render
  with "The specified bucket does not exist" — caught via a real end-to-end
  test, then confirmed against an actual already-rendered `cards.*.url`
  value already sitting in Firestore. `.env`/`.env.example` now have the
  correct value. If this ever needs re-verifying, don't guess — search
  Firestore for a real `cards.*.url` field and read the bucket out of it.
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
- **Dispatch credentials aren't set anywhere yet.** `src/dispatch/{whatsapp,sms}.js`
  now call Twilio/Beem/OnFon/Smtz/Wasambazie directly (see "Dispatch now
  happens here too" below) instead of proxying through Cloud Functions that
  already had these configured — nothing will actually send until the real
  `TWILIO_*`/`BEEM_*`/`ONFON_*`/`SMTZ_*`/`WASAMBAZIE_*` values from
  `functions/utils/constants.js` and `functions/sms/*.js` are copied into the
  real (gitignored) `.env` on wherever this runs.
- Puppeteer/Chromium platform handling is fixed — `launchBrowser()` in
  `src/render/renderCard.js` now only trusts `@sparticuz/chromium`'s bundled
  binary on Linux (it's a prebuilt ELF executable that silently fails to spawn
  elsewhere) and correctly falls back to a local Chrome/Chromium install on
  other platforms. Rendering should now work for local dev testing too, given
  a real browser installed.

## Dispatch now happens here too

`src/dispatch/` (`whatsapp.js`, `sms.js`, `billing.js`, `pricing.js`,
`senderId.js`, `messageTokens.js`) ports the actual Twilio/SMS-provider
calls and billing/quota logic straight from `functions/whatsapp/invitation.js`
and `functions/sms/indesms.js` — `src/routes/campaigns.js` no longer proxies
through those Cloud Functions per recipient; it dispatches directly. It
writes to the same `messageLogs` shape those functions always did, so the
existing delivery-status webhooks keep working unchanged. Card *rendering*
is now billed too (`src/render/renderAttendeeCard.js`), separately from
dispatch — see that file's comments for the creation-vs-correction charging
model (`attendee.cardRenderCounts[purpose]`).
