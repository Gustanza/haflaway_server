// Sender ID resolution — purely self-service now, and only for an org whose
// SMS switch is 'own' (see resolveSmsRoute in dispatch/sms.js). An org's sender IDs only
// exist once they've plugged in their own smtz/wasambazie credentials (see
// organizations/smsCredentials.js), since a sender name only means something
// against the provider account it was registered with. An org still on
// Haflaway's shared account has no pool at all and always sends as HAFLAWAY —
// the old staff-reviewed approval flow (functions/organizations/senderId.js,
// now retired) used to let orgs get a custom name approved for use on
// Haflaway's own shared account; that middle state no longer exists.
const { normalizeSenderId } = require('../organizations/smsCredentials')

const DEFAULT_SENDER_ID = 'HAFLAWAY'

// Precedence: 1) this event's own pick, if it's still in the pool, 2) the
// provider's flagged default, 3) the oldest sender ID in the pool, 4) HAFLAWAY.
function pickSenderId(eventSenderId, pool) {
  if (!pool.configured || !pool.senderIds.length) return DEFAULT_SENDER_ID

  const wanted = normalizeSenderId(eventSenderId)
  if (wanted && pool.senderIds.includes(wanted)) return wanted
  if (pool.defaultSenderId && pool.senderIds.includes(pool.defaultSenderId)) return pool.defaultSenderId
  return pool.senderIds[0]
}

module.exports = { DEFAULT_SENDER_ID, pickSenderId, normalizeSenderId }
