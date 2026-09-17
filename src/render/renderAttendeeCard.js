const { getDb, admin } = require('../firebase')
const { createLimiter } = require('./concurrencyLimiter')
const { RENDER_CONCURRENCY } = require('../config')
const { resolveTemplateByPurpose } = require('./resolveTemplate')
const { buildAttendeeData } = require('./cardData')
const { makeCard } = require('./makeCard')
const { getEventPlan, renderCostForPurpose, freeCorrectionsAllowed } = require('../dispatch/pricing')
const { resolveBillingAccount } = require('../dispatch/billing')

// One shared limiter for the whole process — it needs to cap concurrency
// across every request hitting this server, not just within a single batch.
const limiter = createLimiter(RENDER_CONCURRENCY)

// Renders one attendee's card for a given purpose, or reuses an already
// -rendered one — the lazy-cache design agreed on: never pre-render eagerly,
// but once a card has been produced, don't pay to re-render it on every touch.
// Persists the result the same shape functions/attendees/attendees.js already
// writes (attendee.cards[purpose] = { name, url, templateCardId, issuedAt,
// status }), so existing readers of that field keep working unchanged.
//
// Card creation is billed here — ported from functions/attendees/attendees.js
// (createAttendees), which charges eventPlan.pricing.invitationCard/
// contributionCard/contributionNoCard per card, against the event's org
// balance if it has one (resolveBillingAccount), falling back to the
// author's personal balance otherwise.
//
// Billing is driven by `attendee.cardRenderCounts[purpose]` — a counter of
// every REAL render ever done for this (attendee, purpose), which is
// deliberately separate from `attendee.cards[purpose]` itself. EventAttendees
// .vue invalidates (clears) `cards` whenever an edit changes something the
// card actually prints (name, party type, label), so the next send renders a
// fresh one — but that's a correction, not a new card, and must not always
// be billed like one. `cardRenderCounts` survives that invalidation, so:
// render #1 for a purpose is always the paid "creation" cost; renders after
// that are corrections, free up to the event plan's allowance
// (freeCorrectionsAllowed) and charged again past it — regardless of whether
// the re-render was triggered by an invalidated `cards` entry or by `force`
// on a still-valid one.
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
  const event = { id: eventId, ...eventSnap.data() }
  const eventLabels = event?.labels ?? []
  const eventPlan = await getEventPlan(event)

  const priorRenders = attendee.cardRenderCounts?.[purpose] ?? 0
  const isFirstRenderEver = priorRenders === 0
  const correctionNumber = priorRenders // this render is correction #priorRenders when priorRenders > 0
  const shouldCharge = isFirstRenderEver || correctionNumber > freeCorrectionsAllowed(eventPlan)

  let renderCost = 0
  let billing = null
  if (shouldCharge) {
    renderCost = renderCostForPurpose(eventPlan, purpose)
    billing = await resolveBillingAccount(event)
    // Fail fast — before spending compute on Puppeteer — if this is clearly
    // unaffordable. The real, race-safe check happens again in the
    // transaction below once rendering has actually succeeded.
    if (typeof billing.balance !== 'number' || billing.balance < renderCost) {
      throw new Error(`Insufficient balance to render a ${purpose} card (needs ${renderCost}).`)
    }
  }

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

  if (!shouldCharge) {
    // A free render — either within the free-correction allowance, or an old
    // -style `force` refresh. No billing to do, but still needs the same
    // race guard as the paid path below: two concurrent requests for the
    // SAME (attendee, purpose) could both read `priorRenders` before either
    // writes, both correctly land on "free" for the count they saw, and
    // together silently grant two free corrections instead of one — a real
    // revenue leak (e.g. two campaigns for the same purpose both sending to
    // this attendee around the same time). A plain `set()` here can't detect
    // that; a transaction re-checking the fresh count can.
    await db.runTransaction(async (trn) => {
      const freshAttSnap = await trn.get(attendeeRef)
      if ((freshAttSnap.data()?.cardRenderCounts?.[purpose] ?? 0) > priorRenders) return
      trn.set(attendeeRef, {
        cards: { [purpose]: attCard },
        cardRenderCounts: { [purpose]: admin.firestore.FieldValue.increment(1) },
      }, { merge: true })
    })
    return { url, cached: false }
  }

  // A chargeable render (first-ever creation, or a correction past the free
  // allowance): write it and charge for it atomically, re-checking inside
  // the transaction in case a concurrent request already completed a render
  // for this exact purpose while we were busy rendering ours — don't charge
  // (or count) twice for the same one.
  const txnRef = db.collection('userTransactions').doc()
  await db.runTransaction(async (trn) => {
    const freshAttSnap = await trn.get(attendeeRef)
    if ((freshAttSnap.data()?.cardRenderCounts?.[purpose] ?? 0) > priorRenders) return

    const billingSnap = await trn.get(billing.ref)
    const balance = billingSnap.data()?.balance
    if (typeof balance !== 'number' || balance < renderCost) {
      throw new Error(`Insufficient balance to render a ${purpose} card (needs ${renderCost}).`)
    }

    trn.set(attendeeRef, {
      cards: { [purpose]: attCard },
      cardRenderCounts: { [purpose]: admin.firestore.FieldValue.increment(1) },
    }, { merge: true })
    trn.update(billing.ref, { balance: admin.firestore.FieldValue.increment(-renderCost) })
    trn.set(txnRef, {
      authorId: event.authorId,
      eventId,
      billedTo: { kind: billing.kind, id: billing.id },
      amount: -renderCost,
      createdAt: new Date().toISOString(),
      params: { attendeeId },
      reason: isFirstRenderEver
        ? `${purpose} card creation cost`
        : `${purpose} card correction re-render cost (correction #${correctionNumber})`,
    })
  })

  return { url, cached: false }
}

module.exports = { renderAttendeeCard }
