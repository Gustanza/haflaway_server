# Move org SMS credential management into haflaway_server

Goal: orgs can plug in their own smtz/wasambazie credentials (created
directly with those providers, outside Haflaway) so SMS for that org is
billed to their own account. Unplugging falls back to Haflaway's shared
parent credentials immediately. All credential CRUD moves from Firebase
Functions into `haflaway_server`, which already owns credential *consumption*
(`resolveOrgSmsCredentials` in `server/src/dispatch/sms.js`).

Check items off (`- [ ]` -> `- [x]`) as they land. One PR per phase is fine;
don't flip Phase 4 until Phase 1-3 are verified against a real org.

## Phase 1 — shared credentials store module

- [x] Create `server/src/organizations/smsCredentials.js` with the actual
      Firestore CRUD, ported from `functions/organizations/smsCredentials.js`:
      - `CREDENTIAL_FIELDS` map (`smtz: ['apiKey']`, `wasambazie: ['publicKey', 'secretKey']`)
      - `assertKnownProvider(provider)`
      - `setCredentials(orgId, provider, credentials)` — full replace, trims
        and requires every field, stamps `updatedAt`/`updatedBy`
      - `clearCredentials(orgId, provider)` — deletes the provider doc
      - `getStatus(orgId)` — returns `{ smtz: {configured, updatedAt}, wasambazie: {...} }`,
        never the secret values
      - `getCredentials(orgId, provider)` — returns the raw secret fields for
        internal use only (this is what dispatch needs)
- [x] Update `server/src/dispatch/sms.js`'s `resolveOrgSmsCredentials` to call
      `getCredentials()` from the new module instead of querying Firestore
      inline — one source of truth for the storage path
      (`organizations/{orgId}/smsCredentials/{provider}`) instead of two
      copies of that path string.
- [x] Keep the existing fallback-to-`process.env` behavior in
      `resolveOrgSmsCredentials` unchanged (including "any read error ->
      fall back to default" — availability over strictness, matches
      `resolveSenderIdForEvent`).

## Phase 2 — org-owner auth middleware

- [x] Create `server/src/middleware/orgAccess.js` with `requireOrgOwner`,
      mirroring `requireEventAccess`'s shape: load `organizations/:orgId`,
      404 if missing, 403 if `org.ownerId !== req.uid`, else `next()`.
      (`requireAuth` already verifies the Firebase ID token and sets
      `req.uid` — reuse it, don't re-verify.)

## Phase 3 — HTTP routes

- [x] Create `server/src/routes/organizations.js`:
      - `POST /organizations/:orgId/sms-credentials` — body
        `{ provider, credentials }`, `requireAuth` + `requireOrgOwner`,
        calls `setCredentials`, returns `{ ok: true, provider, configured: true }`
      - `DELETE /organizations/:orgId/sms-credentials/:provider` —
        `requireAuth` + `requireOrgOwner`, calls `clearCredentials`
      - `GET /organizations/:orgId/sms-credentials/status` —
        `requireAuth` + `requireOrgOwner`, calls `getStatus`
      - Same validation errors as the old callables (unknown provider,
        missing field) as 400s with `{ ok: false, message }`, matching the
        JSON error shape the rest of `server/src/routes/*` already uses.
- [x] Wire the router into `server/src/index.js`
      (`app.use(organizationsRoutes)`, next to the other `app.use(...Routes)` lines).

## Phase 4 — SPA switch-over

- [x] In `haflaway_spa/src/composables/useOrg.js`, replace the three
      `httpsCallable(functions, '...')` calls (`setOrgSmsCredentials`,
      `clearOrgSmsCredentials`, `getOrgSmsCredentialsStatus`) with `fetch()`
      calls against `CARD_SERVER_URL` + `Authorization: Bearer <idToken>`,
      the same pattern `EventCampaigns.vue` already uses
      (`import.meta.env.VITE_CARD_SERVER_URL || 'http://localhost:8080'`,
      `await user.getIdToken()`). Added a small `callOrgServer()` helper in
      `useOrg.js` so the three calls share the same fetch/auth/error-unwrap
      logic instead of repeating it three times.
- [x] No UI changes needed in `OrganizationSettings.vue` — it only talks to
      `useOrg.js`'s exported functions, so the swap is contained. Confirmed:
      grepped the SPA for the old callable names, zero remaining references.
- [ ] Manual test against a local `haflaway_server`: save smtz key -> chip
      flips to "Configured" -> send a test SMS for that org and confirm the
      request actually goes out with the org's key (check
      `messageLogs/{id}.apiProvider` / a log line) -> clear it -> chip flips
      back to "Using shared default" -> next send uses the Haflaway
      env-var credentials with no other action needed.
      **Not yet run — do this before touching Phase 5.**

