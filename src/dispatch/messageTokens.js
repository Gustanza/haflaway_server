// Ported from functions/utils/messageTokens.js + the formatEventDate/
// formatEventTime pair in functions/utils/globalfns.js (origin/messaging).
// Kept byte-for-byte equivalent on the time-formatting math specifically —
// this is the exact algorithm real guests' messages have been formatted
// with, including the Swahili hour-shift/period-name convention, and it is
// NOT something to approximate.
const { format } = require('date-fns')

// event.startDate/calendar times are naive wall-clock strings with no
// timezone offset; parseISO/`new Date` read them back in local time, which
// recovers the exact same wall-clock digits that were stored — no shift
// needed on top (a previous +3h "UTC->EAT" adjustment double-converted the
// time, since the value was never a UTC instant to begin with).
const eatParts = (date) => ({ hour: date.getHours(), minute: date.getMinutes() })

const formatEventDate = (date) => format(date, 'dd/MM/yyyy')

// Swahili always uses the Saa/Asubuhi-Mchana-... phrasing; English respects
// the event's timeFormat setting ('12h' default, or '24h').
const formatEventTime = (time, language, timeFormat) => {
  const lang = language || 'sw'
  const { hour: hours, minute } = eatParts(time)
  const minutes = String(minute).padStart(2, '0')

  if (lang === 'sw') {
    const swahiliHour = ((hours - 6 + 24) % 12) || 12
    let period
    if (hours >= 6 && hours < 12) period = 'Asubuhi'
    else if (hours >= 12 && hours < 15) period = 'Mchana'
    else if (hours >= 15 && hours < 18) period = 'Alasiri'
    else if (hours >= 18 && hours < 20) period = 'Jioni'
    else period = 'Usiku'
    return `Saa ${swahiliHour}:${minutes} ${period}`
  }

  if (timeFormat === '24h') return `${String(hours).padStart(2, '0')}:${minutes}`
  const h12 = hours % 12 || 12
  const ampm = hours < 12 ? 'AM' : 'PM'
  return `${h12}:${minutes} ${ampm}`
}

const HFSPA = 'https://haflaway-f14aa.web.app'

// Event-level tokens — resolve once per batch, not per recipient.
function resolveEventTokens(event) {
  const dateString = event.startDate ?? event.calendar?.[0]?.eventDate
  const timeString = event.startDate ?? event.calendar?.[0]?.startTime
  let fDate = ''
  let fTime = ''
  try {
    if (dateString) fDate = formatEventDate(new Date(dateString))
    if (timeString) fTime = formatEventTime(new Date(timeString), event.language, event.timeFormat)
  } catch (e) {
    console.warn('resolveEventTokens: date parse error', e.message)
  }
  return {
    eventname: event.title ?? '',
    venue: event.location ?? '',
    date: fDate,
    time: fTime,
  }
}

// Substitutes every {{token}} / @token pair into `message`. eventTokens is
// the object resolveEventTokens() returns (pass {} to skip event-level tokens).
function refineMessage(eventId, fullName, passcode, message, cardUrl, cardName, pledgedAmount, paidAmount, eventTokens = {}) {
  const debt = Math.max(0, (pledgedAmount ?? 0) - (paidAmount ?? 0))
  const remit = `${HFSPA}/changia/${eventId}/${passcode}`
  const eventUrl = `${HFSPA}/events/${eventId}/${passcode}`
  const tokens = [
    ['username', fullName],
    ['passcode', passcode],
    ['card', cardUrl],
    ['cname', cardName],
    ['pledge', pledgedAmount],
    ['paid', paidAmount],
    ['debt', debt],
    ['remit', remit],
    ['event', eventUrl],
    ['eventname', eventTokens.eventname ?? ''],
    ['venue', eventTokens.venue ?? ''],
    ['date', eventTokens.date ?? ''],
    ['time', eventTokens.time ?? ''],
  ]
  let newMsg = message ?? ''
  for (const [key, val] of tokens) {
    newMsg = newMsg.replaceAll(`{{${key}}}`, val ?? '')
    newMsg = newMsg.replaceAll(`@${key}`, val ?? '')
  }
  return newMsg
}

module.exports = { resolveEventTokens, refineMessage, formatEventDate, formatEventTime }
