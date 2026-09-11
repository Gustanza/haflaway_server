// Looks up a card blueprint the same way functions/attendees/attendees.js
// does — one doc at events/{eventId}/cards/{cardId} carrying `type` (the
// organizer-facing template name), `constraints` (the renderer's templateJson:
// pages/elements), and `templateUrl` (the background PDF). Our new Send flow
// only knows the *purpose* (invitation/save_the_date/...), not a specific
// templateCardId, so this resolves by purpose — reusing the same blueprint
// the Guest List's own existence check already found.
const { getDb } = require('../firebase')

async function resolveTemplateByPurpose(eventId, purpose) {
  const db = getDb()
  const snap = await db
    .collection('events').doc(eventId)
    .collection('cards')
    .where('purpose', '==', purpose)
    .limit(1)
    .get()

  if (snap.empty) {
    throw new Error(`No card blueprint found for purpose "${purpose}" on event ${eventId}.`)
  }

  const doc = snap.docs[0]
  const data = doc.data()
  return {
    templateCardId: doc.id,
    templateJson: data.constraints,
    pdfUrl: data.templateUrl,
    cardName: data.type,
  }
}

module.exports = { resolveTemplateByPurpose }
