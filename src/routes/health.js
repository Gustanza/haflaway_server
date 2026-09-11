const express = require('express')
const { getDb } = require('../firebase')

const router = express.Router()

// Plain liveness check — confirms the process is up. No Firebase involved,
// so this stays green even if credentials are misconfigured.
router.get('/health', (req, res) => {
  res.json({ ok: true, service: 'haflaway-card-server', time: new Date().toISOString() })
})

// Confirms the service account actually has working Firestore access —
// hit this after wiring up credentials to sanity-check the whole chain.
router.get('/health/firebase', async (req, res) => {
  try {
    const snap = await getDb().collection('events').limit(1).get()
    res.json({ ok: true, firestoreReachable: true, sampleDocCount: snap.size })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

module.exports = router
