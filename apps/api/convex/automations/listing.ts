import type { ListingDescriptor } from '../lib/listing';

/**
 * Automation listing descriptor (ADR-0037). Browse-only; status-filtered browse
 * routes through the existing `by_status` index (creation-ordered within the
 * status), and `byStatus` replaces `countByStatus`.
 *
 * No per-row enrichment: the list UI renders only the automation's own columns
 * (name/trigger/status/contacts-in-flow/created), so no step scan is warranted.
 */
export const automationListing: ListingDescriptor<'automations'> = {
	table: 'automations',
	browse: {
		index: 'by_creation_time',
		order: 'asc',
		filterIndexes: { status: 'by_status' },
	},
	filters: ['status'],
	facets: {
		byStatus: {
			kind: 'groupBy',
			field: 'status',
			buckets: ['draft', 'active', 'paused'],
			index: 'by_status',
		},
	},
};
