const express = require('express')
const { getDb, admin } = require('../firebase')
const { requireAuth } = require('../middleware/auth')
const { requireEventAccess } = require('../middleware/eventAccess')
const { renderAttendeeCard } = require('../render/renderAttendeeCard')
const { sendWhatsAppCard, resolveOrgWhatsAppCredentials } = require('../dispatch/whatsapp')
const { sendSmsCard, getActiveSmsProvider, resolveEventTokens, refineMessage, SUPPORTED_SMS_PROVIDERS, SMS_CHARS_PER_SEGMENT } = require('../dispatch/sms')
const { resolveBillingAccount, chargeBilling } = require('../dispatch/billing')
const { getEventPlan, baseDispatchCost, quotaKeyForCampaignType, quotaForCampaign } = require('../dispatch/pricing')
const { resolveSenderIdForEvent, normalizeSenderId } = require('../dispatch/senderId')
const { getSenderPool, resolveProviderForOrg } = require('../organizations/smsCredentials')
const { getTemplate: getOrgWhatsAppTemplate } = require('../organizations/twilioCredentials')
const { WHATSAPP_TEMPLATE_CATEGORY_BY_PURPOSE } = require('../dispatch/whatsappTemplateCategories')

const router = express.Router()

// Only invitation/save_the_date have a real category today — thank_you and
// enclosure are best-guess names; sends for those two purposes will fail
// per-recipient with a clear "no template found" error until an approved
// template actually exists under the guessed category.

// SMS has no such thing as "attach an image" — the card can only ever be a
// link in the text. These are placeholder defaults (refineMessage() from
// dispatch/messageTokens.js substitutes the full {{token}} set) used only
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

