// Card-creation and message-dispatch pricing/quota lookups.
const { getDb } = require('../firebase')

// save_the_date/thank_you/enclosure have no render-cost tier of their own —
// treated as invitation-tier extras, same per-card cost as the primary
// invitation card (confirmed choice — no separate pricing key exists for them).
const RENDER_COST_KEY_BY_PURPOSE = {
  invitation: 'invitationCard',
  save_the_date: 'invitationCard',
  thank_you: 'invitationCard',
  enclosure: 'invitationCard',
  contribution: 'contributionCard',
  contact: 'contributionNoCard',
}

// Dispatch quota — ported from functions/whatsapp/invitation.js's and
// functions/sms/indesms.js's CAMPAIGN_QUOTA_KEY_MAP (identical in both,
// confirmed against origin/messaging). Only these five fixed lifecycle
// campaign ids get a free-dispatch allowance at all. Any other campaignType —
// which includes every card-send campaign this server's own Send-a-Card flow
// creates, since those are always random Firestore doc ids — is a "custom"
// campaign and gets ZERO free quota: always charged, no exceptions. This
// isn't a simplification of the real system, it IS the real system —
// confirmed against a live attendee doc already carrying counter fields in
// exactly this shape.
const CAMPAIGN_QUOTA_KEY_MAP = {
  'haflaway-invitation-campaign': 'invitationCardDispatch',
  'haflaway-invitation-reminder-campaign': 'invitationCardReminder',
  'haflaway-contribution-campaign': 'contributionCardDispatch',
  'haflaway-save-the-date-campaign': 'saveTheDateCardDispatch',
  'haflaway-invitation-gratitude-campaign': 'invitationCardGratitudeDispatch',
}

function quotaKeyForCampaignType(campaignType) {
  return CAMPAIGN_QUOTA_KEY_MAP[campaignType] ?? null
}

async function getEventPlan(event) {
  if (!event?.eventPlanId) throw new Error('Event has no eventPlanId set.')
  const db = getDb()
  const planSnap = await db.collection('eventPlans').doc(event.eventPlanId).get()
  if (!planSnap.exists) throw new Error(`eventPlan ${event.eventPlanId} not found.`)
  return planSnap.data()
}

function renderCostForPurpose(eventPlan, purpose) {
  const key = RENDER_COST_KEY_BY_PURPOSE[purpose]
  const cost = key ? eventPlan.pricing?.[key] : undefined
  if (cost === undefined || cost === null) {
    throw new Error(`No pricing.${key ?? purpose} set on this event's plan.`)
  }
  return cost
}

// Channel-scoped per-campaign quota, read from eventPlan.messagingQuota —
// only meaningful for the five fixed campaign ids above; callers should
// treat a custom campaign (quotaKey === null) as always-charged rather than
// calling this at all.
function quotaForCampaign(eventPlan, channel, quotaKey) {
  const channelKey = channel === 'whatsapp' ? 'whatsApp' : 'sms'
  const quota = eventPlan.messagingQuota?.[channelKey]?.[quotaKey]
  if (quota === undefined || quota === null) {
    throw new Error(`No messagingQuota.${channelKey}.${quotaKey} set on this event's plan.`)
  }
  return quota
}

function baseDispatchCost(eventPlan, channel) {
  const key = channel === 'whatsapp' ? 'baseWhatsAppMessage' : 'baseSMS'
  const cost = eventPlan.pricing?.[key]
  if (cost === undefined || cost === null) throw new Error(`No pricing.${key} set on this event's plan.`)
  return cost
}

// How many re-renders of the SAME (attendee, purpose) card are free before
// charging the full render cost again — covers an organizer fixing a typo'd
// name/party-type/label and re-sending, not a brand-new card. Unlike every
// other lookup in this file, this one DEFAULTS instead of throwing when
// unset: it's a new, optional knob, and every eventPlan that predates this
// feature must keep working exactly as it did before (one free correction)
// rather than breaking outright on a missing key.
function freeCorrectionsAllowed(eventPlan) {
  const n = eventPlan.pricing?.freeCardCorrections
  return typeof n === 'number' && n >= 0 ? n : 1
}

module.exports = {
  quotaKeyForCampaignType,
  getEventPlan,
  renderCostForPurpose,
  quotaForCampaign,
  baseDispatchCost,
  freeCorrectionsAllowed,
}
