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

let client = null
function twilioClient() {
  if (!client) {
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set in .env.')
    }
    client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  }
  return client
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

async function sendWhatsAppCard({ event, attendee, cardUrl, templateId, customMessage }) {
  const contentVariables = buildContentVariables({ event, attendee, cardUrl, customMessage })
  const whatsappNumber = process.env.TWILIO_WHATSAPP_NUMBER
  if (!whatsappNumber) throw new Error('TWILIO_WHATSAPP_NUMBER not set in .env.')

  // A hung connection here would otherwise stall this attendee (and the rest
  // of the run behind it) indefinitely.
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Twilio request timed out.')), 15000))
  const message = await Promise.race([
    twilioClient().messages.create({
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
  }
}

module.exports = { sendWhatsAppCard }
