const express = require('express')
const { requireAuth } = require('../middleware/auth')
const { requireOrgOwner, requireOrgMember } = require('../middleware/orgAccess')
const {
  setCredentials, clearCredentials, getStatus, assertKnownProvider,
  addSenderId, removeSenderId,
} = require('../organizations/smsCredentials')
const {
  setCredentials: setTwilioCredentials, clearCredentials: clearTwilioCredentials, getStatus: getTwilioStatus,
  setTemplate, removeTemplate, assertKnownCategory, assertKnownLanguage,
  getCredentialsForOwnerTest, getTemplateForOwnerTest,
} = require('../organizations/twilioCredentials')
const { sendWhatsAppTestMessage } = require('../dispatch/whatsapp')

const router = express.Router()

// Owner brings their own smtz/wasambazie account credentials so this org's
// SMS is billed to that account instead of Haflaway's shared one. See
// server/TODO_ORG_SMS_CREDENTIALS.md for the full feature writeup.
router.post('/organizations/:orgId/sms-credentials', requireAuth, requireOrgOwner, async (req, res) => {
  const { provider, credentials } = req.body || {}
  try {
    assertKnownProvider(provider)
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message })
  }
  try {
    const result = await setCredentials(req.params.orgId, provider, credentials, req.uid)
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message })
  }
})

// Unplugging — the org's next SMS send falls back to Haflaway's shared
// credentials immediately (dispatch/sms.js re-reads on every send, nothing
// cached).
router.delete('/organizations/:orgId/sms-credentials/:provider', requireAuth, requireOrgOwner, async (req, res) => {
  try {
    assertKnownProvider(req.params.provider)
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message })
  }
  try {
    const result = await clearCredentials(req.params.orgId, req.params.provider)
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message })
  }
})

// Never returns the secret values — only whether each provider has an
// org-specific override configured, its (non-secret) sender-ID pool, and
// which provider is currently active platform-wide. Any org member can read
// this (not owner-only) — EventSettings.vue's sender-ID picker needs it for
// whichever member owns a given event, and none of this is sensitive.
router.get('/organizations/:orgId/sms-credentials/status', requireAuth, requireOrgMember, async (req, res) => {
  try {
    const status = await getStatus(req.params.orgId)
    res.json({ ok: true, ...status })
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message })
  }
})

// Self-service sender IDs — the org registered this directly with the
// provider on their own account, so there's no staff review step. Requires
// that provider's credentials to already be configured (see addSenderId).
router.post('/organizations/:orgId/sms-credentials/:provider/sender-ids', requireAuth, requireOrgOwner, async (req, res) => {
  try {
    assertKnownProvider(req.params.provider)
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message })
  }
  try {
    const result = await addSenderId(req.params.orgId, req.params.provider, req.body?.senderId, req.uid)
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message })
  }
})

router.delete('/organizations/:orgId/sms-credentials/:provider/sender-ids/:senderId', requireAuth, requireOrgOwner, async (req, res) => {
  try {
    assertKnownProvider(req.params.provider)
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message })
  }
  try {
    const result = await removeSenderId(req.params.orgId, req.params.provider, req.params.senderId)
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message })
  }
})

// Owner brings their own Twilio account (with its own WhatsApp-enabled
// sender and its own Meta-approved Content Templates) so this org's WhatsApp
// is billed to that account instead of Haflaway's shared one. See
// server/TODO_ORG_WHATSAPP_CREDENTIALS.md for the full feature writeup.
router.post('/organizations/:orgId/twilio-credentials', requireAuth, requireOrgOwner, async (req, res) => {
  try {
    const result = await setTwilioCredentials(req.params.orgId, req.body?.credentials, req.uid)
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message })
  }
})

// Unplugging also wipes every template registered against these credentials
// (see clearCredentials in organizations/twilioCredentials.js) — the org's
// next WhatsApp send falls back to Haflaway's shared account immediately.
router.delete('/organizations/:orgId/twilio-credentials', requireAuth, requireOrgOwner, async (req, res) => {
  try {
    const result = await clearTwilioCredentials(req.params.orgId)
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message })
  }
})

// Never returns the secret values — only whether Twilio credentials are
// configured and the (non-secret) template mapping. Any org member can read
// this, matching the SMS status route's reasoning.
router.get('/organizations/:orgId/twilio-credentials/status', requireAuth, requireOrgMember, async (req, res) => {
  try {
    const status = await getTwilioStatus(req.params.orgId)
    res.json({ ok: true, ...status })
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message })
  }
})

// Self-service template registration — the org already got this Content
// Template approved directly with Twilio/Meta on their own account, so
// there's no staff review step. Requires Twilio credentials to already be
// configured (see setTemplate).
router.post('/organizations/:orgId/whatsapp-templates', requireAuth, requireOrgOwner, async (req, res) => {
  const { category, language, contentSid } = req.body || {}
  try {
    const result = await setTemplate(req.params.orgId, category, language, contentSid, req.uid)
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message })
  }
})

router.delete('/organizations/:orgId/whatsapp-templates/:category/:language', requireAuth, requireOrgOwner, async (req, res) => {
  try {
    assertKnownCategory(req.params.category)
    assertKnownLanguage(req.params.language)
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message })
  }
  try {
    const result = await removeTemplate(req.params.orgId, req.params.category, req.params.language)
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message })
  }
})

// Lets the owner confirm a registered template actually renders correctly —
// using the org's own credentials and its own registered contentSid — before
// staff approval lands and before it's ever used on a real guest. Not
// gated on branding approval (getCredentialsForOwnerTest/
// getTemplateForOwnerTest deliberately skip that check) since the whole
// point is to self-verify ahead of approval; it can never reach Haflaway's
// shared account regardless, since it always uses the org's own credentials.
router.post('/organizations/:orgId/whatsapp-templates/:category/:language/test-send', requireAuth, requireOrgOwner, async (req, res) => {
  const { orgId, category, language } = req.params
  const { to } = req.body || {}
  try {
    assertKnownCategory(category)
    assertKnownLanguage(language)
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message })
  }
  if (!to || !String(to).trim()) {
    return res.status(400).json({ ok: false, message: 'Enter a WhatsApp number to send the test to.' })
  }
  try {
    const [credentials, template] = await Promise.all([
      getCredentialsForOwnerTest(orgId),
      getTemplateForOwnerTest(orgId, category, language),
    ])
    if (!credentials) return res.status(400).json({ ok: false, message: 'Configure your Twilio credentials above first.' })
    if (!template) return res.status(400).json({ ok: false, message: 'Register a Content SID for this category/language first.' })
    const result = await sendWhatsAppTestMessage({ credentials, contentSid: template.contentSid, to: String(to).trim() })
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message })
  }
})

module.exports = router
