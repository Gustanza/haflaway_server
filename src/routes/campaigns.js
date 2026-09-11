const express = require('express')
const { getDb, admin } = require('../firebase')
const { requireAuth } = require('../middleware/auth')
const { requireEventAccess } = require('../middleware/eventAccess')
const { renderAttendeeCard } = require('../render/renderAttendeeCard')

const router = express.Router()

// The existing, already-deployed, already billing/quota-aware Cloud Functions
// that actually talk to Twilio/SMS providers. This server renders the card;
// dispatch stays here rather than being reimplemented (and re-risking the
// billing logic) a second time.
const WSP_URL = 'https://sendwhatsappinvitationmessages-frbu33fema-uc.a.run.app'
const SMS_URL = 'https://sendsmsaction-frbu33fema-uc.a.run.app'

// Maps a card purpose to the pre-approved WhatsApp Content Template category
// used to send it (mirrors EventMessages.vue's CAMPAIGN_TEMPLATE_CATEGORIES).
// Only invitation/save_the_date have a real category today — thank_you and
// enclosure are best-guess names; sends for those two purposes will fail
// per-recipient with a clear "no template found" error until an approved
// template actually exists under the guessed category.
const WHATSAPP_TEMPLATE_CATEGORY_BY_PURPOSE = {
  invitation: 'whatsapp-wedding-invitations',
  save_the_date: 'whatsapp-wedding-save-the-date',
  thank_you: 'whatsapp-wedding-thank-you',
  enclosure: 'whatsapp-wedding-enclosure',
}

// SMS has no such thing as "attach an image" — the card can only ever be a
// link in the text. These are placeholder defaults (using the same {{card}}/
// {{eventname}}/{{date}} tokens refineMessage() already supports) used only
// when the campaign doc itself has no smsMessage set — which is always true
// today, since the Send drawer never shows a composer for card campaigns.
const DEFAULT_SMS_CONTENT_BY_PURPOSE = {
  invitation: "You're invited to {{eventname}}! View your invitation: {{card}}",
  save_the_date: 'Save the date for {{eventname}} on {{date}}. Details: {{card}}',
  thank_you: 'Thank you for celebrating {{eventname}} with us! {{card}}',
  enclosure: 'Here are more details for {{eventname}}: {{card}}',
}

async function findWhatsAppTemplateId(purpose, language) {
  const category = WHATSAPP_TEMPLATE_CATEGORY_BY_PURPOSE[purpose]
  if (!category) throw new Error(`No WhatsApp template category configured for purpose "${purpose}".`)
  const snap = await getDb().collection('messageTemplates')
    .where('category', '==', category)
    .where('language', '==', language)
    .limit(1)
    .get()
  if (snap.empty) throw new Error(`No approved WhatsApp template found for category "${category}" (${language}) — create one first.`)
  return snap.docs[0].id
}

async function dispatchOne({ channel, eventId, campaignId, purpose, attendeeId, uid, whatsappTemplateId, smsContent }) {
  const url = channel === 'whatsapp' ? WSP_URL : SMS_URL
  const body = channel === 'whatsapp'
    ? { templateId: whatsappTemplateId, type: campaignId, eventId, attendeesIds: [attendeeId], kardType: purpose }
    : { content: smsContent, type: campaignId, eventId, attendeesIds: [attendeeId], kardType: purpose }

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${uid}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok || data.status !== true) {
    throw new Error(data.message || `Dispatch failed (HTTP ${res.status}).`)
  }
  // A batch-of-one call can still come back status:true with this one
  // recipient reported as skipped/failed inside `details` — don't count
  // that as success.
  const failure = data.details?.failures?.[0]
  if (failure) throw new Error(failure.error || failure.reason || 'Dispatch failed.')
}

async function bumpRun(runRef, countKey, attendeeId, entry) {
  await runRef.update({
    [`results.${attendeeId}`]: entry,
    [`counts.${countKey}`]: admin.firestore.FieldValue.increment(1),
  })
}

