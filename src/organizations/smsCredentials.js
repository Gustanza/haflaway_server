// Org-owned smtz/wasambazie credentials, plus the self-service sender-ID
// pool that rides along with them — lets an org bring its own provider
// account (signed up directly with smtz/wasambazie, outside Haflaway) so
// their SMS is billed to that account instead of Haflaway's shared one, and
// lets them register their own sender IDs against it without waiting on
// Haflaway staff review. A sender ID only means something against the
// provider account it was registered with, so it lives and dies with that
// provider's own credentials doc — clearing the credentials clears the pool
// too (see clearCredentials below).
//
// Storage: organizations/{orgId}/smsCredentials/{provider}, one doc per
// provider — { apiKey } or { publicKey, secretKey }, plus
// `senderIds: { [VALUE]: { addedAt, addedBy } }` and `defaultSenderId`.
//
// The write path lives here (server/src/routes/organizations.js calls this
// for both the credentials CRUD and the sender-ID CRUD); the read/consume
// path (dispatch/sms.js, dispatch/senderId.js) also calls into this module
// so there's one place that knows the storage shape.
//
// Consumption gate: saving credentials isn't enough on its own — an org's
// own account (and the sender-ID pool riding on it) only actually gets used
// once staff has approved that org's branding (organizations/{orgId}
// .brandingApproved, the pill haflaway_admin_spa's Organizations view
// flips). isBrandingApproved() below is checked first, before configured
// state even matters — see getConfiguredProviders/getCredentials.
const { getDb, admin } = require('../firebase')

const CREDENTIALS_SUBCOL = 'smsCredentials'

// Which secret fields each provider needs — smtz takes one bearer API key,
// wasambazie takes a public/secret key pair. Mirrors dispatch/sms.js's
// useSmtz/useWasambazie.
const CREDENTIAL_FIELDS = {
  smtz: ['apiKey'],
  wasambazie: ['publicKey', 'secretKey'],
}

// GSM alphanumeric originator limits: max 11 characters, and carriers across
// the TZ/KE routes these providers use reject anything with punctuation or a
// leading digit. Minimum 3 keeps it recognisable as a brand. Mirrors the
// rules the old staff-reviewed flow enforced (functions/utils/senderId.js) —
// self-service doesn't mean unchecked, it just means no human in the loop.
const SENDER_ID_MIN = 3
const SENDER_ID_MAX = 11

function assertKnownProvider(provider) {
  // hasOwnProperty, not a bare truthiness check — otherwise an inherited
  // Object.prototype name ('toString', 'constructor', …) would read as
  // "known" and blow up later trying to iterate a function.
  if (!Object.prototype.hasOwnProperty.call(CREDENTIAL_FIELDS, provider)) {
    throw new Error(`Unknown SMS provider "${provider}" — expected one of: ${Object.keys(CREDENTIAL_FIELDS).join(', ')}.`)
  }
}

function normalizeSenderId(raw) {
  return String(raw ?? '').trim().toUpperCase()
}

// Returns { ok: true, value } or { ok: false, message } — the message is
// shown verbatim to the org owner, so it explains the rule rather than
// naming it.
function validateSenderId(raw) {
  const value = normalizeSenderId(raw)
  if (!value) return { ok: false, message: 'Enter a sender ID.' }
  if (value.length < SENDER_ID_MIN) return { ok: false, message: `Sender IDs must be at least ${SENDER_ID_MIN} characters.` }
  if (value.length > SENDER_ID_MAX) return { ok: false, message: `Sender IDs can be at most ${SENDER_ID_MAX} characters — networks reject anything longer.` }
  if (!/^[A-Z0-9]+$/.test(value)) return { ok: false, message: 'Use letters and numbers only — no spaces, punctuation or accents.' }
  if (!/[A-Z]/.test(value)) return { ok: false, message: 'Sender IDs must contain at least one letter, otherwise networks treat them as a phone number.' }
  if (/^[0-9]/.test(value)) return { ok: false, message: 'Sender IDs cannot start with a number.' }
  return { ok: true, value }
}