## Phase 5 — decommission the Functions path

Only after Phase 4 is verified working end-to-end (don't leave two writers
on the same Firestore path longer than needed for the cutover):

- [ ] Remove `setOrgSmsCredentials` / `clearOrgSmsCredentials` /
      `getOrgSmsCredentialsStatus` exports from `functions/index.js`
- [ ] Delete `functions/organizations/smsCredentials.js`
- [ ] Redeploy functions so the old callables actually stop being reachable
      (removing the export alone doesn't undeploy an already-live function)
- [ ] Grep the SPA once more for `setOrgSmsCredentials|clearOrgSmsCredentials|getOrgSmsCredentialsStatus`
      to confirm nothing still calls the old callables

## Open questions to resolve before/while wiring this up

- [ ] Does `haflaway_server` currently sit behind anything that would block
      the SPA's admin origin from calling it (CORS is `cors()` wide-open per
      `index.js:9`, so probably fine, but confirm once it's the real VPS
      domain — ties into the pending TLS/CORS/subdomain work noted for the
      VPS migration)
- [ ] Should `setCredentials` do any live validation (e.g. a cheap
      test call to smtz/wasambazie to confirm the key actually works) before
      accepting it, or stay dumb-store like today? (today's Functions
      version doesn't validate against the provider, just requires
      non-empty fields — keeping that scope unless you want it extended)

---

# Self-service sender IDs, scoped to BYO credentials

Follow-up to the above: once an org has plugged in their own smtz/wasambazie
credentials, let them freely add/remove their own sender IDs against that
provider — no Haflaway staff review, since it's their own carrier account and
their own liability. Decided via two scope questions (2026-09-17):

1. Self-service applies **only** to a provider once that provider's
   credentials are configured for the org — not globally.
2. Orgs still on Haflaway's shared account get **no custom sender ID at all**
   — they always send as HAFLAWAY. The old staff-reviewed approval flow
   (`functions/organizations/senderId.js` — `requestOrgSenderId`,
   `reviewOrgSenderId`, `setOrgDefaultSenderId`) is retired, not relocated.

Also renamed the "SMS Providers" tab to "Messaging Providers" and removed the
standalone "Sender IDs" tab — sender IDs now live inline inside each
provider's card in that tab.

## Data model

- [x] Sender IDs moved from an org-wide, staff-reviewed subcollection
      (`organizations/{orgId}/senderIds/{value}` with a pending/approved/
      rejected/revoked status) to a map field living **on the credentials
      doc itself**: `organizations/{orgId}/smsCredentials/{provider}.senderIds
      = { [VALUE]: { addedAt, addedBy } }`, plus a sibling `defaultSenderId`
      field. A sender ID only means something against the provider account
      it was registered with, so it now lives and dies with that provider's
      own credentials — clearing credentials clears the pool (see
      `clearCredentials` in `server/src/organizations/smsCredentials.js`).

## Server (`haflaway_server`)

