// Direct Twilio WhatsApp dispatch — ported from functions/whatsapp/
// invitation.js (origin/messaging) so haflaway_server no longer needs to
// proxy through that Cloud Function. Twilio's own status-callback webhook
// (whatsapp/webhooks.js's updtWspMsgSttsAction, still deployed) keeps
// updating delivery status regardless of which server placed the send — it
// only depends on a messageLogs/{sid} doc with the right fields existing,
// which campaigns.js still writes.
const twilio = require('twilio')
const { parseISO } = require('date-fns')
const { formatEventDate, formatEventTime, refineMessage } = require('./messageTokens')
const { getCredentials: getOrgTwilioCredentials, getTemplate: getOrgTemplate } = require('../organizations/twilioCredentials')
const { getMessagingMode } = require('../organizations/messagingAccounts')
const { WHATSAPP_TEMPLATE_CATEGORY_BY_PURPOSE, GENERAL_WHATSAPP_TEMPLATE_CATEGORY } = require('./whatsappTemplateCategories')

// Haflaway's own shared account — Account SID + Auth Token, cached as a
// singleton since these never change at runtime. An org's own credentials
// (Twilio API Key + Secret, scoped to their account — see
// organizations/twilioCredentials.js) are never cached this way: they're
// re-read per send so unplugging/rotating them takes effect immediately.
let platformClient = null
function platformTwilioClient() {
  if (!platformClient) {
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set in .env.')
    }
    platformClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  }
  return platformClient
}

// credentials is either null (Haflaway's shared account) or an org's own
// { accountSid, apiKeySid, apiKeySecret, whatsappSender } — decided once per
// send batch by resolveWhatsAppRoute below, never per message.
function resolveTwilioClient(credentials) {
  if (credentials) {
    if (!credentials.accountSid || !credentials.apiKeySid || !credentials.apiKeySecret) {
      throw new Error("This organization's Twilio credentials are incomplete.")
    }
    return twilio(credentials.apiKeySid, credentials.apiKeySecret, { accountSid: credentials.accountSid })
  }
  return platformTwilioClient()
}

// Delivery/read updates for sends on an org's own Twilio account: Haflaway's
// own account has its status webhook configured in the Twilio console, but an
// org's account doesn't, so those sends name the webhook per message instead
// (updtWspMsgSttsAction only needs the MessageSid to find its messageLogs doc).
const ORG_STATUS_CALLBACK_URL = process.env.TWILIO_ORG_STATUS_CALLBACK_URL
  || 'https://us-central1-haflaway-f14aa.cloudfunctions.net/updtWspMsgSttsAction'

// An org's sender is either a WhatsApp number or a Messaging Service SID
// (MG…) — Twilio takes the former as `from: whatsapp:+…` and the latter as
// `messagingServiceSid`. Accepts either with or without a `whatsapp:` prefix.
function senderParams(sender) {
  const value = String(sender ?? '').trim().replace(/^whatsapp:/i, '')
  if (/^MG[0-9a-f]{32}$/i.test(value)) return { messagingServiceSid: value }
  return { from: `whatsapp:${value}` }
}

function categoryLabel(purpose) {
  return purpose ? purpose.replace(/_/g, ' ') : 'general (Bulk Messages)'
}

// The first active shared-library template for this category/language.
async function findSharedTemplateId(db, category, language) {
  const snap = await db.collection('messageTemplates')
    .where('category', '==', category)
    .where('language', '==', language)
    .get()
  const active = snap.docs.find(d => d.data().active !== false)
  if (!active) throw new Error(`No approved WhatsApp template found for category "${category}" (${language}) — create one first.`)
  return active.id
}

