require('dotenv').config()
const path = require('path')
const admin = require('firebase-admin')

// Lazy on purpose — a missing/bad service account key shouldn't take down the
// whole process (and block the plain /health liveness check with it). It only
// throws once something actually tries to touch Firestore/Storage.
function getAdmin() {
  if (!admin.apps.length) {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    if (!credPath) {
      throw new Error(
        'GOOGLE_APPLICATION_CREDENTIALS is not set. Copy .env.example to .env and point it at your ' +
        'Firebase service account key JSON file — see README.md.'
      )
    }

    const serviceAccount = require(path.resolve(credPath))

    // Bucket auto-detection only works inside GCP's own runtime (Cloud
    // Functions, Cloud Run, GCE) via its metadata server — a service-account
    // -authenticated app running on a plain VPS has no such implicit source
    // and genuinely needs this set. Confirmed against a real already-rendered
    // card URL in Firestore (produced by the proven Cloud Function upload
    // path): the actual bucket is `haflaway-f14aa.firebasestorage.app`, the
    // newer Firebase Storage domain — NOT `haflaway-f14aa.appspot.com`,
    // which an earlier guess here wrongly used and broke every upload with
    // "The specified bucket does not exist." Verify this against real data
    // again (search a `cards.*.url` field in Firestore) before ever changing
    // it, rather than guessing.
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    })
  }
  return admin
}

function getDb() {
  return getAdmin().firestore()
}

function getBucket() {
  return getAdmin().storage().bucket()
}

module.exports = { admin, getAdmin, getDb, getBucket }