- [x] `server/src/organizations/smsCredentials.js`: added
      `normalizeSenderId`, `validateSenderId` (same GSM alphanumeric rules
      as the old flow — 3–11 chars, letters+digits, no leading digit),
      `addSenderId`, `removeSenderId` (auto-promotes a new default when the
      current one is removed), `getSenderPool` (read-only, used by dispatch).
      `getStatus` now also returns each provider's `senderIds`/
      `defaultSenderId` and a top-level `activeProvider` (whichever provider
      Haflaway currently routes SMS through platform-wide — a pool only has
      any effect while its provider is the active one).
- [x] `server/src/middleware/orgAccess.js`: added `requireOrgMember`
      (owner OR any `memberIds` entry) — looser than `requireOrgOwner`,
      used only for the GET status route since a non-owner org member still
      needs to read the sender-ID pool for their own event's picker.
- [x] `server/src/routes/organizations.js`: GET status route now uses
      `requireOrgMember` instead of `requireOrgOwner`; added
      `POST /organizations/:orgId/sms-credentials/:provider/sender-ids` and
      `DELETE .../sender-ids/:senderId`, both still `requireOrgOwner`.
- [x] `server/src/dispatch/senderId.js`: rewritten around the new pool
      shape. `resolveSenderIdForEvent(event, providerName)` — note the
      signature gained `providerName`, since a sender ID is provider-scoped
      now (call site updated in `routes/campaigns.js`).
