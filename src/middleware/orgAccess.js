const { getDb } = require('../firebase')

// requireAuth only establishes WHO is calling — this checks whether that
// person owns :orgId. Owner-only, matching functions/organizations/
// smsCredentials.js's old rule: these are provider account secrets, not
// display config, so there's no non-owner read path at all (mirrors
// requireEventAccess's shape for events).
async function requireOrgOwner(req, res, next) {
  const { orgId } = req.params
  try {
    const orgSnap = await getDb().collection('organizations').doc(orgId).get()
    if (!orgSnap.exists) {
      return res.status(404).json({ ok: false, message: `Organization ${orgId} not found.` })
    }
    if (orgSnap.data().ownerId !== req.uid) {
      return res.status(403).json({ ok: false, message: 'Only the organization owner can manage this.' })
    }
    next()
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message })
  }
}

// Looser than requireOrgOwner — any member (owner included) may pass. Used
// for reads that aren't sensitive (e.g. "is smtz configured, and what sender
// IDs does it have") but that a non-owner org member still needs, such as
// EventSettings.vue's sender-ID picker for an event they own within the org.
async function requireOrgMember(req, res, next) {
  const { orgId } = req.params
  try {
    const orgSnap = await getDb().collection('organizations').doc(orgId).get()
    if (!orgSnap.exists) {
      return res.status(404).json({ ok: false, message: `Organization ${orgId} not found.` })
    }
    const org = orgSnap.data()
    if (org.ownerId !== req.uid && !(org.memberIds ?? []).includes(req.uid)) {
      return res.status(403).json({ ok: false, message: 'Not a member of this organization.' })
    }
    next()
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message })
  }
}

module.exports = { requireOrgOwner, requireOrgMember }
