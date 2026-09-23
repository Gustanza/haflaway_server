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

module.exports = { WHATSAPP_TEMPLATE_CATEGORY_BY_PURPOSE, WHATSAPP_TEMPLATE_CATEGORIES }