// Firestore Timestamp | ISO string | undefined → comparable number.
function tsMillis(v) {
  if (!v) return Number.MAX_SAFE_INTEGER
  if (typeof v.toMillis === 'function') return v.toMillis()
  const parsed = Date.parse(v)
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed
}

// Oldest-added first, value as tiebreak — deterministic so a fallback pick
// can't flip between two batches of the same campaign.
function sortSenderIds(map) {
  return Object.keys(map ?? {}).sort((a, b) => tsMillis(map[a]?.addedAt) - tsMillis(map[b]?.addedAt) || a.localeCompare(b))
}

function credentialsDocRef(orgId, provider) {
  return getDb().collection('organizations').doc(orgId).collection(CREDENTIALS_SUBCOL).doc(provider)
}

function isConfigured(provider, data) {
  return !!data && CREDENTIAL_FIELDS[provider].every(f => data[f])
}

// The same staff-reviewed gate OrganizationsView.vue (haflaway_admin_spa)
// flips with its "Approved" / "Not approved" pill — organizations/{orgId}.
// brandingApproved. Typing in valid smtz/wasambazie keys is no longer
// sufficient on its own: an org's own credentials, and the self-service
// sender-ID pool that rides along with them, only take effect once staff
// has approved that org, same trust boundary as everything else that pill
// gates. An org can still save/manage credentials and sender IDs before
// approval (so they're ready to go the moment it lands) — this only gates
// *consumption* (getCredentials/getConfiguredProviders below), not the CRUD
// routes in routes/organizations.js.
async function isBrandingApproved(orgId) {
  if (!orgId) return false
  const snap = await getDb().collection('organizations').doc(orgId).get()
  return snap.exists && snap.data().brandingApproved === true
}

// Whichever provider Haflaway currently routes SMS through platform-wide —
// a single ops-controlled switch (organizations/{orgId} plays no part in
// this), flipped by hand in the `smsProviders` collection. Only matters for
// orgs that haven't brought their own account at all (see
// resolveEffectiveProvider below).
async function getPlatformActiveProvider() {
  const snap = await getDb().collection('smsProviders').where('isActive', '==', true).limit(1).get()
  return snap.empty ? null : snap.docs[0].data().name
}

// Which BYO-capable providers (smtz/wasambazie) this org has actually
// configured its own credentials for — 0, 1, or 2. Branding approval gates
// this first: an unapproved org reads as having configured nothing, no
// matter what's saved in smsCredentials, so it can never win effective-
// provider resolution below.
async function getConfiguredProviders(orgId) {
  if (!(await isBrandingApproved(orgId))) return []
  const snap = await getDb().collection('organizations').doc(orgId).collection(CREDENTIALS_SUBCOL).get()
  return snap.docs
    .filter(d => CREDENTIAL_FIELDS[d.id] && isConfigured(d.id, d.data()))
    .map(d => d.id)
}

// The provider (and whose account) that actually sends for this org. An org
// that's plugged in its own credentials for a provider always sends through
// that provider on their own account — Haflaway's platform-wide switch only
// decides for an org that hasn't brought anything of its own ("uses
// Haflaway directly"). If an org has configured BOTH smtz and wasambazie,
// whichever matches the platform's current switch wins (so an ops-driven
// platform change still reaches them); if neither matches (platform is on
// beem/onfonmedia, which have no BYO support here), fall back to smtz, then
// wasambazie, deterministically — arbitrary but stable, since configuring
// both is expected to be rare.
function resolveEffectiveProvider(configuredProviders, platformActiveProvider) {
  if (!configuredProviders.length) return platformActiveProvider
  if (configuredProviders.includes(platformActiveProvider)) return platformActiveProvider
  return configuredProviders.includes('smtz') ? 'smtz' : configuredProviders[0]
}

