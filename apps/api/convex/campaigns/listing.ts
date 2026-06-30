import type { ListingDescriptor } from '../lib/listing';
import { CAMPAIGN_STATUSES } from '../lib/convexValidators';

/**
 * Campaign listing descriptor (ADR-0037). Search routes through
 * `search_campaigns` (status is a filterField); status-filtered browse routes
 * through the `by_status_and_updated_at` compound index, index-native and
 * updatedAt-ordered. The count zoo collapses into two facets.
 */
export const campaignListing: ListingDescriptor<'campaigns'> = {
	table: 'campaigns',
	search: { index: 'search_campaigns', field: 'searchableText', filterFields: ['status'] },
	browse: {
		index: 'by_updated_at',
		order: 'desc',
		filterIndexes: { status: 'by_status_and_updated_at' },
		sortIndexes: { updatedAt: 'by_updated_at' },
	},
	sortKeys: ['updatedAt'],
	filters: ['status'],
	facets: {
		total: { kind: 'indexCount', index: 'by_updated_at' },
		byStatus: { kind: 'groupBy', field: 'status', buckets: CAMPAIGN_STATUSES, index: 'by_status' },
	},
};
