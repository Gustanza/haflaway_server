// Org-owned Twilio credentials, plus the org's own approved WhatsApp Content
// Template mapping that rides along with them — lets an org bring its own
// Twilio account (with its own WhatsApp Business number and its own
// Meta-approved Content Templates) so its WhatsApp sends are billed to that
// account instead of Haflaway's shared one.
//
// Unlike smsCredentials.js's smtz/wasambazie pair, a Twilio Content Template's
// `contentSid` only exists inside the Twilio account it was approved in — so
// an org's own credentials and an org's own template only mean anything
// *together*. Each template is self-registered by the org (no Haflaway
// review), same trust model as the self-service sender IDs in
// smsCredentials.js: it's their own account and their own liability.
//
// Storage:
//   organizations/{orgId}/twilioCredentials/whatsapp — one doc:
//     { accountSid, apiKeySid, apiKeySecret, whatsappSender, updatedAt, updatedBy }
//   organizations/{orgId}/whatsappTemplates/{category}_{language} — one doc
//   per (category, language) pair: { category, language, contentSid, name,
//   content, notes, active, addedAt, addedBy, updatedAt, updatedBy } — the
//   same descriptive fields haflaway_admin_spa's WhatsAppTemplatesView.vue
//   records for Haflaway's shared messageTemplates library.
//
// Consumption gate: saving credentials and templates isn't enough on its own —
// they're only ever used once staff set this org's WhatsApp switch to 'own'
// (organizations/messagingAccounts.js), and dispatch/whatsapp.js's
// resolveWhatsAppRoute is the one place that decides that. The reads below
// are deliberately ungated so that decision (and its "refuse, never fall
// back" rule) lives in exactly one place.
const { getDb, admin } = require('../firebase')
const { isBrandingApproved } = require('./smsCredentials')
const { getMessagingModes } = require('./messagingAccounts')
const { ORG_WHATSAPP_TEMPLATE_CATEGORIES } = require('../dispatch/whatsappTemplateCategories')

const CREDENTIALS_SUBCOL = 'twilioCredentials'
const CREDENTIALS_DOC_ID = 'whatsapp'
const TEMPLATES_SUBCOL = 'whatsappTemplates'

// accountSid/apiKeySid/apiKeySecret are a Twilio API Key (not the raw Account
// SID + Auth Token) — scopes what a leaked credential can do to this one
// account rather than granting full account access. whatsappSender is either
// a `whatsapp:+E164` number or a Messaging Service SID, whichever the org's
// own Twilio setup uses — Twilio's own `from` param accepts either.
const CREDENTIAL_FIELDS = ['accountSid', 'apiKeySid', 'apiKeySecret', 'whatsappSender']

function assertKnownCategory(category) {
  if (!ORG_WHATSAPP_TEMPLATE_CATEGORIES.includes(category)) {
    throw new Error(`Unknown WhatsApp template category "${category}" — expected one of: ${ORG_WHATSAPP_TEMPLATE_CATEGORIES.join(', ')}.`)
  }
}

function assertKnownLanguage(language) {
  if (language !== 'sw' && language !== 'en') {
    throw new Error(`Unknown language "${language}" — expected "sw" or "en".`)
  }
}

function credentialsDocRef(orgId) {
  return getDb().collection('organizations').doc(orgId).collection(CREDENTIALS_SUBCOL).doc(CREDENTIALS_DOC_ID)
}

function templatesCol(orgId) {
  return getDb().collection('organizations').doc(orgId).collection(TEMPLATES_SUBCOL)
}

function templateDocId(category, language) {
  return `${category}_${language}`
}

function isConfigured(data) {
  return !!data && CREDENTIAL_FIELDS.every(f => data[f])
}

// Masked hints for the status read so the form can show *that* each value is
// saved without the value itself coming back: identifiers keep their 2-char
// type prefix (AC/SK/MG) plus the last 4, the sender keeps its last 4, and the
// secret reveals nothing but its presence.
function maskValue(value, { prefix = 0, suffix = 4 } = {}) {
  if (!value) return null
  const s = String(value).replace(/^whatsapp:/, '')
  if (s.length <= prefix + suffix) return '••••••••'
  return `${s.slice(0, prefix)}••••••••${s.slice(-suffix)}`
}

