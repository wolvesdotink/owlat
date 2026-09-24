/**
 * PREVIOUS-RELEASE ENTRY POINTS — kept for one release because the previous
 * release reaches them by path during the deploy window: its actions still
 * running when the new functions go live, and scheduler jobs it queued before
 * the deploy (`CONVENTIONS.md`, "Old clients and workers against new
 * functions"). Nothing in this release calls them, which is the point. Each
 * line names why it stays; the next release deletes the entry and its line.
 * `check-entry-wiring.ts` holds it exact in both directions, like its
 * UNREACHED_ENTRIES ledger. Kept in its own file so the release that
 * deletes these entries edits data, not the walk.
 */
export const PREVIOUS_RELEASE_ENTRIES: Readonly<Record<string, string>> = {
	'webhooks/fanout.ts#fanoutEvent': 'fanout jobs queued before the deploy',
	'webhooks/fanout.ts#deliverEvent': 'single-target jobs queued before the deploy',
	'webhooks/deliveryQueries.ts#getWebhooksForEvent': 'old fanout actions mid-run',
	'webhooks/deliveryQueries.ts#getWebhook': 'old fanout/delivery actions mid-run',
	'webhooks/deliveryQueries.ts#createDeliveryLog': 'old fanout actions mid-run',
	'webhooks/deliveryQueries.ts#markDeliverySuccess': 'old delivery actions mid-run',
	'webhooks/deliveryQueries.ts#markDeliveryRetrying': 'old delivery actions mid-run',
	'webhooks/deliveryQueries.ts#markDeliveryFailed': 'old delivery actions mid-run',
};
