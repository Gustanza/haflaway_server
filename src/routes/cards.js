const express = require('express')
const { requireAuth } = require('../middleware/auth')
const { requireEventAccess } = require('../middleware/eventAccess')
const { renderAttendeeCard } = require('../render/renderAttendeeCard')

const router = express.Router()

// The second of the two render triggers we settled on — "view time" — used
// whenever someone wants to look at one specific guest's card. Send-time
// rendering happens internally inside the campaigns/send batch, not here.
router.post('/events/:eventId/attendees/:attendeeId/cards/:purpose/render', requireAuth, requireEventAccess, async (req, res) => {
  const { eventId, attendeeId, purpose } = req.params
  const force = req.body?.force === true
  try {
    const result = await renderAttendeeCard(eventId, attendeeId, purpose, { force })
    res.json({ ok: true, ...result })
  } catch (e) {
    console.error(`render ${eventId}/${attendeeId}/${purpose}:`, e)
    res.status(500).json({ ok: false, message: e.message })
  }
})

module.exports = router
