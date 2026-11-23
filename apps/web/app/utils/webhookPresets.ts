/**
 * The webhook the Deliverability Center's "Add alert webhook" opens the form
 * for: both deliverability alert events and nothing else, so the operator's
 * on-call endpoint is not flooded with email events.
 *
 * Its own module, not `useWebhookForm`, so the Deliverability Center can link
 * to the preset without loading the webhook form and its event catalog.
 */
export const DELIVERABILITY_ALERT_WEBHOOK_PRESET = 'deliverability-alerts';
