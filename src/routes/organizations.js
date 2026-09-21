const express = require('express')
const { requireAuth } = require('../middleware/auth')
const { requireOrgOwner, requireOrgMember } = require('../middleware/orgAccess')
const {
  setCredentials, clearCredentials, getStatus, assertKnownProvider,
  addSenderId, removeSenderId,
} = require('../organizations/smsCredentials')

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

module.exports = router