function maskCredentials(data) {
  if (!data) return null
  return {
    accountSid: maskValue(data.accountSid, { prefix: 2 }),
    apiKeySid: maskValue(data.apiKeySid, { prefix: 2 }),
    apiKeySecret: data.apiKeySecret ? '••••••••••••' : null,
    whatsappSender: maskValue(data.whatsappSender, { prefix: /^MG/.test(data.whatsappSender) ? 2 : 0 }),
  }
}

// Always writes all four fields together. A field left blank keeps its
// currently saved value (so rotating just the secret doesn't mean re-pasting
// the SIDs); with nothing saved yet, every field is required. merge:true at
// the Firestore level only so this never touches anything else that might one
// day live on this doc.
async function setCredentials(orgId, credentials, updatedBy) {
  const needsExisting = CREDENTIAL_FIELDS.some(f => !String(credentials?.[f] ?? '').trim())
  const existingSnap = needsExisting ? await credentialsDocRef(orgId).get() : null
  const existing = existingSnap?.exists ? existingSnap.data() : {}
  const doc = {}
  for (const field of CREDENTIAL_FIELDS) {
    const value = String(credentials?.[field] ?? '').trim() || existing[field]
    if (!value) throw new Error(`${field} is required.`)
    doc[field] = value
  }
  await credentialsDocRef(orgId).set(
    { ...doc, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy },
    { merge: true }
  )
  return { configured: true }
}

// Drops the org's Twilio credentials AND every template registered against
// them — a contentSid has no meaning once the Twilio account it was approved
// in is unplugged, so it can't survive to be silently reused against
// Haflaway's shared account (whose Twilio account never approved it).
async function clearCredentials(orgId) {
  const templatesSnap = await templatesCol(orgId).get()
  const batch = getDb().batch()
  batch.delete(credentialsDocRef(orgId))
  for (const doc of templatesSnap.docs) batch.delete(doc.ref)
  await batch.commit()
  return { configured: false }
}

// Never returns the secret values — only whether Twilio credentials are
// configured, when they were last set, masked hints of each field (see
// maskCredentials), and the (non-secret) template mapping — so credentials
// can't leak back out through the same read path used to render the
// "Configured" badge.
async function getStatus(orgId) {
  const [credSnap, templatesSnap, brandingApproved, modes] = await Promise.all([
    credentialsDocRef(orgId).get(),
    templatesCol(orgId).get(),
    isBrandingApproved(orgId),
    getMessagingModes(orgId),
  ])
  const data = credSnap.exists ? credSnap.data() : null
  const templates = templatesSnap.docs.map(d => d.data())
  return {
    configured: isConfigured(data),
    updatedAt: data?.updatedAt?.toDate?.().toISOString() ?? null,
    masked: maskCredentials(data),
    templates,
    brandingApproved,
    // 'own' | 'haflaway' — the staff-set switch that decides whose account
    // this org's WhatsApp actually goes out on (organizations/messagingAccounts.js).
    mode: modes.whatsapp,
  }
}

// Internal use only (dispatch/whatsapp.js, and the owner's test-send route) —
// the one place allowed to read the actual secret values back out. Not gated
// on anything: whether these may be used for a real send is decided solely by
// resolveWhatsAppRoute (dispatch/whatsapp.js) from the org's switch.
async function getCredentials(orgId) {
  const snap = await credentialsDocRef(orgId).get()
  const data = snap.exists ? snap.data() : null
  return isConfigured(data) ? data : null
}

// The raw registered entry (active or not) — callers decide what an inactive
// one means: real dispatch refuses it, the owner's test send still uses it.
async function getTemplate(orgId, category, language) {
  const snap = await templatesCol(orgId).doc(templateDocId(category, language)).get()
  return snap.exists ? snap.data() : null
}

