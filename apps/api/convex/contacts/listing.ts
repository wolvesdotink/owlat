import type { ListingDescriptor } from '../lib/listing';

/**
 * Contact listing descriptor (ADR-0037). The cleanest case: the
 * `search_contacts` index already exists, so search is genuinely multi-page via
 * a real Convex cursor (the `'search'` sentinel dies), soft-delete rides the
 * index on both paths, and the total is the denormalized `instanceSettings`
 * counter.
 */
export const contactListing: ListingDescriptor<'contacts'> = {
	table: 'contacts',
	search: { index: 'search_contacts', field: 'searchableText', filterFields: ['deletedAt'] },
	// The default browse index is already createdAt-ordered, so `createdAt` is a
	// legal `sort` arg with no `sortIndexes` swap needed; the page's `order` arg
	// flips asc/desc on it. Email/name have no soft-delete-leading index, so they
	// are deliberately not server-sortable (a post-filter would thin pages).
	browse: { index: 'by_deleted_at_and_created_at', order: 'desc' },
	sortKeys: ['createdAt'],
	softDelete: true,
	facets: {
		total: { kind: 'cachedCounter', table: 'instanceSettings', field: 'contactCount' },
	},
};
