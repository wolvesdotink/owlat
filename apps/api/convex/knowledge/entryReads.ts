/**
 * The handlers of the knowledge-entry reads registered in `knowledge/graph.ts`
 * that do not follow a relation: the soft-auth dashboard lists and searches,
 * and the hydration and full-text legs of hybrid retrieval. The registrations
 * stay in `graph.ts`, so callers keep the `knowledge.graph.*` paths.
 */

import { v, type ObjectType } from 'convex/values';
import type { QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import {
	isKnowledgeEntryVisible,
	pageLimit,
	resolveKnowledgeViewer,
	takeVisibleEntries,
} from './visibility';
import { batchGet } from '../_utils/batchLoader';
import { entryTypeValidator } from '../schema/knowledge';

/** The args of `knowledge.graph.search`. */
export const searchArgs = {
	searchQuery: v.string(),
	entryType: v.optional(entryTypeValidator),
	limit: v.optional(v.number()),
};

/** `knowledge.graph.search`: full-text search over the entries the caller may see. */
export async function searchHandler(ctx: QueryCtx, args: ObjectType<typeof searchArgs>) {
	const viewer = await resolveKnowledgeViewer(ctx);
	if (!viewer) return [];

	const limit = pageLimit(args.limit, 25);

	const searchQuery = ctx.db.query('knowledgeEntries').withSearchIndex('search_knowledge', (q) => {
		let sq = q.search('searchableText', args.searchQuery);
		if (args.entryType) {
			sq = sq.eq('entryType', args.entryType);
		}
		return sq;
	});

	return await takeVisibleEntries(searchQuery, viewer.canReadInbox, limit);
}

/** The args of `knowledge.graph.listByType`. */
export const listByTypeArgs = {
	entryType: entryTypeValidator,
	limit: v.optional(v.number()),
};

/** `knowledge.graph.listByType`: the newest visible entries of one type. */
export async function listByTypeHandler(ctx: QueryCtx, args: ObjectType<typeof listByTypeArgs>) {
	const viewer = await resolveKnowledgeViewer(ctx);
	if (!viewer) return [];

	const rows = ctx.db
		.query('knowledgeEntries')
		.withIndex('by_entry_type', (q) => q.eq('entryType', args.entryType))
		.order('desc');
	return await takeVisibleEntries(rows, viewer.canReadInbox, pageLimit(args.limit, 50));
}

/** The args of `knowledge.graph.listAll`. */
export const listAllArgs = {
	limit: v.optional(v.number()),
};

/** `knowledge.graph.listAll`: the newest visible entries of every type. */
export async function listAllHandler(ctx: QueryCtx, args: ObjectType<typeof listAllArgs>) {
	const viewer = await resolveKnowledgeViewer(ctx);
	if (!viewer) return [];

	const rows = ctx.db.query('knowledgeEntries').withIndex('by_created_at').order('desc');
	return await takeVisibleEntries(rows, viewer.canReadInbox, pageLimit(args.limit, 50));
}

/** The args of `knowledge.graph.getByContact`. */
export const getByContactArgs = {
	contactId: v.id('contacts'),
	limit: v.optional(v.number()),
};

/** `knowledge.graph.getByContact`: the visible, unexpired entries linked to a contact. */
export async function getByContactHandler(
	ctx: QueryCtx,
	args: ObjectType<typeof getByContactArgs>
) {
	const viewer = await resolveKnowledgeViewer(ctx);
	if (!viewer) return [];

	const limit = pageLimit(args.limit, 20);
	const now = Date.now();

	// Query the index-able `knowledgeEntryContacts` mirror by contact, then
	// hydrate the entries. Complete (no 500-row truncation) and O(matches),
	// not a scan of the newest 500 entries filtered in JS.
	const links = await ctx.db
		.query('knowledgeEntryContacts')
		.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
		.collect(); // bounded: junction rows for one contact (knowledge per person)

	const entryMap = await batchGet(
		ctx,
		links.map((link) => link.entryId)
	);

	return [...entryMap.values()]
		.filter(
			(e): e is Doc<'knowledgeEntries'> =>
				e !== null &&
				!(e.expiresAt !== undefined && e.expiresAt < now) &&
				isKnowledgeEntryVisible(viewer.canReadInbox, e)
		)
		.sort((a, b) => b.createdAt - a.createdAt)
		.slice(0, limit);
}

/** The args of `knowledge.graph.getByIds`. */
export const getByIdsArgs = {
	ids: v.array(v.id('knowledgeEntries')),
};

/** `knowledge.graph.getByIds`: the entries for a list of ids, in input order. */
export async function getByIdsHandler(ctx: QueryCtx, args: ObjectType<typeof getByIdsArgs>) {
	// Independent ids: one deduplicated, parallel read.
	const byId = await batchGet(ctx, args.ids);
	const out: Doc<'knowledgeEntries'>[] = [];
	for (const id of args.ids) {
		const entry = byId.get(id);
		if (entry) out.push(entry);
	}
	return out;
}

/** The args of `knowledge.graph.ftsRankedIds`. */
export const ftsRankedIdsArgs = {
	queryText: v.string(),
	entryType: v.optional(entryTypeValidator),
	limit: v.number(),
};

/** `knowledge.graph.ftsRankedIds`: entry ids matching a text, in relevance order. */
export async function ftsRankedIdsHandler(
	ctx: QueryCtx,
	args: ObjectType<typeof ftsRankedIdsArgs>
): Promise<Id<'knowledgeEntries'>[]> {
	const rows = await ctx.db
		.query('knowledgeEntries')
		.withSearchIndex('search_knowledge', (q) => {
			const sq = q.search('searchableText', args.queryText);
			return args.entryType ? sq.eq('entryType', args.entryType) : sq;
		})
		.take(args.limit);
	return rows.map((r) => r._id);
}