// Sends one attendee's card and logs it — ported from functions/whatsapp/
// invitation.js + functions/sms/indesms.js (origin/messaging), talking to
// Twilio/Beem/OnFon/Wasambazie directly instead of proxying through those
// Cloud Functions. messageLogs docs are written in the exact same shape
// those functions write, so the still-deployed delivery-status webhooks
// (updtWspMsgSttsAction, reportOnFons, reportWasambazie) keep updating
// attendee.messages/messageIndexes unchanged.
//
// Billing quota here is a per-(channel,campaignId) COUNTER FIELD on the
// attendee doc (`${channel}_${campaignId}_count`), incremented in the same
// batch as the messageLog write — NOT a filter over the attendee.messages
// map (that map is purely for display/status, populated asynchronously by
// the webhooks above). Only the five fixed lifecycle campaign ids have a
// free-dispatch quota at all (see dispatch/pricing.js); every other
// campaignId — which includes every card-send campaign this server's own
// Send-a-Card flow creates — is "custom" and is always charged.
async function dispatchAndLog({ db, event, eventPlan, billing, campaignId, purpose, channel, attendeeId, whatsappTemplateId, whatsappCustomMessage, whatsappCredentials, smsTemplate, requestedBy, senderId, smsProviderName }) {
  const attendeeRef = db.collection('events').doc(event.id).collection('attendees').doc(attendeeId)
  const attendeeSnap = await attendeeRef.get()
  if (!attendeeSnap.exists) throw new Error('Attendee not found.')
  const attendee = { id: attendeeSnap.id, ...attendeeSnap.data() }

  if (!attendee.phone || !attendee.fullName) {
    throw new Error('Skipped — missing phone or name.')
  }

  // A plain SMS text blast has no purpose and no card at all — cardUrl/
  // cardName just stay undefined, and refineMessage()/{{card}} substitution
  // downstream already tolerates that. WhatsApp always has a purpose (see
  // the route's validation), so it keeps requiring a rendered card here.
  let cardUrl, cardName
  if (purpose) {
    if (!attendee.cards?.[purpose]?.url) {
      throw new Error('Skipped — missing rendered card.')
    }
    cardUrl = attendee.cards[purpose].url
    cardName = attendee.cards[purpose].name
  }

  const quotaKey = quotaKeyForCampaignType(campaignId)
  const isCustomCampaign = quotaKey === null
  const counterField = `${channel}_${campaignId}_count`
  const currentCount = attendee[counterField] ?? 0
  const shouldCharge = isCustomCampaign || (currentCount >= quotaForCampaign(eventPlan, channel, quotaKey))

  // Check affordability BEFORE spending real money on an actual provider
  // call — chargeBilling() re-checks atomically after the send too, but that
  // re-check only prevents the balance from going negative; by then the
  // message has already gone out for real. Failing here instead means a
  // chargeable send with insufficient balance costs nothing and sends
  // nothing, rather than sending for free and reporting a confusing failure.
  async function assertAffordable(amount) {
    if (amount <= 0) return
    if (typeof billing.balance !== 'number' || billing.balance < amount) {
      throw new Error(`Insufficient balance to send this ${channel} message (needs ${amount}).`)
    }
  }

  if (channel === 'whatsapp') {
    const chargeAmount = shouldCharge ? baseDispatchCost(eventPlan, 'whatsapp') : 0
    await assertAffordable(chargeAmount)

    const result = await sendWhatsAppCard({ event, attendee, cardUrl, templateId: whatsappTemplateId, customMessage: whatsappCustomMessage, credentials: whatsappCredentials })
    const batch = db.batch()
    batch.set(db.collection('messageLogs').doc(result.sid), {
      type: campaignId,
      channel: 'whatsapp',
      attendeeId,
      eventId: event.id,
      authorId: event.authorId,
      dispatchedBy: requestedBy,
      from: result.from,
      to: result.to,
      accountSid: result.accountSid,
      status: result.status,
      dateCreated: result.dateCreated,
      dateUpdated: result.dateUpdated,
      templateId: whatsappTemplateId,
      sentContentVariables: result.sentContentVariables,
      viaOrgCredentials: result.viaOrgCredentials,
      chargeAmount,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true })
    batch.update(attendeeRef, { [counterField]: admin.firestore.FieldValue.increment(1) })
    await batch.commit()

    if (chargeAmount > 0) {
      await chargeBilling({
        billing, authorId: event.authorId, eventId: event.id, attendeeId,
        amount: chargeAmount,
        reason: isCustomCampaign
          ? `Sent WhatsApp message — custom campaign (${campaignId})`
          : `Sent WhatsApp message via Overdraft (${campaignId})`,
        extraParams: { channel: 'whatsapp', campaignType: campaignId, quotaKey, countAtSend: currentCount },
      })
    }
    return
  }

  // sms — cost depends on the final message's segment count, so it's only
  // knowable (and checked) once the template's been substituted.
  const eventTokens = resolveEventTokens(event)
  const message = refineMessage(event.id, attendee.fullName, attendee.id, smsTemplate, cardUrl, cardName, attendee.pledgedAmount ?? 0, attendee.paidAmount ?? 0, eventTokens)
  const segments = Math.ceil(message.length / SMS_CHARS_PER_SEGMENT)
  const chargeAmount = shouldCharge ? baseDispatchCost(eventPlan, 'sms') * segments : 0
  await assertAffordable(chargeAmount)

  const result = await sendSmsCard({ providerName: smsProviderName, message, attendeeId, phoneNumber: attendee.phone, senderId, orgId: event.orgId })

  const batch = db.batch()
  batch.set(db.collection('messageLogs').doc(result.requestId), {
    type: campaignId,
    channel: 'sms',
    attendeeId,
    eventId: event.id,
    authorId: event.authorId,
    dispatchedBy: requestedBy,
    message,
    from: senderId,
    to: attendee.phone,
    status: 'submitted',
    apiProvider: smsProviderName,
    apiResponseCode: result.code ?? null,
    apiResponseMessage: result.message ?? null,
    apiRequestTimestamp: new Date().toISOString(),
    dateCreated: new Date().toISOString(),
    requestId: result.requestId,
    segments,
    baseSMSCharge: baseDispatchCost(eventPlan, 'sms'),
    chargeAmount,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: false })
  const msgInd = attendee.messageIndexes ?? []
  batch.update(attendeeRef, {
    messageIndexes: [
      ...msgInd.filter(i => !i.startsWith(`sms_${campaignId}`)),
      `sms_${campaignId}_sent`,
    ],
    [counterField]: admin.firestore.FieldValue.increment(1),
  })
  await batch.commit()

  if (chargeAmount > 0) {
    await chargeBilling({
      billing, authorId: event.authorId, eventId: event.id, attendeeId,
      amount: chargeAmount,
      reason: isCustomCampaign
        ? `SMS dispatch charge — custom campaign (${campaignId})`
        : `SMS dispatch charge via Overdraft (${campaignId})`,
      extraParams: { channel: 'sms', campaignType: campaignId, quotaKey, countAtSend: currentCount, messageLength: message.length, messageSegments: segments },
    })
  }
}

