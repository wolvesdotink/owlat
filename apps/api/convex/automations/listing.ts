import type { ListingDescriptor } from '../lib/listing';

/**
 * Automation listing descriptor. Browse-only, in creation order: the default
 * browse rides `by_deleted_at` (creation-ordered within the live range) and
 * status-filtered browse `by_deleted_at_and_status`, and `byStatus` replaces
 * `countByStatus`. An automation in Recently deleted is in none of them.
 *
 * No per-row enrichment: the list UI renders only the automation's own columns
 * (name/trigger/status/contacts-in-flow/created), so no step scan is warranted.
 */
export const automationListing: ListingDescriptor<'automations'> = {
	table: 'automations',
	browse: {
		index: 'by_deleted_at',
		order: 'asc',
		filterIndexes: { status: 'by_deleted_at_and_status' },
	},
	filters: ['status'],
	softDelete: true,
	facets: {
		byStatus: {
			kind: 'groupBy',
			field: 'status',
			buckets: ['draft', 'active', 'paused'],
			index: 'by_deleted_at_and_status',
			counter: 'automationStatus',
		},
	},
};
