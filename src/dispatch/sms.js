// Direct SMS dispatch — ported from functions/sms/indesms.js and its
// beem.js/onfon.js/wasambazie.js/smtz.js provider adapters (origin/messaging),
// using the runtime's built-in fetch instead of axios. Delivery-report
// webhooks (reportOnFons, reportWasambazie, reportSmtz — still deployed) keep
// working unchanged — they only need a messageLogs/{requestId} doc with the
// right fields.
const { resolveEventTokens, refineMessage } = require('./messageTokens')
const { DEFAULT_SENDER_ID, pickSenderId } = require('./senderId')
const {
  getCredentials, getConfiguredProviders, getSenderPool, getPlatformActiveProvider, resolveEffectiveProvider,
} = require('../organizations/smsCredentials')
const { getMessagingMode } = require('../organizations/messagingAccounts')

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

// THE routing decision for every SMS send batch (routes/campaigns.js calls
// this once, before any message goes out). The org's staff-set switch
// (organizations/messagingAccounts.js) is the only input that picks the
// account:
//
//   'own'      → one of the org's own configured providers (smtz/wasambazie),
//                its own credentials, and a sender ID from its own pool. No
//                credentials, no sender ID, or anything unreadable → throws.
//                Never falls back to Haflaway's account or the HAFLAWAY name.
//   'haflaway' → the platform's active provider on Haflaway's own keys, as
//                HAFLAWAY. The org's own credentials are never read.
//
// Returns { mode, providerName, credentials, senderId }; `credentials` is
// passed straight to sendSmsCard (null for beem/onfonmedia, which only ever
// run on Haflaway's keys).
async function resolveSmsRoute(db, event) {
  const mode = await getMessagingMode(event.orgId, 'sms')

  if (mode === 'own') {
    const refusal = 'This organization sends SMS only through its own provider account'
    const configured = await getConfiguredProviders(event.orgId)
    if (!configured.length) {
      throw new Error(`${refusal}, but no smtz or wasambazie credentials are saved. Add them on the Organization page — nothing was sent.`)
    }
    const platform = await getPlatformActiveProvider()
    const providerName = resolveEffectiveProvider(configured, platform)
    const [data, pool] = await Promise.all([
      getCredentials(event.orgId, providerName),
      getSenderPool(event.orgId, providerName),
    ])
    const credentials = providerName === 'smtz'
      ? { apiKey: data?.apiKey }
      : { publicKey: data?.publicKey, secretKey: data?.secretKey }
    if (Object.values(credentials).some(v => !v)) {
      throw new Error(`${refusal}, but its ${providerName} credentials are incomplete. Nothing was sent.`)
    }
    if (!pool.senderIds.length) {
      throw new Error(`${refusal}, but it has no sender ID registered on ${providerName}. Add one on the Organization page — nothing was sent.`)
    }
    return { mode, providerName, credentials, senderId: pickSenderId(event.senderId, pool) }
  }

  const providerName = await getActiveSmsProvider(db)
  let credentials = null
  if (providerName === 'smtz') credentials = { apiKey: process.env.SMTZ_API_KEY }
  if (providerName === 'wasambazie') credentials = { publicKey: process.env.WASAMBAZIE_PUBLIC_KEY, secretKey: process.env.WASAMBAZIE_SECRET_KEY }
  return { mode, providerName, credentials, senderId: DEFAULT_SENDER_ID }
}

// `credentials` always comes from resolveSmsRoute — there is no lookup or
// fallback in here, so a send can only ever go out on the account the route
// decided.
async function sendSmsCard({ providerName, credentials, message, attendeeId, phoneNumber, senderId }) {
  if (providerName === 'beem') return useBeem(message, attendeeId, phoneNumber, senderId)
  if (providerName === 'onfonmedia') return useOnFon(message, phoneNumber, senderId)
  if (providerName === 'wasambazie') return useWasambazie(message, phoneNumber, senderId, credentials?.publicKey, credentials?.secretKey)
  if (providerName === 'smtz') return useSmtz(message, phoneNumber, senderId, credentials?.apiKey)
  throw new Error(`No SMS adapter for provider "${providerName}" — only ${[...SUPPORTED_SMS_PROVIDERS].join('/')} are implemented here.`)
}

module.exports = {
  sendSmsCard,
  resolveSmsRoute,
  getActiveSmsProvider,
  resolveEventTokens,
  refineMessage,
  SUPPORTED_SMS_PROVIDERS,
  SMS_CHARS_PER_SEGMENT,
}
