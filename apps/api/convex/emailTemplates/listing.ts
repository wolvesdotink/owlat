import type { ListingDescriptor } from '../lib/listing';

/**
 * Email-template listing descriptor. Search routes through `search_templates`
 * (type + status filterFields) and is relevance-ordered, so it takes no sort.
 * Browse has one index per sort (`updatedAt`, `createdAt`, `name`), each with a
 * type-filtered twin, so every sort pages in order on the server and the
 * cursor follows the sort. type+status together fall back to a post-index
 * filter on the sort's index (an uncommon combination). A template in Recently
 * deleted is in none of them.
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
		sortIndexes: {
			updatedAt: 'by_deleted_at_and_updated_at',
			createdAt: 'by_deleted_at_and_created_at',
			name: 'by_deleted_at_and_name_sort_key',
		},
		filterSortIndexes: {
			type: {
				updatedAt: 'by_deleted_at_and_type_and_updated_at',
				createdAt: 'by_deleted_at_and_type_and_created_at',
				name: 'by_deleted_at_and_type_and_name_sort_key',
			},
		},
	},
	sortKeys: ['updatedAt', 'createdAt', 'name'],
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

/**
 * What the name sort orders by: the name lowercased, with accents dropped, so
 * "apple" sorts before "Zebra" and "Émile" beside "Emile". A Convex index
 * compares strings by code point, which would put every capital first.
 */
export function templateNameSortKey(name: string): string {
	return name.trim().normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}