async function bumpRun(runRef, countKey, attendeeId, entry) {
  try {
    await runRef.update({
      [`results.${attendeeId}`]: entry,
      [`counts.${countKey}`]: admin.firestore.FieldValue.increment(1),
    })
  } catch (e) {
    // The message itself already succeeded/failed for real by this point —
    // a failure to record that in the run doc must never flip a successful,
    // already-billed send into looking like a failure (which would invite a
    // costly, duplicate retry). Just log it; the sendRuns doc's count will
    // undercount by one, which is a display nit, not a billing one.
    console.error(`bumpRun(${countKey}, ${attendeeId}) failed:`, e)
  }
}

// Sequential, one attendee at a time, continuing past failures — the
// three-outcome batch design: render+send success, render-ok/send-failed, or
// render-failed (send never attempted). Runs after the HTTP response has
// already gone out; this is a persistent VPS process, not a Cloud Function
// with an execution-time ceiling, so it's safe to keep going in the
// background. Progress streams to the SPA live via the sendRuns doc.
//
// finishedAt is always stamped in a finally, no matter what happens in the
// loop — the in-flight lock on this campaign (see the route handler below)
// is a `where finishedAt == null` query, so leaving it unset on any
// unexpected crash would lock the campaign out of ever sending again.
async function processRun({ db, runRef, eventId, campaignId, channel, purpose, attendeeIds, templateId, requestedBy }) {
  let whatsappTemplateId = templateId || null
  let whatsappCredentials = null
  let smsTemplate = DEFAULT_SMS_CONTENT_BY_PURPOSE[purpose] ?? ''
  let whatsappCustomMessage = ''
  let setupError = null
  let event = null
  let eventPlan = null
  let billing = null
  let senderId = null
  let smsProviderName = null

  try {
    const [eventSnap, campaignSnap] = await Promise.all([
      db.collection('events').doc(eventId).get(),
      db.collection('events').doc(eventId).collection('campaigns').doc(campaignId).get(),
    ])
    event = { id: eventId, ...eventSnap.data() }
    const language = event.language ?? 'sw'
    const campaignData = campaignSnap.data() ?? {}
    if (campaignData.smsMessage) smsTemplate = campaignData.smsMessage
    if (campaignData.whatsappMessage) whatsappCustomMessage = campaignData.whatsappMessage

    if (channel === 'sms') {
      // A plain text blast (no purpose/card) has no default fallback content
      // of its own — its whole message has to come from the campaign doc's
      // smsMessage field, composed by the org in the Send drawer. A
      // purpose-based send always has DEFAULT_SMS_CONTENT_BY_PURPOSE to fall
      // back on even if smsMessage was never set.
      if (!purpose && !smsTemplate.trim()) {
        throw new Error('This campaign has no message content set.')
      }
      // An org that's plugged in its own smtz/wasambazie credentials always
      // sends through that provider on their own account — the platform-wide
      // active-provider switch (getActiveSmsProvider) only decides for an
      // org that hasn't brought anything of its own. Resolved once per batch
      // and threaded through to every dispatchAndLog call below so sender-ID
      // resolution and the actual send can never disagree about which
      // provider this batch is using.
      const platformProvider = await getActiveSmsProvider(db)
      smsProviderName = await resolveProviderForOrg(event.orgId, platformProvider)
      // Fail the whole run up front if the resolved provider has no adapter
      // here, rather than rendering (and billing) every attendee's card
      // first and only discovering this per-attendee afterward.
      if (!SUPPORTED_SMS_PROVIDERS.has(smsProviderName)) {
        throw new Error(`SMS provider "${smsProviderName}" has no adapter in haflaway_server yet.`)
      }
      senderId = await resolveSenderIdForEvent(event, smsProviderName)
    }
    // A caller that already knows which approved template it wants (e.g. the
    // SPA's own template picker) can pass templateId directly — the SPA's
    // picker surfaces the org's own registered template as one of the
    // selectable options (see EventCampaigns.vue's loadSendTemplates), so
    // that explicit pick can legitimately BE the org's own contentSid. Either
    // way — explicitly picked or nothing passed at all (the automatic
    // fallback) — an org's own contentSid only exists inside their own
    // Twilio account, so it can never be paired with the shared account's
    // credentials, or vice versa: check for that exact match (not just
    // "no templateId was passed") before pairing org credentials with it. If
    // the org hasn't registered a template for this exact category+language
    // (or isn't approved, or hasn't brought its own Twilio account), or the
    // caller picked a *different* (shared-library) contentSid, fall through
    // entirely to Haflaway's shared template library + shared account.
    if (channel === 'whatsapp') {
      const category = WHATSAPP_TEMPLATE_CATEGORY_BY_PURPOSE[purpose]
      if (category && event.orgId) {
        const [orgTemplate, orgCredentials] = await Promise.all([
          getOrgWhatsAppTemplate(event.orgId, category, language),
          resolveOrgWhatsAppCredentials(event.orgId),
        ])
        if (orgTemplate?.contentSid && orgCredentials && (!whatsappTemplateId || whatsappTemplateId === orgTemplate.contentSid)) {
          whatsappTemplateId = orgTemplate.contentSid
          whatsappCredentials = orgCredentials
        }
      }
      if (!whatsappTemplateId) {
        whatsappTemplateId = await findWhatsAppTemplateId(purpose, language)
      }
    }
    eventPlan = await getEventPlan(event)
    baseDispatchCost(eventPlan, channel) // throws early if pricing.base* is missing for this channel
    billing = await resolveBillingAccount(event)
  } catch (e) {
    setupError = e
    console.error(`processRun setup failed for ${runRef.path}:`, e)
  }

  try {
    for (const attendeeId of attendeeIds) {
      // Setup failed entirely (bad template/provider/pricing config) —
      // nothing downstream of it can possibly succeed, so don't waste a
      // render (and its charge) on every attendee only to fail at send time.
      if (setupError) {
        await bumpRun(runRef, 'sendFailed', attendeeId, {
          status: 'send_failed', error: setupError.message, at: new Date().toISOString(),
        })
        continue
      }

      // A plain text blast has no purpose and nothing to render — only a
      // purpose-based send (card attached) needs this step at all.
      if (purpose) {
        try {
          await renderAttendeeCard(eventId, attendeeId, purpose)
        } catch (e) {
          await bumpRun(runRef, 'renderFailed', attendeeId, {
            status: 'render_failed', error: e.message, at: new Date().toISOString(),
          })
          continue
        }
      }

      try {
        await dispatchAndLog({
          db, event, eventPlan, billing, campaignId, purpose, channel, attendeeId,
          whatsappTemplateId, whatsappCustomMessage, whatsappCredentials, smsTemplate, requestedBy, senderId, smsProviderName,
        })
      } catch (e) {
        await bumpRun(runRef, 'sendFailed', attendeeId, {
          status: 'send_failed', error: e.message, at: new Date().toISOString(),
        })
        continue
      }
      // Recorded outside the send's own try/catch — a failure here must
      // never reclassify an already-sent, already-billed message as failed.
      await bumpRun(runRef, 'sent', attendeeId, { status: 'sent', at: new Date().toISOString() })
    }
  } finally {
    const finalSnap = await runRef.get()
    const finalCounts = finalSnap.data()?.counts ?? {}
    await runRef.update({ finishedAt: new Date().toISOString() })
    // Only claim "sent" if at least one recipient actually got dispatched —
    // a 100%-failed run (e.g. no approved WhatsApp template for this
    // purpose) should stay visibly distinguishable from a real send, not
    // look identical to one in the campaign list.
    if ((finalCounts.sent ?? 0) > 0) {
      await db.collection('events').doc(eventId).collection('campaigns').doc(campaignId)
        .set({ status: 'sent' }, { merge: true })
    }
  }
}

