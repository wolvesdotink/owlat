/**
 * Read on arrival (SPEC §2.4): the gist as stored and as shown.
 *
 *   - `threadBriefs.gist`: the 1–2 verbatim spans of ONE source message, an
 *     optional fact, every quote sealed. One per thread: a gist of an older
 *     message never replaces a newer one's.
 *   - `mailThreads.briefTop.gist`: the spans joined and trimmed to
 *     {@link GIST_TOP_CHARS} on a word boundary, for list rows. Sealed.
 *
 * A full read of the gist's own source supersedes it (`outstanding.ts`
 * discharge); the stale fence hides it (`brief.get`, `openBriefTop`); purge
 * and scope conversion clear it (`arrival/purgeRanges.ts`,
 * `arrival/sharedConversion.ts`).
 *
 * Isolate-safe; not a Convex function.
 */

import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { openMessageBody } from '../../lib/messageBody';
import { loadBriefRow } from './briefRow';

/** The longest list-row gist line, ellipsis included. */
export const GIST_TOP_CHARS = 160;

/** The spans joined and trimmed to {@link GIST_TOP_CHARS} on a word boundary, with an ellipsis. Pure. */
export function gistTopText(spans: readonly { quote: string }[]): string {
	const joined = spans
		.map((s) => s.quote.replace(/\s+/g, ' ').trim())
		.filter((q) => q !== '')
		.join(' … ');
	if (joined.length <= GIST_TOP_CHARS) return joined;
	const cut = joined.slice(0, GIST_TOP_CHARS - 1);
	const space = cut.lastIndexOf(' ');
	return `${(space > GIST_TOP_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Clear the thread's gist when it was read from `sourceKey` (list row included). */
export async function clearGistOf(
	ctx: MutationCtx,
	ref: ThreadRef,
	sourceKey: string
): Promise<void> {
	if (ref.kind !== 'mail') return;
	const brief = await loadBriefRow(ctx, ref);
	if (!brief?.gist || brief.gist.sourceKey !== sourceKey) return;
	await ctx.db.patch(brief._id, { gist: undefined });
	const thread = await ctx.db.get(ref.id);
	if (thread?.briefTop?.gist) {
		const { gist: _dropped, ...rest } = thread.briefTop;
		await ctx.db.patch(ref.id, { briefTop: rest });
	}
}

/** The gist as the reader shows it: unsealed spans and fact, and the message they quote. */
export interface GistView {
	spans: { segmentId: string; quote: string }[];
	fact?: { kind: string; quote: string };
	messageId?: string;
}

/** Unseal a stored gist for `brief.get`. The caller has checked the fence and the mode. */
export async function openGist(
	ctx: Pick<QueryCtx, 'db'>,
	gist: NonNullable<Doc<'threadBriefs'>['gist']>
): Promise<GistView> {
	const source = await ctx.db
		.query('interpretSources')
		.withIndex('by_source_key', (q) => q.eq('sourceKey', gist.sourceKey))
		.first();
	const spans = await Promise.all(
		gist.spans.map(async (s) => ({ segmentId: s.segmentId, quote: await openMessageBody(s.quote) }))
	);
	return {
		spans,
		...(gist.fact
			? { fact: { kind: gist.fact.kind, quote: await openMessageBody(gist.fact.quote) } }
			: {}),
		...(source?.source.kind === 'mail' ? { messageId: source.source.id } : {}),
	};
}
