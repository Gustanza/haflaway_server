// Billing helpers — ported from functions/utils/globalfns.js's
// resolveBillingAccount plus the balance/userTransactions write pattern used
// throughout functions/ (attendees.js, whatsapp/invitation.js, sms/indesms.js).
const { getDb, admin } = require('../firebase')

// Org-linked events are billed against their organization's shared balance;
// events without an orgId (or whose org lookup fails) fall back to the
// legacy per-user balance on users/{event.authorId}. Confirmed against a
// live event+org doc in this conversation — this is not a hypothetical: an
// event with a real orgId set was previously being billed to the wrong
// account entirely before this existed.
async function resolveBillingAccount(event) {
  const db = getDb()
  if (event.orgId) {
    const orgRef = db.collection('organizations').doc(event.orgId)
    const orgSnap = await orgRef.get()
    if (orgSnap.exists) {
      return { ref: orgRef, balance: orgSnap.data().balance ?? 0, kind: 'org', id: event.orgId }
    }
  }
  const userRef = db.collection('users').doc(event.authorId)
  const userSnap = await userRef.get()
  return { ref: userRef, balance: userSnap.data()?.balance ?? 0, kind: 'user', id: event.authorId }
}

// Runs inside a transaction so a balance check + deduction can never race
// with a concurrent charge on the same billing account. `billing` is the
// object resolveBillingAccount() returns; `authorId` is always the event's
// own author (kept on the transaction record for audit even when the
// balance itself is billed to an org), matching the live transaction shape.
async function chargeBilling({ billing, authorId, eventId, attendeeId, amount, reason, extraParams = {} }) {
  const db = getDb()
  const txnRef = db.collection('userTransactions').doc()
  await db.runTransaction(async (trn) => {
    const snap = await trn.get(billing.ref)
    const balance = snap.data()?.balance
    if (typeof balance !== 'number') throw new Error(`${billing.kind} ${billing.id} has no balance set.`)
    if (balance < amount) throw new Error('Insufficient balance.')
    trn.update(billing.ref, { balance: admin.firestore.FieldValue.increment(-amount) })
    trn.set(txnRef, {
      authorId,
      eventId,
      billedTo: { kind: billing.kind, id: billing.id },
      amount: -amount,
      createdAt: new Date().toISOString(),
      params: { attendeeId, ...extraParams },
      reason,
    })
  })
}

module.exports = { resolveBillingAccount, chargeBilling }
