/**
 * Knowledge entry deduplication, shared by the write and the preflight before
 * embedding (#1335, AI routing plan missed call M4).
 *
 * `knowledge.graph.saveEntry` returns an existing row instead of writing a
 * duplicate (both legs below, in its transaction, so a race between two
 * extractions of one source still ends with one row). The extraction used to
 * embed every entry BEFORE that check and throw the vector away when the
 * entry already existed. {@link findDuplicateEntry} is the same check, asked
 * before the embedding call: the extraction skips the embedding for an entry
 * it finds, and keeps the existing row's id exactly as `saveEntry` would have
 * returned it. The check on write stays.
 *
 * The match never depends on the existing row's vector or embedding space, so
 * a preflight hit returns the row `saveEntry` itself would have returned.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { internalQuery, type QueryCtx } from '../_generated/server';
import { isInboxDerivedKnowledge } from '../inbox/access';
import { sameContactScope } from '../lib/contactScope';
import { sourceTypeValidator } from '../schema/knowledge';

/** What identifies a would-be entry for deduplication. */
export type DedupeCandidate = Pick<
	Doc<'knowledgeEntries'>,
	'sourceType' | 'sourceId' | 'title' | 'contentHash' | 'contactIds' | 'threadId'
>;

/**
 * The existing entry a write of `candidate` would return instead of inserting,
 * or null.
 *
 *   1. Same source, same title: an extraction of one message or file run twice
 *      (a cron retry overlapping the first run).
 *   2. Same normalized content (`contentHash`) under the SAME contact scope and
 *      the same Team-Inbox-derived standing: one fact restated in another
 *      message. A different scope keeps its own row, because folding it would
 *      widen or narrow who can see the fact (`inbox/access.ts`).
 */
export async function findDuplicateEntry(
	ctx: Pick<QueryCtx, 'db'>,
	candidate: DedupeCandidate
): Promise<Id<'knowledgeEntries'> | null> {
	if (candidate.sourceId) {
		const fromSource = await ctx.db
			.query('knowledgeEntries')
			.withIndex('by_source', (q) =>
				q.eq('sourceType', candidate.sourceType).eq('sourceId', candidate.sourceId)
			)
			.collect(); // bounded: entries extracted from a single source (small)
		const dup = fromSource.find((e) => e.title === candidate.title);
		if (dup) return dup._id;
	}
	if (candidate.contentHash) {
		const byHash = await ctx.db
			.query('knowledgeEntries')
			.withIndex('by_content_hash', (q) => q.eq('contentHash', candidate.contentHash))
			.collect(); // bounded: entries sharing one content hash (this dedup keeps it ~1)
		const inboxDerived = isInboxDerivedKnowledge(candidate);
		const dup = byHash.find(
			(e) =>
				sameContactScope(e.contactIds, candidate.contactIds) &&
				isInboxDerivedKnowledge(e) === inboxDerived
		);
		if (dup) return dup._id;
	}
	return null;
}

/** The preflight before embedding (see the module doc). */
export const findExistingEntry = internalQuery({
	args: {
		sourceType: sourceTypeValidator,
		sourceId: v.optional(v.string()),
		title: v.string(),
		contentHash: v.optional(v.string()),
		contactIds: v.optional(v.array(v.id('contacts'))),
		threadId: v.optional(v.id('conversationThreads')),
	},
	handler: (ctx, args): Promise<Id<'knowledgeEntries'> | null> => findDuplicateEntry(ctx, args),
});
