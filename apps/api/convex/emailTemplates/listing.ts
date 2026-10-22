import type { ListingDescriptor } from '../lib/listing';

/**
 * Email-template listing descriptor. Replaces the worst offender —
 * the old shell `.collect()`-ed the entire table for every list, filter, and
 * sort. Search routes through `search_templates` (type + status filterFields);
 * type-filtered browse routes through `by_deleted_at_and_type_and_updated_at`;
 * the default browse is updatedAt-ordered. type+status together fall back to a
 * post-index filter on the updatedAt index (an uncommon combination). A
 * template in Recently deleted is in none of them.
 */
export const emailTemplateListing: ListingDescriptor<'emailTemplates'> = {
	table: 'emailTemplates',
	search: {
		index: 'search_templates',
		field: 'searchableText',
		filterFields: ['type', 'status', 'deletedAt'],
	},
	browse: {
		index: 'by_deleted_at_and_updated_at',
		order: 'desc',
		filterIndexes: { type: 'by_deleted_at_and_type_and_updated_at' },
		sortIndexes: { updatedAt: 'by_deleted_at_and_updated_at' },
	},
	sortKeys: ['updatedAt'],
	filters: ['type', 'status'],
	softDelete: true,
	facets: {
		total: { kind: 'indexCount', index: 'by_deleted_at_and_updated_at' },
		byType: {
			kind: 'groupBy',
			field: 'type',
			buckets: ['marketing', 'transactional'],
			index: 'by_deleted_at_and_type_and_updated_at',
			counter: 'templateType',
		},
	},
};
