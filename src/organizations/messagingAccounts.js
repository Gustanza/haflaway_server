// Which account an organization's messages go out on — Haflaway's shared
// accounts, or the org's own (their own Twilio for WhatsApp, their own
// smtz/wasambazie for SMS). One explicit, staff-controlled switch per
// channel, flipped from haflaway_admin_spa's Organizations screen:
//
//   organizations/{orgId}.messagingAccounts = { whatsapp: 'own'|'haflaway', sms: 'own'|'haflaway' }
//
// This switch is the ONLY thing that decides routing. Saved credentials,
// registered templates/sender IDs and branding approval don't route anything
// on their own any more — an org sends on its own account only when staff
// have set its switch to 'own', and then it sends on its own account
// exclusively: if anything it needs is missing (credentials, a template for
// that message type/language, a sender ID) or can't be read, dispatch
// refuses the send instead of falling back to Haflaway's account (see
// dispatch/whatsapp.js resolveWhatsAppRoute and dispatch/sms.js
// resolveSmsRoute). The reverse holds too: on 'haflaway', an org's own
// credentials are never touched.
//
// Absent (every org created before this switch existed) reads as 'haflaway'.
//
// Every change is recorded in organizations/{orgId}/messagingAccountHistory,
// written in the same transaction as the switch itself (see setMessagingMode),
// so there's no way to change it without leaving a record.
const { getDb, admin } = require('../firebase')

const MESSAGING_CHANNELS = ['whatsapp', 'sms']
const MESSAGING_MODES = ['haflaway', 'own']
const HISTORY_SUBCOL = 'messagingAccountHistory'

function assertChannel(channel) {
  if (!MESSAGING_CHANNELS.includes(channel)) {
    throw new Error(`Unknown channel "${channel}" — expected ${MESSAGING_CHANNELS.join(' or ')}.`)
  }
}

function modesFrom(orgData) {
  const raw = orgData?.messagingAccounts ?? {}
  return {
    whatsapp: raw.whatsapp === 'own' ? 'own' : 'haflaway',
    sms: raw.sms === 'own' ? 'own' : 'haflaway',
  }
}

// Deliberately does NOT swallow read errors: if the org doc can't be read,
// nobody knows which account this send belongs on, so the caller's send must
// fail rather than guess. An event with no org always sends on Haflaway's.
async function getMessagingMode(orgId, channel) {
  assertChannel(channel)
  if (!orgId) return 'haflaway'
  const snap = await getDb().collection('organizations').doc(orgId).get()
  if (!snap.exists) throw new Error(`Organization ${orgId} not found — refusing to guess which account to send from.`)
  return modesFrom(snap.data())[channel]
}

async function getMessagingModes(orgId) {
  if (!orgId) return modesFrom(null)
  const snap = await getDb().collection('organizations').doc(orgId).get()
  return modesFrom(snap.exists ? snap.data() : null)
}

// Flips one channel's switch and appends its history entry atomically.
// `changedBy` is { uid, email, name } of the staff member (see
// middleware/staffAccess.js). A no-op change (already in that mode) is
// rejected rather than silently logged, so the history only ever holds real
// changes.
async function setMessagingMode(orgId, channel, mode, changedBy, note) {
  assertChannel(channel)
  if (!MESSAGING_MODES.includes(mode)) {
    throw new Error(`Unknown mode "${mode}" — expected ${MESSAGING_MODES.join(' or ')}.`)
  }
  const db = getDb()
  const orgRef = db.collection('organizations').doc(orgId)
  const historyRef = orgRef.collection(HISTORY_SUBCOL).doc()
  const cleanNote = String(note ?? '').trim().slice(0, 500) || null

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(orgRef)
    if (!snap.exists) throw new Error(`Organization ${orgId} not found.`)
    const from = modesFrom(snap.data())[channel]
    if (from === mode) throw new Error(`${channel === 'sms' ? 'SMS' : 'WhatsApp'} is already set to ${mode === 'own' ? 'their own account' : "Haflaway's account"}.`)
    const now = admin.firestore.FieldValue.serverTimestamp()
    tx.update(orgRef, {
      [`messagingAccounts.${channel}`]: mode,
      [`messagingAccounts.${channel}UpdatedAt`]: now,
      [`messagingAccounts.${channel}UpdatedBy`]: changedBy.uid,
    })
    tx.set(historyRef, {
      channel,
      from,
      to: mode,
      changedBy,
      changedAt: now,
      note: cleanNote,
    })
  })
  return { channel, mode }
}

async function getMessagingHistory(orgId, limit = 50) {
  const snap = await getDb().collection('organizations').doc(orgId).collection(HISTORY_SUBCOL)
    .orderBy('changedAt', 'desc').limit(limit).get()
  return snap.docs.map(d => {
    const data = d.data()
    return { id: d.id, ...data, changedAt: data.changedAt?.toDate?.().toISOString() ?? null }
  })
}

module.exports = {
  MESSAGING_CHANNELS,
  MESSAGING_MODES,
  modesFrom,
  getMessagingMode,
  getMessagingModes,
  setMessagingMode,
  getMessagingHistory,
}
