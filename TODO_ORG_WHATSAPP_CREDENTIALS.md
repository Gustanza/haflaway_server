# Org-owned Twilio credentials + WhatsApp template mapping

Goal: orgs can plug in their own Twilio account (own WhatsApp-enabled sender,
own Meta-approved Content Templates) so WhatsApp for that org is billed to
their own account. Unlike smtz/wasambazie SMS, a Twilio Content Template's
`contentSid` only exists inside the Twilio account it was approved in — so an
org's own credentials and an org's own template only mean anything *together*.
See the 2026-09-22/23 conversation this was designed in for the full
discussion (scope: WhatsApp only, not a third SMS provider; scoped API
Key/Secret, not raw Account SID + Auth Token; org self-registers templates, no
staff/automated validation, but a self-test-send button; BYO WhatsApp still
charges full Haflaway credits, same as BYO SMS).

## Phase 1 — shared category constants

- [x] `server/src/dispatch/whatsappTemplateCategories.js` — pulled
      `WHATSAPP_TEMPLATE_CATEGORY_BY_PURPOSE` out of `routes/campaigns.js` so
      both campaigns.js and the new organizations module can validate against
      the same 4-category list without importing each other.

## Phase 2 — credentials + template store module

- [x] `server/src/organizations/twilioCredentials.js`:
      - `setCredentials(orgId, credentials, updatedBy)` — full replace of
        `{ accountSid, apiKeySid, apiKeySecret, whatsappSender }`, stored at
        `organizations/{orgId}/twilioCredentials/whatsapp`.
      - `clearCredentials(orgId)` — deletes the credentials doc AND every
        template registered against it in one batch (a contentSid is
        meaningless once its account is unplugged).
      - `getStatus(orgId)` — `{ configured, updatedAt, templates, brandingApproved }`,
        never the secret values.
      - `getCredentials(orgId)` / `getTemplate(orgId, category, language)` —
        internal, branding-approval-gated (imports `isBrandingApproved` from
        `smsCredentials.js` rather than re-implementing it) — the one place
        dispatch reads secrets/contentSids back out.
      - `getCredentialsForOwnerTest` / `getTemplateForOwnerTest` —
        deliberately bypass the branding gate, used ONLY by the owner's
        self-test-send route so they can verify a template before approval
        lands. Never call these from real campaign dispatch.
      - `setTemplate(orgId, category, language, contentSid, addedBy)` —
        owner self-service, requires credentials already configured.
      - `removeTemplate(orgId, category, language)`.

## Phase 3 — HTTP routes

- [x] `server/src/routes/organizations.js`:
      - `POST /organizations/:orgId/twilio-credentials` (owner)
      - `DELETE /organizations/:orgId/twilio-credentials` (owner)
      - `GET /organizations/:orgId/twilio-credentials/status` (any member)
      - `POST /organizations/:orgId/whatsapp-templates` (owner)
      - `DELETE /organizations/:orgId/whatsapp-templates/:category/:language` (owner)
      - `POST /organizations/:orgId/whatsapp-templates/:category/:language/test-send`
        (owner) — body `{ to }`, sends a synthetic test message via the org's
        own credentials, bypassing branding approval and billing entirely.

## Phase 4 — dispatch resolution

- [x] `server/src/dispatch/whatsapp.js`:
      - `sendWhatsAppCard` now accepts a `credentials` param and resolves a
        Twilio client per send (`resolveTwilioClient`) — an org's own API
        Key/Secret if given, else the cached shared platform client.
      - `resolveOrgWhatsAppCredentials(orgId)` — mirrors
        `resolveOrgSmsCredentials` in `dispatch/sms.js`; returns `null`
        (meaning "use the shared account") on any lookup failure.
      - `sendWhatsAppTestMessage` — the self-test-send primitive, synthetic
        placeholder content variables, never touches messageLogs or billing.
- [x] `server/src/routes/campaigns.js`'s `processRun`: when no `templateId`
      was passed in from the SPA's own picker, tries the org's own
      template+credentials together first (atomic — never pairs an org's
      contentSid with Haflaway's shared account or vice versa); falls through
      to the shared `messageTemplates` library + shared account per-category
      if the org hasn't registered that exact category+language. Threaded
      through `dispatchAndLog` to `sendWhatsAppCard`.
      `messageLogs` docs now also record `viaOrgCredentials` (bool) for
      debugging which account a send actually went out on.

## Phase 5 — billing

- [x] No changes — `chargeAmount`/`baseDispatchCost('whatsapp')` already
      charge per message regardless of provider, matching the agreed decision
      that BYO WhatsApp still costs the org full Haflaway credits.

## Phase 6 — SPA UI

- [x] `haflaway_spa/src/composables/useOrg.js`: `twilioCredentialsStatus`,
      `loadTwilioCredentialsStatus`, `setTwilioCredentials`,
      `clearTwilioCredentials`, `setWhatsAppTemplate`,
      `removeWhatsAppTemplate`, `testSendWhatsAppTemplate`, plus
      `WHATSAPP_TEMPLATE_CATEGORIES`/`WHATSAPP_TEMPLATE_LANGUAGES` constants
      (kept in sync by hand with `whatsappTemplateCategories.js` — no shared
      module tree between the SPA and the server).
- [x] `haflaway_spa/src/views/OrganizationSettings.vue`: new "Twilio
      (WhatsApp)" provider card in the Messaging Providers tab, same visual
      pattern as the smtz/wasambazie cards — Account SID / API Key SID / API
      Key Secret / WhatsApp sender fields, "Configured"/"Using shared
      default" chip. Once configured, an inline template-mapping list
      (category + language + Content SID, add/remove) with a per-template
      "Test send" row (phone number input + button, result message inline).

## Not yet done / needs a real end-to-end test

- [ ] **Manual test against a local `haflaway_server`:** configure Twilio
      credentials for a test org → chip flips to "Configured" → register a
      template → test-send it to a real WhatsApp number and confirm it
      arrives correctly formatted → run a real campaign send *before*
      approving branding (confirm it still goes out on Haflaway's shared
      account/template) → approve branding → send again (confirm it switches
      to the org's own account/template on the very next send) → clear
      credentials (confirm templates are wiped and it reverts to shared
      immediately).
- [ ] **Judgment call, not confirmed with the user:** the per-category
      fallback means an org could have `invitation` covered by their own
      template while `thank_you` silently falls back to Haflaway's shared
      template/account within the same campaign batch, if different
      campaigns use different purposes. This is the intended design (see the
      design discussion) but hasn't been observed in a real mixed-purpose
      send yet.
- [ ] `server/.env.example` still only documents the shared
      `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_WHATSAPP_NUMBER` trio —
      no org-level env vars needed (everything org-specific lives in
      Firestore), so no changes made there, but worth a comment update if it
      causes confusion later.