router.post('/events/:eventId/campaigns/:campaignId/send', requireAuth, requireEventAccess, async (req, res) => {
  const { eventId, campaignId } = req.params
  const { attendeeIds, channel, purpose, templateId } = req.body || {}

  if (!Array.isArray(attendeeIds) || !attendeeIds.length) {
    return res.status(400).json({ ok: false, message: 'attendeeIds must be a non-empty array.' })
  }
  if (channel !== 'whatsapp' && channel !== 'sms') {
    return res.status(400).json({ ok: false, message: 'channel must be "whatsapp" or "sms".' })
  }
  // WhatsApp always sends via an approved Content Template tied to a purpose
  // (see findWhatsAppTemplateId below), so it always needs one. A plain SMS
  // text blast — no card, no purpose — is the one case that doesn't: its
  // message comes straight from the campaign doc's own smsMessage field.
  if (channel === 'whatsapp' && !purpose) {
    return res.status(400).json({ ok: false, message: 'purpose is required for WhatsApp sends.' })
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
        eventId, campaignId, channel,
        // A plain SMS blast has no purpose at all — Firestore rejects
        // `undefined` fields outright (allows `null`, not `undefined`).
        purpose: purpose ?? null,
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

  processRun({ db, runRef, eventId, campaignId, channel, purpose, attendeeIds, templateId, requestedBy: req.uid })
    .catch(e => console.error(`sendRuns/${runRef.id} crashed:`, e))
})

// Pins this event to one sender ID from its org's currently-active-provider
// pool, or clears the pin (senderId null/'') so it follows the org default.
// Validated here rather than trusted from the client — an event must never
// be able to name a sender ID it doesn't actually have (its own org's, on
// whichever provider Haflaway is currently routing through).
router.post('/events/:eventId/sender-id', requireAuth, requireEventAccess, async (req, res) => {
  const { senderId } = req.body || {}
  const db = getDb()
  const eventRef = db.collection('events').doc(req.params.eventId)

  const value = normalizeSenderId(senderId)
  if (!value) {
    await eventRef.update({ senderId: admin.firestore.FieldValue.delete() })
    return res.json({ ok: true, senderId: null })
  }

  const eventSnap = await eventRef.get()
  const event = eventSnap.data()
  if (!event?.orgId) {
    return res.status(400).json({ ok: false, message: "This event isn't linked to an organization, so it sends under the Haflaway default." })
  }

  const platformProvider = await getActiveSmsProvider(db).catch(() => null)
  const providerName = await resolveProviderForOrg(event.orgId, platformProvider)
  const pool = providerName ? await getSenderPool(event.orgId, providerName) : { configured: false, senderIds: [] }
  if (!pool.configured || !pool.senderIds.includes(value)) {
    return res.status(400).json({ ok: false, message: `${value} isn't one of this organization's sender IDs.` })
  }

  await eventRef.update({ senderId: value })
  res.json({ ok: true, senderId: value })
})

module.exports = router
