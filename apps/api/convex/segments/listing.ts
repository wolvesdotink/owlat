import type { ListingDescriptor } from '../lib/listing';

/**
 * Segment listing descriptor (ADR-0037). Browse-only, no enrichment — segments
 * is an intrinsically small table, so the page is plain creation-ordered rows.
 * The `total` facet replaces the old whole-table `.collect()`.
 */
export const segmentListing: ListingDescriptor<'segments'> = {
	table: 'segments',
	browse: { index: 'by_creation_time', order: 'asc' },
	facets: {
		total: { kind: 'indexCount' },
	},
};