// THE routing decision for every WhatsApp send batch (routes/campaigns.js
// calls this once, before any message goes out). The org's staff-set switch
// (organizations/messagingAccounts.js) is the only input that picks the
// account:
//
//   'own'      → the org's own Twilio credentials + the org's own active
//                template for exactly this category/language. Anything
//                missing, switched off, unreadable, or a request naming some
//                other template → throws. Never falls back to Haflaway's.
//   'haflaway' → Haflaway's shared account + a shared-library template
//                (the one the caller picked, validated against
//                messageTemplates, or the first active one for the purpose).
//                The org's own credentials are never read.
//
// `purpose` is set for card sends and null for card-less Bulk Messages sends,
// which use the general category.
async function resolveWhatsAppRoute({ db, event, purpose, language, requestedTemplateId }) {
  const mode = await getMessagingMode(event.orgId, 'whatsapp')
  const category = purpose ? WHATSAPP_TEMPLATE_CATEGORY_BY_PURPOSE[purpose] : GENERAL_WHATSAPP_TEMPLATE_CATEGORY
  if (!category) throw new Error(`No WhatsApp template category configured for purpose "${purpose}".`)
  const which = `${categoryLabel(purpose)} (${String(language).toUpperCase()})`

  if (mode === 'own') {
    const refusal = 'This organization sends WhatsApp only through its own Twilio account'
    const [credentials, template] = await Promise.all([
      getOrgTwilioCredentials(event.orgId),
      getOrgTemplate(event.orgId, category, language),
    ])
    if (!credentials) throw new Error(`${refusal}, but no Twilio credentials are saved. Add them on the Organization page — nothing was sent.`)
    if (!template?.contentSid) throw new Error(`${refusal}, and it has no template of its own for ${which}. Add one on the Organization page — nothing was sent.`)
    if (template.active === false) throw new Error(`${refusal}, and its template for ${which} is switched off. Turn it back on on the Organization page — nothing was sent.`)
    if (requestedTemplateId && requestedTemplateId !== template.contentSid) {
      throw new Error(`${refusal} — the selected template isn't its own template for ${which}. Nothing was sent.`)
    }
    return { mode, credentials, templateId: template.contentSid }
  }

  if (requestedTemplateId) {
    const snap = await db.collection('messageTemplates').doc(String(requestedTemplateId)).get()
    if (!snap.exists) throw new Error("The selected template isn't one of Haflaway's registered WhatsApp templates. Nothing was sent.")
    const tpl = snap.data()
    if (tpl.active === false) throw new Error('The selected WhatsApp template is switched off. Nothing was sent.')
    if (tpl.category && tpl.category !== category) {
      throw new Error(`The selected WhatsApp template is for a different message type than ${which}. Nothing was sent.`)
    }
    if (tpl.language && tpl.language !== language) {
      throw new Error(`The selected WhatsApp template is in a different language than this event (${String(language).toUpperCase()}). Nothing was sent.`)
    }
    return { mode, credentials: null, templateId: snap.id }
  }
  if (!purpose) throw new Error('Pick a WhatsApp template to send with.')
  return { mode, credentials: null, templateId: await findSharedTemplateId(db, category, language) }
}

// WhatsApp Content API template variables reject newlines/tabs and runs of
// multiple spaces (Twilio error 21656: "The Content Variables parameter is
// invalid."). Free-text fields — the organizer-authored custom message (var
// 8) above all — routinely contain line breaks, so every value is flattened
// to a single line before being sent.
function sanitizeContentVariable(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
}

// venueStartTime/worshipStartTime are plain "HH:mm" strings, optional. When
// set, apply them on top of the event's own date; when unset, fall back to
// `fallback` (the event's own start time) unchanged.
function resolveLocationTime(timeStr, fallback) {
  if (!timeStr) return fallback
  const [hours, minutes] = timeStr.split(':').map(Number)
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return fallback
  const resolved = new Date(fallback)
  resolved.setHours(hours, minutes, 0, 0)
  return resolved
}

