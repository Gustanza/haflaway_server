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
const { getCredentials: getOrgTwilioCredentials } = require('../organizations/twilioCredentials')

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

// credentials is either null (use Haflaway's shared account) or an org's own
// { accountSid, apiKeySid, apiKeySecret, whatsappSender } — resolved once per
// send batch by resolveOrgWhatsAppCredentials below, gated on that org's
// branding approval.
function resolveTwilioClient(credentials) {
  if (credentials?.accountSid && credentials?.apiKeySid && credentials?.apiKeySecret) {
    return twilio(credentials.apiKeySid, credentials.apiKeySecret, { accountSid: credentials.accountSid })
  }
  return platformTwilioClient()
}

// An org that's plugged in its own approved Twilio credentials AND has a
// contentSid registered for the category/language being sent always sends
// through its own account (see routes/campaigns.js, which resolves the
// template and the credentials together — never mixing an org's account with
// Haflaway's contentSid or vice versa, since a contentSid only exists inside
// the account it was approved in). Returns null (meaning "use the shared
// account") whenever the org hasn't brought its own, isn't approved, or a
// lookup fails — mirrors resolveOrgSmsCredentials in dispatch/sms.js.
async function resolveOrgWhatsAppCredentials(orgId) {
  if (!orgId) return null
  try {
    return await getOrgTwilioCredentials(orgId)
  } catch (err) {
    console.warn(`resolveOrgWhatsAppCredentials: falling back to shared account for org ${orgId}:`, err.message)
    return null
  }
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
function buildContentVariables({ event, attendee, cardUrl, customMessage }) {
  const dateString = event.startDate ?? event.calendar?.[0]?.eventDate
  const timeString = event.startDate ?? event.calendar?.[0]?.startTime
  const date = parseISO(dateString)
  const time = parseISO(timeString)
  const fDate = formatEventDate(date)

  const venueTime = resolveLocationTime(event.venueStartTime, time)
  const worshipTime = resolveLocationTime(event.worshipStartTime, time)
  const fTime = formatEventTime(venueTime, event.language, event.timeFormat)
  const fWorshipTime = formatEventTime(worshipTime, event.language, event.timeFormat)

  const imago = cardUrl.split('.app/')[1]
  if (!imago) throw new Error('Invalid cardUrl — could not derive the template image variable.')

  const eventTokens = { eventname: event.title ?? '', venue: event.location ?? '', date: fDate, time: fTime }
  const refinedCustomMessage = refineMessage(
    event.id, attendee.fullName, attendee.id, customMessage ?? '',
    cardUrl, undefined, attendee.pledgedAmount ?? 0, attendee.paidAmount ?? 0, eventTokens
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

async function sendWhatsAppCard({ event, attendee, cardUrl, templateId, customMessage, credentials }) {
  const contentVariables = buildContentVariables({ event, attendee, cardUrl, customMessage })
  const whatsappNumber = credentials?.whatsappSender || process.env.TWILIO_WHATSAPP_NUMBER
  if (!whatsappNumber) throw new Error('No WhatsApp sender configured (org has none, and TWILIO_WHATSAPP_NUMBER not set in .env).')

  // A hung connection here would otherwise stall this attendee (and the rest
  // of the run behind it) indefinitely.
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Twilio request timed out.')), 15000))
  const message = await Promise.race([
    resolveTwilioClient(credentials).messages.create({
      from: `whatsapp:${whatsappNumber}`,
      to: `whatsapp:${attendee.phone}`,
      contentSid: templateId,
      contentVariables,
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
// staff approval lands, without touching billing, messageLogs, or a real
// guest. Always uses the org's own credentials (never the shared account) —
// see getCredentialsForOwnerTest in organizations/twilioCredentials.js, which
// deliberately skips the branding-approval gate for this one path.
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
      from: `whatsapp:${credentials.whatsappSender}`,
      to: `whatsapp:${to}`,
      contentSid,
      contentVariables,
    }),
    timeout,
  ])
  return { sid: message.sid, status: message.status }
}

module.exports = { sendWhatsAppCard, sendWhatsAppTestMessage, resolveOrgWhatsAppCredentials }
