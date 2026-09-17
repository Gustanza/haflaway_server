// Direct SMS dispatch — ported from functions/sms/indesms.js and its
// beem.js/onfon.js/wasambazie.js/smtz.js provider adapters (origin/messaging),
// using the runtime's built-in fetch instead of axios. Delivery-report
// webhooks (reportOnFons, reportWasambazie, reportSmtz — still deployed) keep
// working unchanged — they only need a messageLogs/{requestId} doc with the
// right fields.
const { getDb } = require('../firebase')
const { resolveEventTokens, refineMessage } = require('./messageTokens')
const { DEFAULT_SENDER_ID } = require('./senderId')

// Standard SMS segment size (GSM-7 encoding, matches baseSMS pricing unit) —
// 160, not the 153 a stale copy of this logic used (153 only applies to
// each part of an already-concatenated multi-part message, not the
// single-segment threshold).
const SMS_CHARS_PER_SEGMENT = 160

async function useBeem(message, recipientId, phoneNumber, senderId) {
  const { BEEM_API_KEY, BEEM_SECRET_KEY } = process.env
  if (!BEEM_API_KEY || !BEEM_SECRET_KEY) throw new Error('BEEM_API_KEY / BEEM_SECRET_KEY not set in .env.')
  const auth = Buffer.from(`${BEEM_API_KEY}:${BEEM_SECRET_KEY}`).toString('base64')
  const res = await fetch('https://apisms.beem.africa/v1/send', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_addr: senderId || DEFAULT_SENDER_ID,
      schedule_time: '',
      encoding: 0,
      message,
      recipients: [{ recipient_id: recipientId, dest_addr: phoneNumber }],
    }),
    signal: AbortSignal.timeout(15000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message || `Beem send failed (HTTP ${res.status}).`)
  if (data.request_id === undefined || data.request_id === null) throw new Error('Beem response had no request_id.')
  return { requestId: String(data.request_id), code: data.code, message: data.message }
}

async function useOnFon(message, phoneNumber, senderId) {
  const { ONFON_USERNAME, ONFON_PASSWORD } = process.env
  if (!ONFON_USERNAME || !ONFON_PASSWORD) throw new Error('ONFON_USERNAME / ONFON_PASSWORD not set in .env.')
  const auth = Buffer.from(`${ONFON_USERNAME}:${ONFON_PASSWORD}`).toString('base64')
  const res = await fetch('https://apis.onfonmedia.co.ke/v2_send', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: phoneNumber,
      from: senderId || DEFAULT_SENDER_ID,
      content: message,
      dlr: 'yes',
      'dlr-url': 'https://us-central1-haflaway-f14aa.cloudfunctions.net/reportOnFons',
      'dlr-level': 3,
    }),
    signal: AbortSignal.timeout(15000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message || `OnFon send failed (HTTP ${res.status}).`)
  if (data.message_id === undefined || data.message_id === null) throw new Error('OnFon response had no message_id.')
  return { requestId: String(data.message_id) }
}

async function useWasambazie(message, phoneNumber, senderId, publicKey, secretKey) {
  if (!publicKey || !secretKey) throw new Error('Wasambazie public/secret key not configured.')
  const res = await fetch('https://wasambazie.co.tz/v1/sms/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-PUBLIC-KEY': publicKey,
      'X-API-SECRET-KEY': secretKey,
    },
    body: JSON.stringify({
      to_number: phoneNumber,
      message,
      sender_id: senderId || DEFAULT_SENDER_ID,
    }),
    signal: AbortSignal.timeout(15000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message || `Wasambazie send failed (HTTP ${res.status}).`)
  if (data.message_batch_id === undefined || data.message_batch_id === null) throw new Error('Wasambazie response had no message_batch_id.')
  return { requestId: String(data.message_batch_id), message: data.message }
}

