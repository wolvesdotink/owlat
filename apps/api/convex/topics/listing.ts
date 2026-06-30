import type { ListingDescriptor } from '../lib/listing';
import { countWithPagination } from '../lib/pagination';

/**
 * Topic listing descriptor (ADR-0037). Browse-only (no search index on topics).
 * The `contactCount` enrichment is declared once here and shared by the
 * entity's `list` and `get`, so the two stop duplicating it.
 *
 * Enrichment cost: O(1) when the denormalized `cachedMemberCount` is present;
 * a bounded membership scan only when it is absent (the reconcile cron keeps it
 * warm). Stated on the descriptor, never hidden by the engine.
 */
export const topicListing: ListingDescriptor<'topics', { contactCount: number }> = {
	table: 'topics',
	browse: { index: 'by_creation_time', order: 'asc' },
	enrich: async (db, topic) => ({
		contactCount:
			topic.cachedMemberCount ??
			(await countWithPagination(db, 'contactTopics', 'by_topic', (q) =>
				q.eq('topicId', topic._id),
			)),
	}),
	facets: {
		total: { kind: 'indexCount' },
	},
};
