// Builds the flat attendeeData map a card template renders against — same
// shape functions/attendees/attendees.js already produces (full_name,
// ticket_type, pass_code, qr_code, label), except ticket_type is now derived
// from the guest's partyType instead of the card template's own `type` label,
// closing the gap discussed at length: a template's ticket_type placeholder
// should read "Single"/"Double"/"Family", not the template's own name.
const JPWEB_BASE_URL = 'https://haflaway.com'

const TICKET_TYPE_BY_PARTY_TYPE = {
  individual: 'SINGLE',
  couple: 'DOUBLE',
  family: 'FAMILY',
}

function resolvePartyType(attendee) {
  // Mirrors the same fallback EventAttendees.vue's edit form already uses for
  // legacy records that predate the partyType field.
  return attendee.partyType || (attendee.partyMembers?.length ? 'couple' : 'individual')
}

function resolveTicketType(attendee) {
  return TICKET_TYPE_BY_PARTY_TYPE[resolvePartyType(attendee)] ?? 'SINGLE'
}

function buildAttendeeData(eventId, attendee, eventLabels = []) {
  const attendeeData = {
    full_name: attendee.fullName,
    ticket_type: resolveTicketType(attendee),
    pass_code: attendee.id,
    qr_code: `${JPWEB_BASE_URL}/#/lv0/${eventId}/${attendee.id}`,
  }

  if (attendee.labelIds?.length) {
    const matched = eventLabels.find(l => l.id === attendee.labelIds[0])
    if (matched) attendeeData.label = matched.name
  }

  return attendeeData
}

module.exports = { buildAttendeeData, resolveTicketType, resolvePartyType }