// The owner's self-test-send route (routes/organizations.js) — same reads,
// kept as named aliases so that route reads as clearly never touching
// Haflaway's shared account.
const getCredentialsForOwnerTest = getCredentials
const getTemplateForOwnerTest = getTemplate

// Owner-only self-service: the org already got this Content Template
// approved directly with Twilio/Meta on their own account, so there's
// nothing for Haflaway to review — registering it here just tells dispatch
// it's usable. Requires the org's own Twilio credentials to already be
// configured, same precondition smsCredentials.js's addSenderId enforces —
// a contentSid has no meaning without the account it was approved in.
//
// `meta` carries the same descriptive fields as the shared library's
// WhatsAppTemplatesView.vue form: name + display text (required), notes
// (optional), active (defaults on). The doc id *is* (category, language), so:
//   - adding (no meta.previous) refuses a slot that's already taken, rather
//     than silently replacing whatever template was registered there;
//   - editing passes meta.previous = { category, language } — the entry's
//     current slot. If category/language changed, the entry moves: new doc
//     written, old doc deleted, in one transaction, refusing a taken target
//     slot. addedAt/addedBy carry over from the entry being edited.
async function setTemplate(orgId, category, language, rawContentSid, addedBy, meta = {}) {
  assertKnownCategory(category)
  assertKnownLanguage(language)
  const contentSid = String(rawContentSid ?? '').trim()
  if (!contentSid) throw new Error('Enter a Content SID.')
  const name = String(meta.name ?? '').trim()
  if (!name) throw new Error('Enter a name for this template.')
  const content = String(meta.content ?? '').trim()
  if (!content) throw new Error('Enter the display text organizers will see in the send picker.')
  const notes = String(meta.notes ?? '').trim() || null
  const active = meta.active !== false
  const previous = meta.previous ?? null
  if (previous) {
    assertKnownCategory(previous.category)
    assertKnownLanguage(previous.language)
  }

  const credSnap = await credentialsDocRef(orgId).get()
  if (!isConfigured(credSnap.exists ? credSnap.data() : null)) {
    throw new Error('Configure your own Twilio credentials above before registering a template.')
  }

  const docRef = templatesCol(orgId).doc(templateDocId(category, language))
  const prevRef = previous ? templatesCol(orgId).doc(templateDocId(previous.category, previous.language)) : null
  const moving = !!prevRef && prevRef.id !== docRef.id

  await getDb().runTransaction(async (tx) => {
    const [targetSnap, prevSnap] = await Promise.all([
      tx.get(docRef),
      moving ? tx.get(prevRef) : Promise.resolve(null),
    ])
    if (targetSnap.exists && (!previous || moving)) {
      throw new Error('You already have a template for that message type and language — edit or remove that one instead.')
    }
    if (previous && !(moving ? prevSnap : targetSnap).exists) {
      throw new Error('That template no longer exists — it may have been removed. Close this and try again.')
    }
    const existing = moving ? prevSnap.data() : (targetSnap.exists ? targetSnap.data() : null)
    const now = admin.firestore.FieldValue.serverTimestamp()
    tx.set(docRef, {
      category, language, contentSid, name, content, notes, active,
      addedAt: existing?.addedAt ?? now,
      addedBy: existing?.addedBy ?? addedBy,
      updatedAt: now,
      updatedBy: addedBy,
    })
    if (moving) tx.delete(prevRef)
  })
  return { category, language, contentSid, name, content, notes, active }
}

async function removeTemplate(orgId, category, language) {
  assertKnownCategory(category)
  assertKnownLanguage(language)
  await templatesCol(orgId).doc(templateDocId(category, language)).delete()
  return { category, language }
}

module.exports = {
  CREDENTIAL_FIELDS,
  assertKnownCategory,
  assertKnownLanguage,
  setCredentials,
  clearCredentials,
  getStatus,
  getCredentials,
  getTemplate,
  getCredentialsForOwnerTest,
  getTemplateForOwnerTest,
  setTemplate,
  removeTemplate,
}