- [x] `server/src/routes/campaigns.js`: added
      `POST /events/:eventId/sender-id` (pin/clear one event's sender ID),
      gated by the same `requireEventAccess` (author-only) the send route
      already uses — inherits that route's known team-access gap rather
      than widening or narrowing it.

## Functions (retired, not moved)

- [x] Removed `requestOrgSenderId`, `reviewOrgSenderId`,
      `setOrgDefaultSenderId`, `setEventSenderId` exports from
      `functions/index.js`. Left `functions/organizations/senderId.js` on
      disk (unexported) rather than deleting it outright.
- [ ] **Action needed, not yet done:** actually run `firebase deploy
      --only functions` (or however this project deploys) so the four
      now-unexported callables stop being reachable. Removing an export from
      `index.js` does NOT undeploy an already-live Cloud Function — it's
      still callable by anyone who has (or guesses) its URL/name until a
      real deploy happens.
- [ ] **Heads-up, needs a human check:** `reviewOrgSenderId` was the only
      approval path for the old flow and is gated on `clearanceLevel >= 5`
      staff accounts. Nothing in `haflaway_spa` or `haflaway_server` calls
      it (confirmed by grep), so it's presumably driven by a separate staff
      console not in this repo. If that console still exists and staff
      still use it to approve sender IDs, undeploying this callable will
      break that tool with no warning from inside this codebase — worth
      confirming with whoever owns that console before the deploy above.
- [ ] Left `functions/utils/senderId.js` (DEFAULT_SENDER_ID, validateSenderId,
      the old `resolveSenderIdForEvent`) untouched — still imported by the
      legacy `functions/sms/*.js` dispatch path (indesms.js, scanpromo.js,
      beem.js, onfon.js, smtz.js, wasambazie.js) and
      `functions/organizations/migrateSenderIds.js`. Out of scope here;
      that legacy path is superseded by `haflaway_server`'s dispatch but
      still deployed for delivery-report webhooks per its own comments.

## SPA (`haflaway_spa`)

- [x] `useOrg.js`: removed the live Firestore listener on
      `organizations/{id}/senderIds`, `pendingSenderIds`, `activeSenderId`,
      `hasCustomSenderId`, `requestSenderId`, `setDefaultSenderId` (old).
      `approvedSenderIds`/`defaultSenderId` now derive from
      `smsCredentialsStatus[activeSmsProvider]` — same `{id, value}` shape
      as before, so `EventSettings.vue` needed **zero** changes.
      `setEventSenderId` now calls the new server route instead of a
      Firebase callable. Added `addSenderId`/`removeSenderId`.
      `loadSmsCredentialsStatus` no longer gated on `isOwner` — loads for
      any member, since the sender-ID pool feeds `EventSettings.vue` too.
- [x] `OrganizationSettings.vue`: tab renamed "SMS Providers" → "Messaging
      Providers"; standalone "Sender IDs" tab deleted entirely; each
      provider card now shows its own sender-ID chip list (add/remove
      inline, "Default" badge) once that provider is `configured`, with a
      hint to configure credentials first when it isn't.
- [ ] Manual test once `haflaway_server` is running locally: configure smtz
      → sender-ID mini-section appears on the smtz card → add one → chip
      shows up, marked Default → add a second → first stays Default → remove
      the default → the second one is promoted → clear smtz credentials →
      whole sender-ID section disappears (pool wiped) → confirm via
      `EventSettings.vue` that the event's SMS Sender ID panel reflects the
      same pool and hides entirely when the pool is empty.
      **Not yet run.**

---

# Org's own provider wins over the platform switch; migrate the plain-SMS
# path off the legacy Cloud Function

Found while manually testing: an org with only wasambazie configured had its
SMS actually go out through Haflaway's shared account instead, because
`getActiveSmsProvider()` picked whichever provider is flagged `isActive`
platform-wide, ignoring what the org itself had configured. Separately, a
plain-text (no card) SMS campaign never even reached that logic at all — it
was going through `functions/sms/indesms.js` (`sendSMSAction`, a legacy
Cloud Function at `SMS_URL`), a second, untouched dispatch path with zero
awareness of org credentials.

## Fix 1 — org's configured provider always wins

- [x] `server/src/organizations/smsCredentials.js`: added
      `getPlatformActiveProvider()`, `getConfiguredProviders(orgId)`,
      `resolveEffectiveProvider(configured, platformActive)` (pure — org's
      own provider wins if configured; if it's configured both, whichever
      matches the platform switch wins; if neither matches, falls back to
      smtz then wasambazie), and `resolveProviderForOrg(orgId, platformActive)`
      (Firestore-backed wrapper). `getStatus()` now returns both
      `platformActiveProvider` (the raw switch) and `activeProvider` (the
      org-aware effective one — same key name the SPA already reads, now
      correctly org-aware instead of a raw copy of the switch).
- [x] `server/src/routes/campaigns.js`: `processRun` resolves
      `smsProviderName` once per batch via `resolveProviderForOrg` and
      threads it through to every `dispatchAndLog` call and to
      `resolveSenderIdForEvent`, so sender-ID resolution and the actual send
      can never disagree about which provider is in use. The
      `POST /events/:eventId/sender-id` pin route does the same.
- [x] Verified with direct calls: `resolveEffectiveProvider([], 'smtz') →
      'smtz'`; `(['wasambazie'], 'smtz') → 'wasambazie'`;
      `(['smtz','wasambazie'], 'smtz') → 'smtz'`;
      `(['smtz','wasambazie'], 'beem') → 'smtz'`.
- [ ] Judgment call, not confirmed with the user: the both-configured/
      neither-matches-platform tiebreak defaults to smtz. Flag if wasambazie
      should win instead, or if the org should get an explicit "primary
      provider" toggle.

## Fix 2 — migrate the plain-SMS (no card) send path onto haflaway_server

Scoped to SMS only — WhatsApp's card-less path stays on its legacy Cloud
Function (`sendWhatsAppInvitationMessages`); there's no BYO-credential
concept for WhatsApp, so nothing there was actually broken.

- [x] `server/src/routes/campaigns.js`: `purpose` is no longer required for
      `channel: 'sms'` (still required for `whatsapp`, which always needs an
      approved template). `dispatchAndLog` only requires/reads a rendered
      card when `purpose` is truthy — `cardUrl`/`cardName` stay `undefined`
      otherwise, which `refineMessage()`'s `{{card}}` substitution already
      tolerates. `processRun` skips `renderAttendeeCard` entirely when
      there's no `purpose`, and fails fast if a plain campaign has no
      `smsMessage` set on its campaign doc (no purpose-based default to fall
      back to).
- [x] `haflaway_spa/src/views/event/EventCampaigns.vue`: added
      `executeSendPlainSms()` (mirrors `executeCardSend()`'s pattern — POST
      to the same `/events/:eventId/campaigns/:campaignId/send`, no
      `purpose` in the body, `watchSendRun()` for live progress) and wired
      `executeSend()`'s SMS-without-`cardPurpose` branch to call it instead
      of building a request to the legacy `SMS_URL`. Removed the now-unused
      `SMS_URL` constant. The remaining inline fetch in `executeSend()` only
      ever handles WhatsApp now (`kardType` hardcoded `null` there, since
      cardPurpose is always handled earlier).
- [ ] **Not yet tested end-to-end** — need a real plain-text (no card)
      SMS campaign sent through an org with BYO wasambazie/smtz credentials,
      confirmed as actually landing in that provider's own dashboard (this
      is exactly the scenario that surfaced both bugs above).
