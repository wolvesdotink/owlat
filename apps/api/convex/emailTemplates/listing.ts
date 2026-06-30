import type { ListingDescriptor } from '../lib/listing';

/**
 * Email-template listing descriptor (ADR-0037). Replaces the worst offender —
 * the old shell `.collect()`-ed the entire table for every list, filter, and
 * sort. Search routes through `search_templates` (type + status filterFields);
 * type-filtered browse routes through `by_type_and_updated_at`; the default
 * browse is updatedAt-ordered. type+status together fall back to a post-index
 * filter on the updatedAt index (an uncommon combination).
 */
export const emailTemplateListing: ListingDescriptor<'emailTemplates'> = {
	table: 'emailTemplates',
	search: {
		index: 'search_templates',
		field: 'searchableText',
		filterFields: ['type', 'status'],
	},
	browse: {
		index: 'by_updated_at',
		order: 'desc',
		filterIndexes: { type: 'by_type_and_updated_at' },
		sortIndexes: { updatedAt: 'by_updated_at' },
	},
	sortKeys: ['updatedAt'],
	filters: ['type', 'status'],
	facets: {
		total: { kind: 'indexCount', index: 'by_updated_at' },
		byType: {
			kind: 'groupBy',
			field: 'type',
			buckets: ['marketing', 'transactional'],
			index: 'by_type',
		},
	},
};
