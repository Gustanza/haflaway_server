const { getDb } = require('../firebase')
const { createLimiter } = require('./concurrencyLimiter')
const { RENDER_CONCURRENCY } = require('../config')
const { resolveTemplateByPurpose } = require('./resolveTemplate')
const { buildAttendeeData } = require('./cardData')
const { makeCard } = require('./makeCard')

// One shared limiter for the whole process — it needs to cap concurrency
// across every request hitting this server, not just within a single batch.
const limiter = createLimiter(RENDER_CONCURRENCY)

// Renders one attendee's card for a given purpose, or reuses an already
// -rendered one — the lazy-cache design agreed on: never pre-render eagerly,
// but once a card has been produced, don't pay to re-render it on every touch.
// Persists the result the same shape functions/attendees/cardJobs.js already
// writes (attendee.cards[purpose] = { name, url, templateCardId, issuedAt,
// status }), so existing readers of that field keep working unchanged.
async function renderAttendeeCard(eventId, attendeeId, purpose, { force = false } = {}) {
  const db = getDb()
  const attendeeRef = db.collection('events').doc(eventId).collection('attendees').doc(attendeeId)
  const attendeeSnap = await attendeeRef.get()
  if (!attendeeSnap.exists) throw new Error(`Attendee ${attendeeId} not found.`)
  const attendee = { id: attendeeSnap.id, ...attendeeSnap.data() }

  const existing = attendee.cards?.[purpose]
  if (!force && existing?.url) {
    return { url: existing.url, cached: true }
  }

  const eventSnap = await db.collection('events').doc(eventId).get()
  if (!eventSnap.exists) throw new Error(`Event ${eventId} not found.`)
  const eventLabels = eventSnap.data()?.labels ?? []

  const { templateCardId, templateJson, pdfUrl, cardName } = await resolveTemplateByPurpose(eventId, purpose)
  const attendeeData = buildAttendeeData(eventId, attendee, eventLabels)

  const url = await limiter(() => makeCard(templateJson, attendeeData, pdfUrl, true))
  if (!url) throw new Error('Render produced no URL.')

  const attCard = {
    name: cardName,
    url,
    templateCardId,
    issuedAt: new Date().toISOString(),
    status: 'completed',
  }
  await attendeeRef.set({ cards: { [purpose]: attCard } }, { merge: true })

  return { url, cached: false }
}

module.exports = { renderAttendeeCard }
