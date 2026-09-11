const { getDb } = require('../firebase')

// requireAuth only establishes WHO is calling — this checks whether that
// person is actually allowed to touch :eventId. Baseline check only: the
// verified uid must be the event's authorId. This does NOT yet account for
// team/org-shared access (EventTeam.vue suggests events can have collaborators
// beyond a single owner) — if that's a real access path in this app, extend
// this check accordingly. Without it at all, any signed-up Firebase user
// could render cards and trigger a real, billed campaign send for ANY event.
async function requireEventAccess(req, res, next) {
  const { eventId } = req.params
  try {
    const eventSnap = await getDb().collection('events').doc(eventId).get()
    if (!eventSnap.exists) {
      return res.status(404).json({ ok: false, message: `Event ${eventId} not found.` })
    }
    if (eventSnap.data().authorId !== req.uid) {
      return res.status(403).json({ ok: false, message: 'Not authorized for this event.' })
    }
    next()
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message })
  }
}

module.exports = { requireEventAccess }
