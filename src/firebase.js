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