- [ ] `functions/sms/indesms.js` (`sendSMSAction`) is now unused by the SPA
      for SMS specifically, but was left running/deployed — not undeployed
      here. Same caution as the sender-ID Functions above: confirm nothing
      else calls it directly before retiring it.

---

# Gate BYO credentials behind branding approval (2026-09-21)

Decided: saving valid smtz/wasambazie keys is no longer sufficient on its
own for an org's own account to actually be used. It now has to clear the
same trust gate `haflaway_admin_spa`'s Organizations view already surfaces
as the "Approved"/"Not approved" branding pill —
`organizations/{orgId}.brandingApproved === true`. Order of checks: 1)
branding approved? 2) credentials configured? 3) only then does the
existing platform-switch tiebreak (`resolveEffectiveProvider`) apply.

- [x] `server/src/organizations/smsCredentials.js`: added
      `isBrandingApproved(orgId)`. `getConfiguredProviders(orgId)` now
      returns `[]` outright for an unapproved org, regardless of what's
      saved — this is what `resolveProviderForOrg` (dispatch) keys off of.
      `getCredentials(orgId, provider)` — the one place dispatch reads
      secret values back out (also underlies `getSenderPool`) — now returns
      `null` for an unapproved org, so `resolveOrgSmsCredentials`
      (dispatch/sms.js) and sender-ID resolution (dispatch/senderId.js)
      can't accidentally pick up an org's own creds/pool even if the
      resolved provider name happens to match one they've saved keys for.
      `getStatus(orgId)` now also returns `brandingApproved`, and its
      `activeProvider` is branding-gated the same way — but each provider's
      `configured` badge stays a raw reflection of what's saved, so an
      owner can see their keys took before approval lands.
- [x] Owners can still save/clear credentials and manage their sender-ID
      pool before approval (routes/organizations.js's CRUD routes don't go
      through `getCredentials`) — only *consumption* at send time is gated,
      so everything's ready to go the moment staff approves.
- [ ] **Not yet done:** `haflaway_admin_spa`'s OrganizationSettings/
      Messaging Providers surface (SPA, not admin) doesn't yet show
      anything when an org has saved valid keys but branding isn't
      approved — worth a "pending approval" hint using the new
      `brandingApproved` field in the status response, otherwise an owner
      who configured everything correctly has no way to tell why their
      sends still go out as HAFLAWAY.
- [ ] **Not yet tested end-to-end** — need a real send for an org with
      valid saved credentials while `brandingApproved` is false (confirm it
      goes out on Haflaway's shared account) and again after approving
      (confirm it switches to the org's own account on the very next send).

## Known trade-off, not addressed here

Existing orgs that had a custom sender ID **approved under the old flow**
lose it the moment this ships — `dispatch/senderId.js` no longer reads the
old `organizations/{orgId}/senderIds` subcollection at all, so any org still
on Haflaway's shared account reverts to sending as HAFLAWAY even if it
previously had e.g. `GUSTANZA` approved. No migration script was written for
this (matches the decision to drop the shared-account case rather than port
it forward) — worth a heads-up to any org owner who currently has one of
these approved, before this reaches them, since it'll look like a silent
regression from their side.
