const { getDb } = require('../firebase')

// Haflaway staff gate for admin-console routes — mirrors
// haflaway_admin_spa/src/utils/adminAccess.js (sectionsFor/canAccess), which
// is only a UI gate: Firestore rules are currently wide open, so this check
// is the real one for anything routed through here.
//
//   1. Super admins — fixed email allowlist, matched against the ID token's
//      *verified* email only (req.email, see middleware/auth.js).
//   2. Everyone else needs users/{uid}.clearanceLevel >= 5 AND the section
//      key in users/{uid}.adminSections (default-deny, same as the console).
const SUPER_ADMIN_EMAILS = ['haflaway@gmail.com', 'projectcogneto@gmail.com']
const STAFF_CLEARANCE_LEVEL = 5

function requireStaffSection(sectionKey) {
  return async function requireStaff(req, res, next) {
    try {
      const snap = await getDb().collection('users').doc(req.uid).get()
      const user = snap.exists ? snap.data() : {}
      const isSuperAdmin = !!req.email && SUPER_ADMIN_EMAILS.includes(req.email)
      const allowed = isSuperAdmin || (
        (Number(user.clearanceLevel) || 0) >= STAFF_CLEARANCE_LEVEL &&
        Array.isArray(user.adminSections) && user.adminSections.includes(sectionKey)
      )
      if (!allowed) {
        return res.status(403).json({ ok: false, message: 'You are not allowed to change this.' })
      }
      req.staff = {
        uid: req.uid,
        email: req.email ?? user.email ?? null,
        name: [user.firstName, user.lastName].filter(Boolean).join(' ') || null,
      }
      next()
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message })
    }
  }
}

module.exports = { requireStaffSection, SUPER_ADMIN_EMAILS }