// Sequential, one attendee at a time, continuing past failures — the
// three-outcome batch design: render+send success, render-ok/send-failed, or
// render-failed (send never attempted). Runs after the HTTP response has
// already gone out; this is a persistent VPS process, not a Cloud Function
// with an execution-time ceiling, so it's safe to keep going in the
// background. Progress streams to the SPA live via the sendRuns doc.
async function processRun({ db, runRef, eventId, campaignId, channel, purpose, attendeeIds, uid }) {
  let whatsappTemplateId = null
  let smsContent = DEFAULT_SMS_CONTENT_BY_PURPOSE[purpose] ?? ''
  let setupError = null

  try {
    const [eventSnap, campaignSnap] = await Promise.all([
      db.collection('events').doc(eventId).get(),
      db.collection('events').doc(eventId).collection('campaigns').doc(campaignId).get(),
    ])
    const language = eventSnap.data()?.language ?? 'sw'
    if (campaignSnap.data()?.smsMessage) smsContent = campaignSnap.data().smsMessage
    if (channel === 'whatsapp') {
      whatsappTemplateId = await findWhatsAppTemplateId(purpose, language)
    }
  } catch (e) {
    // Every attendee would fail identically without a usable template —
    // record that per-attendee below instead of aborting the whole run.
    setupError = e
    console.error(`processRun setup failed for ${runRef.path}:`, e)
  }

  for (const attendeeId of attendeeIds) {
    try {
      await renderAttendeeCard(eventId, attendeeId, purpose)
    } catch (e) {
      await bumpRun(runRef, 'renderFailed', attendeeId, {
        status: 'render_failed', error: e.message, at: new Date().toISOString(),
      })
      continue
    }

    try {
      if (setupError) throw setupError
      await dispatchOne({ channel, eventId, campaignId, purpose, attendeeId, uid, whatsappTemplateId, smsContent })
      await bumpRun(runRef, 'sent', attendeeId, { status: 'sent', at: new Date().toISOString() })
    } catch (e) {
      await bumpRun(runRef, 'sendFailed', attendeeId, {
        status: 'send_failed', error: e.message, at: new Date().toISOString(),
      })
    }
  }

  const finalSnap = await runRef.get()
  const finalCounts = finalSnap.data()?.counts ?? {}
  await runRef.update({ finishedAt: new Date().toISOString() })
  // Only claim "sent" if at least one recipient actually got dispatched — a
  // 100%-failed run (e.g. no approved WhatsApp template for this purpose)
  // should stay visibly distinguishable from a real send, not look identical
  // to one in the campaign list.
  if ((finalCounts.sent ?? 0) > 0) {
    await db.collection('events').doc(eventId).collection('campaigns').doc(campaignId)
      .set({ status: 'sent' }, { merge: true })
  }
}

router.post('/events/:eventId/campaigns/:campaignId/send', requireAuth, requireEventAccess, async (req, res) => {
  const { eventId, campaignId } = req.params
  const { attendeeIds, channel, purpose } = req.body || {}

  if (!Array.isArray(attendeeIds) || !attendeeIds.length) {
    return res.status(400).json({ ok: false, message: 'attendeeIds must be a non-empty array.' })
  }
  if (channel !== 'whatsapp' && channel !== 'sms') {
    return res.status(400).json({ ok: false, message: 'channel must be "whatsapp" or "sms".' })
  }
  if (!purpose) {
    return res.status(400).json({ ok: false, message: 'purpose is required.' })
  }

  const db = getDb()
  const campaignRunsCol = db
    .collection('events').doc(eventId)
    .collection('campaigns').doc(campaignId)
    .collection('sendRuns')

  // Refuse to start a second run while one is still in flight for this
  // campaign — without this, a double-click or a second open tab can fire
  // overlapping batches: duplicate renders and duplicate *paid* dispatches
  // to the same guests. The frontend also disables Send while a run is
  // active, but that's a UI nicety, not a guarantee — this transaction is
  // the real lock, closing the check-then-create race a plain read+write
  // would leave open between two near-simultaneous requests.
  const runRef = campaignRunsCol.doc()
  try {
    await db.runTransaction(async (trn) => {
      const inFlight = await trn.get(campaignRunsCol.where('finishedAt', '==', null).limit(1))
      if (!inFlight.empty) {
        const err = new Error('A send is already in progress for this campaign.')
        err.inFlightRunId = inFlight.docs[0].id
        throw err
      }
      trn.set(runRef, {
        eventId, campaignId, channel, purpose,
        total: attendeeIds.length,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        requestedBy: req.uid,
        counts: { sent: 0, renderFailed: 0, sendFailed: 0 },
        results: {},
      })
    })
  } catch (e) {
    if (e.inFlightRunId) {
      return res.status(409).json({ ok: false, message: e.message, runId: e.inFlightRunId })
    }
    return res.status(500).json({ ok: false, message: e.message })
  }

  res.json({ ok: true, runId: runRef.id })

  processRun({ db, runRef, eventId, campaignId, channel, purpose, attendeeIds, uid: req.uid })
    .catch(e => console.error(`sendRuns/${runRef.id} crashed:`, e))
})

module.exports = router