// smtz's own dev/staging endpoint — plain HTTP, no TLS, raw IP, exactly as
// given by the smtz operator (see functions/sms/smtz.js). Its send primitive
// is "submit a campaign to N recipients", not "send one message", so this
// always submits a campaign of exactly one recipient to keep the same call
// shape as the other adapters here. The returned campaign `id` doubles as
// the per-message requestId since there's only ever one message in it.
const SMTZ_API_BASE_URL = 'http://161.97.99.40:3010/api/v1'

async function useSmtz(message, phoneNumber, senderId, apiKey) {
  if (!apiKey) throw new Error('smtz API key not configured.')
  const res = await fetch(`${SMTZ_API_BASE_URL}/campaigns`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      senderId: senderId || DEFAULT_SENDER_ID,
      content: message,
      recipients: [phoneNumber],
    }),
    signal: AbortSignal.timeout(15000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.status || `smtz send failed (HTTP ${res.status}).`)
  if (data.id === undefined || data.id === null) throw new Error('smtz response had no campaign id.')
  return { requestId: String(data.id), message: data.status }
}

async function getActiveSmsProvider(db) {
  const snap = await db.collection('smsProviders').where('isActive', '==', true).limit(1).get()
  if (snap.empty) throw new Error('No active SMS provider configured.')
  return snap.docs[0].data().name
}

const SUPPORTED_SMS_PROVIDERS = new Set(['beem', 'onfonmedia', 'wasambazie', 'smtz'])

// smtz/wasambazie credentials are configurable per-organization from the
// SMS Providers tab in OrganizationSettings.vue (written server-side by the
// setOrgSmsCredentials callable in functions/organizations/smsCredentials.js,
// under organizations/{orgId}/smsCredentials/{provider}). An org that hasn't
// configured its own falls back to the platform default — same behavior as
// before this was configurable, so existing orgs aren't disrupted by this
// rolling out. A lookup failure (bad orgId, Firestore hiccup) degrades to the
// default rather than blocking the send, mirroring resolveSenderIdForEvent.
async function resolveOrgSmsCredentials(orgId, providerName) {
  if (orgId) {
    try {
      const snap = await getDb()
        .collection('organizations').doc(orgId)
        .collection('smsCredentials').doc(providerName)
        .get()
      if (snap.exists) {
        const data = snap.data()
        if (providerName === 'smtz' && data.apiKey) {
          return { apiKey: data.apiKey }
        }
        if (providerName === 'wasambazie' && data.publicKey && data.secretKey) {
          return { publicKey: data.publicKey, secretKey: data.secretKey }
        }
      }
    } catch (err) {
      console.warn(`resolveOrgSmsCredentials: falling back to default for org ${orgId} (${providerName}):`, err.message)
    }
  }
  if (providerName === 'smtz') return { apiKey: process.env.SMTZ_API_KEY }
  return { publicKey: process.env.WASAMBAZIE_PUBLIC_KEY, secretKey: process.env.WASAMBAZIE_SECRET_KEY }
}

async function sendSmsCard({ providerName, message, attendeeId, phoneNumber, senderId, orgId }) {
  if (providerName === 'beem') return useBeem(message, attendeeId, phoneNumber, senderId)
  if (providerName === 'onfonmedia') return useOnFon(message, phoneNumber, senderId)
  if (providerName === 'wasambazie') {
    const { publicKey, secretKey } = await resolveOrgSmsCredentials(orgId, 'wasambazie')
    return useWasambazie(message, phoneNumber, senderId, publicKey, secretKey)
  }
  if (providerName === 'smtz') {
    const { apiKey } = await resolveOrgSmsCredentials(orgId, 'smtz')
    return useSmtz(message, phoneNumber, senderId, apiKey)
  }
  throw new Error(`No SMS adapter for provider "${providerName}" — only ${[...SUPPORTED_SMS_PROVIDERS].join('/')} are implemented here.`)
}

module.exports = {
  sendSmsCard,
  getActiveSmsProvider,
  resolveEventTokens,
  refineMessage,
  SUPPORTED_SMS_PROVIDERS,
  SMS_CHARS_PER_SEGMENT,
}