// Builds the same up-to-10-variable content shape invitation.js sends.
// customMessage (var 8) is the organizer-authored free-text slot, already
// refined through the shared token table so {{eventname}}/{{venue}}/etc. work
// inside it exactly like they do in SMS.
function buildContentVariables({ event, attendee, cardUrl, cardName, customMessage }) {
  const dateString = event.startDate ?? event.calendar?.[0]?.eventDate
  const timeString = event.startDate ?? event.calendar?.[0]?.startTime
  const date = parseISO(dateString)
  const time = parseISO(timeString)
  const fDate = formatEventDate(date)

  const venueTime = resolveLocationTime(event.venueStartTime, time)
  const worshipTime = resolveLocationTime(event.worshipStartTime, time)
  const fTime = formatEventTime(venueTime, event.language, event.timeFormat)
  const fWorshipTime = formatEventTime(worshipTime, event.language, event.timeFormat)

  // Card-less sends (Bulk Messages) send '' here, exactly as the old
  // sendWhatsAppInvitationMessages Cloud Function did.
  let imago = ''
  if (cardUrl) {
    imago = cardUrl.split('.app/')[1]
    if (!imago) throw new Error('Invalid cardUrl — could not derive the template image variable.')
  }

  const eventTokens = { eventname: event.title ?? '', venue: event.location ?? '', date: fDate, time: fTime }
  const refinedCustomMessage = refineMessage(
    event.id, attendee.fullName, attendee.id, customMessage ?? '',
    cardUrl, cardName, attendee.pledgedAmount ?? 0, attendee.paidAmount ?? 0, eventTokens
  )

  return JSON.stringify({
    '1': sanitizeContentVariable(attendee.fullName),
    '2': sanitizeContentVariable(event.title),
    '3': sanitizeContentVariable(fDate),
    '4': sanitizeContentVariable(event.location),
    '5': sanitizeContentVariable(fTime),
    '6': imago,
    '7': `${event.id}/${attendee.id}`,
    '8': sanitizeContentVariable(refinedCustomMessage),
    '9': sanitizeContentVariable(event.worshipLocation ?? ''),
    '10': sanitizeContentVariable(fWorshipTime),
  })
}

// `credentials` comes from resolveWhatsAppRoute — an org's own (its own
// sender, never Haflaway's number) or null (Haflaway's account and number).
async function sendWhatsAppCard({ event, attendee, cardUrl, cardName, templateId, customMessage, credentials }) {
  const contentVariables = buildContentVariables({ event, attendee, cardUrl, cardName, customMessage })
  const sender = credentials ? credentials.whatsappSender : process.env.TWILIO_WHATSAPP_NUMBER
  if (!sender) {
    throw new Error(credentials
      ? "This organization's Twilio credentials have no WhatsApp sender."
      : 'TWILIO_WHATSAPP_NUMBER not set in .env.')
  }

  // A hung connection here would otherwise stall this attendee (and the rest
  // of the run behind it) indefinitely.
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Twilio request timed out.')), 15000))
  const message = await Promise.race([
    resolveTwilioClient(credentials).messages.create({
      ...senderParams(sender),
      to: `whatsapp:${attendee.phone}`,
      contentSid: templateId,
      contentVariables,
      ...(credentials ? { statusCallback: ORG_STATUS_CALLBACK_URL } : {}),
    }),
    timeout,
  ])

  return {
    sid: message.sid,
    from: message.from,
    to: message.to,
    accountSid: message.accountSid,
    status: message.status,
    dateCreated: message.dateCreated,
    dateUpdated: message.dateUpdated,
    sentContentVariables: contentVariables,
    viaOrgCredentials: !!credentials,
  }
}

// Synthetic placeholder values, not a real event/attendee — lets an org owner
// confirm their own contentSid renders (right variable count/order) before
// staff switch them onto their own account, without touching billing,
// messageLogs, or a real guest. Always uses the org's own credentials (never
// the shared account) — see getCredentialsForOwnerTest in
// organizations/twilioCredentials.js.
function buildTestContentVariables() {
  return JSON.stringify({
    '1': 'Test Guest',
    '2': 'Sample Event',
    '3': '1 Jan 2030',
    '4': 'Sample Venue',
    '5': '10:00 AM',
    '6': 'https://example.com/sample-card.jpg',
    '7': 'test-event/test-attendee',
    '8': 'This is a test message from Haflaway — your template mapping is working.',
    '9': '',
    '10': '',
  })
}

async function sendWhatsAppTestMessage({ credentials, contentSid, to }) {
  if (!credentials?.whatsappSender) throw new Error('No WhatsApp sender configured for this org yet.')
  const contentVariables = buildTestContentVariables()
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Twilio request timed out.')), 15000))
  const message = await Promise.race([
    resolveTwilioClient(credentials).messages.create({
      ...senderParams(credentials.whatsappSender),
      to: `whatsapp:${to}`,
      contentSid,
      contentVariables,
    }),
    timeout,
  ])
  return { sid: message.sid, status: message.status }
}

module.exports = { sendWhatsAppCard, sendWhatsAppTestMessage, resolveWhatsAppRoute }
