// Ported from functions/utils/senderId.js (origin/messaging) — kept
// byte-for-byte equivalent since this is exactly what determines which
// brand name a guest's SMS appears to come from, and getting the fallback
// chain wrong either shows the wrong org's name or silently reverts to
// HAFLAWAY for an org that paid to have its own sender ID approved.
const { getDb } = require('../firebase')

const DEFAULT_SENDER_ID = 'HAFLAWAY'
const SENDER_IDS_SUBCOL = 'senderIds'
const SENDER_ID_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  REVOKED: 'revoked',
}

function normalizeSenderId(raw) {
  return String(raw ?? '').trim().toUpperCase()
}

function tsMillis(v) {
  if (!v) return Number.MAX_SAFE_INTEGER
  if (typeof v.toMillis === 'function') return v.toMillis()
  const parsed = Date.parse(v)
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed
}

function sortForDefault(docs) {
  return [...docs].sort((a, b) => {
    const at = tsMillis(a.approvedAt)
    const bt = tsMillis(b.approvedAt)
    if (at !== bt) return at - bt
    return normalizeSenderId(a.value).localeCompare(normalizeSenderId(b.value))
  })
}

// Precedence: 1) this event's own pick if still approved for this org,
// 2) the org's flagged default, 3) the oldest approved id, 4) HAFLAWAY.
function pickSenderId(eventSenderId, senderIdDocs) {
  const approved = (senderIdDocs ?? []).filter(d => d?.status === SENDER_ID_STATUS.APPROVED)
  if (!approved.length) return DEFAULT_SENDER_ID

  const wanted = normalizeSenderId(eventSenderId)
  if (wanted) {
    const match = approved.find(d => normalizeSenderId(d.value) === wanted)
    if (match) return normalizeSenderId(match.value)
  }

  const flagged = approved.find(d => d.isDefault === true)
  if (flagged) return normalizeSenderId(flagged.value)

  return normalizeSenderId(sortForDefault(approved)[0].value)
}

// One subcollection read per dispatch batch, not per recipient.
async function resolveSenderIdForEvent(event) {
  if (!event?.orgId) return DEFAULT_SENDER_ID
  try {
    const snap = await getDb()
      .collection('organizations').doc(event.orgId)
      .collection(SENDER_IDS_SUBCOL)
      .where('status', '==', SENDER_ID_STATUS.APPROVED)
      .get()
    return pickSenderId(event.senderId, snap.docs.map(d => ({ id: d.id, ...d.data() })))
  } catch (err) {
    console.warn(`resolveSenderIdForEvent: falling back to default for org ${event.orgId}:`, err.message)
    return DEFAULT_SENDER_ID
  }
}

module.exports = { DEFAULT_SENDER_ID, resolveSenderIdForEvent, pickSenderId, normalizeSenderId }
