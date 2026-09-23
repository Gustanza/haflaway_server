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
//   per (category, language) pair: { category, language, contentSid, addedAt, addedBy }
//
// Consumption gate: exactly like smsCredentials.js — saving credentials and
// templates isn't enough on its own, they only actually get used once staff
// has approved that org's branding (organizations/{orgId}.brandingApproved).
// isBrandingApproved is imported from smsCredentials.js rather than
// re-implemented, since it's the same flag and the same read.
const { getDb, admin } = require('../firebase')
const { isBrandingApproved } = require('./smsCredentials')
const { WHATSAPP_TEMPLATE_CATEGORIES } = require('../dispatch/whatsappTemplateCategories')

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
  if (!WHATSAPP_TEMPLATE_CATEGORIES.includes(category)) {
    throw new Error(`Unknown WhatsApp template category "${category}" — expected one of: ${WHATSAPP_TEMPLATE_CATEGORIES.join(', ')}.`)
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

// Always a full replace of exactly the four fields — never a partial merge of
// the credential fields themselves, so rotating one leaves nothing stale
// sitting alongside it. merge:true at the Firestore level only so this never
// touches anything else that might one day live on this doc.
async function setCredentials(orgId, credentials, updatedBy) {
  const doc = {}
  for (const field of CREDENTIAL_FIELDS) {
    const value = String(credentials?.[field] ?? '').trim()
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
// configured, when they were last set, and the (non-secret) template
// mapping — so credentials can't leak back out through the same read path
// used to render the "Configured" badge.
async function getStatus(orgId) {
  const [credSnap, templatesSnap, brandingApproved] = await Promise.all([
    credentialsDocRef(orgId).get(),
    templatesCol(orgId).get(),
    isBrandingApproved(orgId),
  ])
  const data = credSnap.exists ? credSnap.data() : null
  const templates = templatesSnap.docs.map(d => d.data())
  return {
    configured: isConfigured(data),
    updatedAt: data?.updatedAt ?? null,
    templates,
    brandingApproved,
  }
}

// Internal use only (dispatch/whatsapp.js) — the one place allowed to read
// the actual secret values back out. Branding-gated: an unapproved org reads
// as having no credentials at all here, so dispatch falls back to Haflaway's
// shared Twilio account even if the org has valid keys saved.
async function getCredentials(orgId) {
  if (!(await isBrandingApproved(orgId))) return null
  const snap = await credentialsDocRef(orgId).get()
  const data = snap.exists ? snap.data() : null
  return isConfigured(data) ? data : null
}

// Same branding gate as getCredentials — a template only takes effect once
// the org is approved, even though it can be registered (and test-sent)
// before that.
async function getTemplate(orgId, category, language) {
  if (!(await isBrandingApproved(orgId))) return null
  const snap = await templatesCol(orgId).doc(templateDocId(category, language)).get()
  return snap.exists ? snap.data() : null
}

// Deliberately bypasses the branding-approval gate — used only by the
// owner's own self-test-send route (routes/organizations.js), so they can
// verify a template renders correctly *before* staff approval lands, without
// that test ever being able to go out through Haflaway's shared account.
// Never call this from real campaign dispatch (routes/campaigns.js) — that
// path must always go through the gated getCredentials/getTemplate above.
async function getCredentialsForOwnerTest(orgId) {
  const snap = await credentialsDocRef(orgId).get()
  const data = snap.exists ? snap.data() : null
  return isConfigured(data) ? data : null
}

async function getTemplateForOwnerTest(orgId, category, language) {
  const snap = await templatesCol(orgId).doc(templateDocId(category, language)).get()
  return snap.exists ? snap.data() : null
}

// Owner-only self-service: the org already got this Content Template
// approved directly with Twilio/Meta on their own account, so there's
// nothing for Haflaway to review — registering it here just tells dispatch
// it's usable. Requires the org's own Twilio credentials to already be
// configured, same precondition smsCredentials.js's addSenderId enforces —
// a contentSid has no meaning without the account it was approved in.
async function setTemplate(orgId, category, language, rawContentSid, addedBy) {
  assertKnownCategory(category)
  assertKnownLanguage(language)
  const contentSid = String(rawContentSid ?? '').trim()
  if (!contentSid) throw new Error('Enter a Content SID.')

  const credSnap = await credentialsDocRef(orgId).get()
  if (!isConfigured(credSnap.exists ? credSnap.data() : null)) {
    throw new Error('Configure your own Twilio credentials above before registering a template.')
  }

  await templatesCol(orgId).doc(templateDocId(category, language)).set({
    category, language, contentSid,
    addedAt: admin.firestore.FieldValue.serverTimestamp(),
    addedBy,
  })
  return { category, language, contentSid }
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
