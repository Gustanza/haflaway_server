const express = require('express')
const { getDb } = require('../firebase')
const { requireAuth } = require('../middleware/auth')
const { requireStaffSection } = require('../middleware/staffAccess')
const {
  MESSAGING_CHANNELS, MESSAGING_MODES, getMessagingModes, setMessagingMode, getMessagingHistory,
} = require('../organizations/messagingAccounts')
const { getStatus: getSmsStatus } = require('../organizations/smsCredentials')
const { getStatus: getTwilioStatus } = require('../organizations/twilioCredentials')

// Staff-only routes for haflaway_admin_spa. Everything here is behind the
// same gate as the console's Organizations section (middleware/staffAccess.js).
const router = express.Router()
const requireOrgsStaff = requireStaffSection('organizations')

async function assertOrgExists(orgId) {
  const snap = await getDb().collection('organizations').doc(orgId).get()
  if (!snap.exists) {
    const err = new Error(`Organization ${orgId} not found.`)
    err.status = 404
    throw err
  }
}

// What an org has set up on its own accounts — enough for staff to judge
// whether switching a channel to 'own' will actually work, without ever
// exposing a secret value (both getStatus calls are secret-free).
async function readiness(orgId) {
  const [twilio, sms] = await Promise.all([getTwilioStatus(orgId), getSmsStatus(orgId)])
  const ownSmsProviders = ['smtz', 'wasambazie'].filter(p => sms[p]?.configured)
  return {
    whatsapp: {
      credentialsConfigured: twilio.configured,
      templates: twilio.templates.map(t => ({
        category: t.category, language: t.language, name: t.name ?? null, active: t.active !== false,
      })),
    },
    sms: {
      ownProviders: ownSmsProviders.map(p => ({ provider: p, senderIds: sms[p].senderIds })),
      platformActiveProvider: sms.platformActiveProvider,
    },
  }
}

router.get('/admin/organizations/:orgId/messaging-accounts', requireAuth, requireOrgsStaff, async (req, res) => {
  const { orgId } = req.params
  try {
    await assertOrgExists(orgId)
    const [modes, ready, history] = await Promise.all([
      getMessagingModes(orgId), readiness(orgId), getMessagingHistory(orgId),
    ])
    res.json({ ok: true, modes, readiness: ready, history })
  } catch (e) {
    res.status(e.status ?? 500).json({ ok: false, message: e.message })
  }
})

// Flips one channel. Switching to 'own' requires the org's own credentials
// for that channel to be saved already — otherwise every send would just be
// refused. Missing templates / sender IDs are allowed (the org may add them
// afterwards; sends needing them are refused until then) and are surfaced
// in readiness for staff to see.
router.post('/admin/organizations/:orgId/messaging-accounts', requireAuth, requireOrgsStaff, async (req, res) => {
  const { orgId } = req.params
  const { channel, mode, note } = req.body || {}
  if (!MESSAGING_CHANNELS.includes(channel)) {
    return res.status(400).json({ ok: false, message: `channel must be one of: ${MESSAGING_CHANNELS.join(', ')}.` })
  }
  if (!MESSAGING_MODES.includes(mode)) {
    return res.status(400).json({ ok: false, message: `mode must be one of: ${MESSAGING_MODES.join(', ')}.` })
  }
  try {
    await assertOrgExists(orgId)
    if (mode === 'own') {
      const ready = await readiness(orgId)
      if (channel === 'whatsapp' && !ready.whatsapp.credentialsConfigured) {
        return res.status(400).json({ ok: false, message: "This organization hasn't saved its own Twilio credentials yet." })
      }
      if (channel === 'sms' && !ready.sms.ownProviders.length) {
        return res.status(400).json({ ok: false, message: "This organization hasn't saved its own smtz or wasambazie credentials yet." })
      }
    }
    await setMessagingMode(orgId, channel, mode, req.staff, note)
    const [modes, history] = await Promise.all([getMessagingModes(orgId), getMessagingHistory(orgId)])
    res.json({ ok: true, modes, history })
  } catch (e) {
    res.status(e.status ?? 400).json({ ok: false, message: e.message })
  }
})

module.exports = router
