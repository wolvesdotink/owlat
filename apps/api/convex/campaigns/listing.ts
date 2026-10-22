import type { ListingDescriptor } from '../lib/listing';
import { CAMPAIGN_STATUSES } from '../lib/convexValidators';

/**
 * Campaign listing descriptor. Search routes through
 * `search_campaigns` (status is a filterField); status-filtered browse routes
 * through the `by_deleted_at_and_status_and_updated_at` compound index,
 * index-native and updatedAt-ordered. The count zoo collapses into two facets.
 * A campaign in Recently deleted is in none of them: `softDelete` pins
 * `deletedAt === undefined` inside every index range and search.
 */
export const campaignListing: ListingDescriptor<'campaigns'> = {
	table: 'campaigns',
	search: {
		index: 'search_campaigns',
		field: 'searchableText',
		filterFields: ['status', 'deletedAt'],
	},
	browse: {
		index: 'by_deleted_at_and_updated_at',
		order: 'desc',
		filterIndexes: { status: 'by_deleted_at_and_status_and_updated_at' },
		sortIndexes: { updatedAt: 'by_deleted_at_and_updated_at' },
	},
	sortKeys: ['updatedAt'],
	filters: ['status'],
	softDelete: true,
	facets: {
		total: { kind: 'indexCount', index: 'by_deleted_at_and_updated_at' },
		byStatus: {
			kind: 'groupBy',
			field: 'status',
			buckets: CAMPAIGN_STATUSES,
			index: 'by_deleted_at_and_status_and_updated_at',
			counter: 'campaignStatus',
		},
	},
};