// Firestore-backed wrapper for dispatch (routes/campaigns.js) — the pure
// decision lives in resolveEffectiveProvider so getStatus() (which already
// has both pieces of data loaded) doesn't need a second round trip.
async function resolveProviderForOrg(orgId, platformActiveProvider) {
  if (!orgId) return platformActiveProvider
  const configured = await getConfiguredProviders(orgId)
  return resolveEffectiveProvider(configured, platformActiveProvider)
}

// Always a full replace of exactly the fields this provider needs — never a
// partial merge of the credential fields themselves, so rotating one key of
// a pair can't leave a stale field from a previous save sitting alongside
// the new one. merge:true at the Firestore level so this never touches
// senderIds/defaultSenderId — rotating a key shouldn't wipe the org's
// self-service sender pool.
async function setCredentials(orgId, provider, credentials, updatedBy) {
  assertKnownProvider(provider)
  const doc = {}
  for (const field of CREDENTIAL_FIELDS[provider]) {
    const value = String(credentials?.[field] ?? '').trim()
    if (!value) throw new Error(`${field} is required for ${provider}.`)
    doc[field] = value
  }

  await credentialsDocRef(orgId, provider).set(
    { ...doc, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy },
    { merge: true }
  )
  return { provider, configured: true }
}

// Drops the org's override AND its self-service sender pool for this
// provider — a sender ID registered on the org's own account has no meaning
// once that account is unplugged, so it can't survive to be silently reused
// against Haflaway's shared account.
async function clearCredentials(orgId, provider) {
  assertKnownProvider(provider)
  await credentialsDocRef(orgId, provider).delete()
  return { provider, configured: false }
}

// Never returns the secret values themselves — only whether each provider
// has an org-specific override configured, when it was last set, and its
// (non-secret) sender-ID pool — so credentials can't leak back out through
// the same read path used to render the "Configured" badge.
async function getStatus(orgId) {
  const [snap, brandingApproved] = await Promise.all([
    getDb().collection('organizations').doc(orgId).collection(CREDENTIALS_SUBCOL).get(),
    isBrandingApproved(orgId),
  ])

  const status = {}
  for (const provider of Object.keys(CREDENTIAL_FIELDS)) {
    status[provider] = { configured: false, updatedAt: null, senderIds: [], defaultSenderId: null }
  }
  // configuredProviders feeds activeProvider below, which is what dispatch
  // actually uses — so it's branding-gated same as getConfiguredProviders,
  // even though status[provider].configured (the "Configured" badge) stays
  // a raw reflection of what's saved, so an owner can see their keys took
  // before staff approval lands.
  const configuredProviders = []
  for (const docSnap of snap.docs) {
    if (!CREDENTIAL_FIELDS[docSnap.id]) continue
    const data = docSnap.data()
    const configured = isConfigured(docSnap.id, data)
    if (configured && brandingApproved) configuredProviders.push(docSnap.id)
    const senderIds = sortSenderIds(data.senderIds)
    status[docSnap.id] = {
      configured,
      updatedAt: data.updatedAt ?? null,
      senderIds,
      defaultSenderId: (data.defaultSenderId && senderIds.includes(data.defaultSenderId)) ? data.defaultSenderId : (senderIds[0] ?? null),
    }
  }

  const platformActiveProvider = await getPlatformActiveProvider()
  // The provider this org's sends actually go through right now — its own
  // configured provider if it has one AND branding is approved, else
  // whatever the platform switch says. `activeProvider` is the name
  // EventSettings.vue/OrganizationSettings.vue already key their sender-ID
  // pool off of, so it stays org-aware here rather than a raw copy of the
  // platform switch.
  const activeProvider = resolveEffectiveProvider(configuredProviders, platformActiveProvider)

  return { ...status, brandingApproved, platformActiveProvider, activeProvider }
}

