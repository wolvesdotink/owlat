/**
 * Knowledge entry deduplication, shared by the write and the preflight before
 * embedding.
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
 *
 * Who may see the entry (`memberAccess`, inbox/access.ts) is resolved HERE,
 * from the source file, never taken from the writer: a writer from a previous
 * release, still running through a deploy, knows nothing of it. The same
 * answer decides the content-hash leg and what `saveEntry` stores.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { isMailCapture } from '../lib/semanticFileAccess';
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
 * The `memberAccess` every write of this release stamps (schema/knowledge.ts).
 * For a file, `members` only when the file exists and is not a mail capture
 * (lib/semanticFileAccess.ts), else `restricted`, so knowledge from a file
 * deleted mid-extraction fails closed. For any other source, `restricted` when
 * its source keeps it from members (Team Inbox mail, a Team Inbox thread
 * link), else `members`. Never undefined: an unstamped row is one written
 * before this release, which the dedup leaves alone until migration 0069 has
 * restricted it (knowledge/maintenance.ts).
 */
export async function resolveMemberAccess(
	ctx: Pick<QueryCtx, 'db'>,
	source: Pick<Doc<'knowledgeEntries'>, 'sourceType' | 'sourceId' | 'threadId'>
): Promise<'members' | 'restricted'> {
	if (source.sourceType !== 'file') {
		return isInboxDerivedKnowledge(source) ? 'restricted' : 'members';
	}
	const fileId = source.sourceId ? ctx.db.normalizeId('semanticFiles', source.sourceId) : null;
	const file = fileId ? await ctx.db.get(fileId) : null;
	return file && !isMailCapture(file) ? 'members' : 'restricted';
}

/**
 * The existing entry a write of `candidate` would return instead of inserting,
 * or null. `memberAccess` is the resolved one (see {@link resolveMemberAccess}).
 *
 * A same-source match that members may see while the candidate is restricted
 * is returned with `needsRestriction`: `saveEntry` restricts it instead of
 * handing back a member-visible row for private content.
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
	candidate: DedupeCandidate & Pick<Doc<'knowledgeEntries'>, 'memberAccess'>
): Promise<{ id: Id<'knowledgeEntries'>; needsRestriction: boolean } | null> {
	const inboxDerived = isInboxDerivedKnowledge(candidate);
	if (candidate.sourceId) {
		const fromSource = await ctx.db
			.query('knowledgeEntries')
			.withIndex('by_source', (q) =>
				q.eq('sourceType', candidate.sourceType).eq('sourceId', candidate.sourceId)
			)
			.collect(); // bounded: entries extracted from a single source (small)
		const dup = fromSource.find((e) => e.title === candidate.title);
		if (dup)
			return { id: dup._id, needsRestriction: inboxDerived && !isInboxDerivedKnowledge(dup) };
	}
	if (candidate.contentHash) {
		const byHash = await ctx.db
			.query('knowledgeEntries')
			.withIndex('by_content_hash', (q) => q.eq('contentHash', candidate.contentHash))
			.collect(); // bounded: entries sharing one content hash (this dedup keeps it ~1)
		const dup = byHash.find(
			(e) =>
				sameContactScope(e.contactIds, candidate.contactIds) &&
				isInboxDerivedKnowledge(e) === inboxDerived
		);
		if (dup) return { id: dup._id, needsRestriction: false };
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
	handler: async (ctx, args): Promise<Id<'knowledgeEntries'> | null> => {
		const memberAccess = await resolveMemberAccess(ctx, args);
		const dup = await findDuplicateEntry(ctx, { ...args, memberAccess });
		// A row to restrict is left to `saveEntry`, which writes.
		return dup && !dup.needsRestriction ? dup.id : null;
	},
});
