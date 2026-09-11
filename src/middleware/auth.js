const { getAdmin } = require('../firebase')

// Verifies a real Firebase ID token (Authorization: Bearer <idToken>) via the
// Admin SDK — deliberately NOT the existing Cloud Functions' "Bearer <raw
// uid>" pattern, which anyone could forge by just knowing/guessing a uid.
// Attaches the verified uid to req.uid for handlers to use.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const idToken = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null
  if (!idToken) {
    return res.status(401).json({ ok: false, message: 'Missing Authorization: Bearer <idToken> header.' })
  }

  try {
    const decoded = await getAdmin().auth().verifyIdToken(idToken)
    req.uid = decoded.uid
    next()
  } catch (e) {
    res.status(401).json({ ok: false, message: `Invalid or expired ID token: ${e.message}` })
  }
}

module.exports = { requireAuth }