// Internal use only (dispatch/sms.js, and getSenderPool below) — the one
// place allowed to read the actual secret values back out. Branding-gated
// same as getConfiguredProviders — an unapproved org reads as having no
// credentials at all here, which is what makes resolveOrgSmsCredentials
// (dispatch/sms.js) and getSenderPool (dispatch/senderId.js) fall back to
// Haflaway's shared account/HAFLAWAY sender ID even if the resolved
// provider name happens to match one the org has saved keys for.
async function getCredentials(orgId, provider) {
  if (!(await isBrandingApproved(orgId))) return null
  const snap = await credentialsDocRef(orgId, provider).get()
  return snap.exists ? snap.data() : null
}

// Read-only pool lookup for dispatch (dispatch/senderId.js) and the
// event-level sender-ID-pin route — never exposes the secret credential
// fields, only what's needed to pick/validate a sender ID.
async function getSenderPool(orgId, provider) {
  const data = await getCredentials(orgId, provider)
  if (!isConfigured(provider, data)) return { configured: false, senderIds: [], defaultSenderId: null }
  const senderIds = sortSenderIds(data.senderIds)
  return {
    configured: true,
    senderIds,
    defaultSenderId: (data.defaultSenderId && senderIds.includes(data.defaultSenderId)) ? data.defaultSenderId : (senderIds[0] ?? null),
  }
}

// Owner-only self-service: the org registered this sender ID directly with
// the provider on their own account, so there's nothing for Haflaway to
// review — adding it here just tells dispatch it's usable. Requires the
// provider's credentials to already be configured; a sender ID has no
// meaning against Haflaway's shared account.
async function addSenderId(orgId, provider, rawSenderId, addedBy) {
  assertKnownProvider(provider)
  const check = validateSenderId(rawSenderId)
  if (!check.ok) throw new Error(check.message)

  const ref = credentialsDocRef(orgId, provider)
  const snap = await ref.get()
  const data = snap.exists ? snap.data() : null
  if (!isConfigured(provider, data)) {
    throw new Error(`Configure your own ${provider} credentials above before adding a sender ID.`)
  }
  if (data.senderIds?.[check.value]) {
    throw new Error(`${check.value} is already on this provider's sender IDs.`)
  }

  const isFirst = !data.senderIds || Object.keys(data.senderIds).length === 0
  const update = { [`senderIds.${check.value}`]: { addedAt: admin.firestore.FieldValue.serverTimestamp(), addedBy } }
  if (isFirst) update.defaultSenderId = check.value
  await ref.update(update)

  return { provider, senderId: check.value }
}

// Removing the current default auto-promotes the next-oldest so dispatch
// never has to guess which one to fall back to.
async function removeSenderId(orgId, provider, rawSenderId) {
  assertKnownProvider(provider)
  const value = normalizeSenderId(rawSenderId)
  const ref = credentialsDocRef(orgId, provider)
  const snap = await ref.get()
  const data = snap.exists ? snap.data() : null
  if (!data?.senderIds?.[value]) {
    throw new Error(`${value || 'That sender ID'} isn't on this provider.`)
  }

  const update = { [`senderIds.${value}`]: admin.firestore.FieldValue.delete() }
  if (data.defaultSenderId === value) {
    const remaining = sortSenderIds(data.senderIds).filter(v => v !== value)
    update.defaultSenderId = remaining[0] ?? null
  }
  await ref.update(update)

  return { provider, senderId: value }
}

module.exports = {
  CREDENTIAL_FIELDS,
  assertKnownProvider,
  normalizeSenderId,
  validateSenderId,
  setCredentials,
  clearCredentials,
  getStatus,
  getCredentials,
  getSenderPool,
  addSenderId,
  removeSenderId,
  getPlatformActiveProvider,
  getConfiguredProviders,
  resolveEffectiveProvider,
  resolveProviderForOrg,
  isBrandingApproved,
}
