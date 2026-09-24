// The fixed message-purpose taxonomy WhatsApp campaigns send through (mirrors
// EventMessages.vue's CAMPAIGN_TEMPLATE_CATEGORIES). Pulled out of
// routes/campaigns.js into its own module so organizations/twilioCredentials.js
// can validate against the same category list without campaigns.js and the
// organizations module ending up importing each other.
const WHATSAPP_TEMPLATE_CATEGORY_BY_PURPOSE = {
  invitation: 'whatsapp-wedding-invitations',
  save_the_date: 'whatsapp-wedding-save-the-date',
  thank_you: 'whatsapp-wedding-thank-you',
  enclosure: 'whatsapp-wedding-enclosure',
}

const WHATSAPP_TEMPLATE_CATEGORIES = Object.values(WHATSAPP_TEMPLATE_CATEGORY_BY_PURPOSE)

// Card-less Bulk Messages sends (General / RSVP / Pledge / Meeting reminders,
// custom campaigns) — the organizer's own text rides in variable 8. Same key
// as the shared library's GENERAL_CAMPAIGN_CATEGORY in EventCampaigns.vue.
const GENERAL_WHATSAPP_TEMPLATE_CATEGORY = 'haflaway-general-campaign'

// Everything an org can register its own template for: every card purpose,
// plus the general category for card-less sends.
const ORG_WHATSAPP_TEMPLATE_CATEGORIES = [...WHATSAPP_TEMPLATE_CATEGORIES, GENERAL_WHATSAPP_TEMPLATE_CATEGORY]

module.exports = {
  WHATSAPP_TEMPLATE_CATEGORY_BY_PURPOSE,
  WHATSAPP_TEMPLATE_CATEGORIES,
  GENERAL_WHATSAPP_TEMPLATE_CATEGORY,
  ORG_WHATSAPP_TEMPLATE_CATEGORIES,
}
