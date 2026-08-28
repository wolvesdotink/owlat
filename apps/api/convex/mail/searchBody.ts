/**
 * `mailMessages.searchBody` — the deep body excerpt behind full-text search
 * (idea 32), and the instance switch that decides whether it exists at all.
 *
 * WHY. `snippet` is the first 200 characters of a message, and until this field
 * it was the ONLY indexed body text. A phrase at character 1,400 of a contract
 * was unfindable, silently: the search returned "no results" for text the
 * instance was holding. `searchBody` is a normalized excerpt of the same body,
 * capped at {@link SEARCH_BODY_MAX_CHARS}, written at delivery and indexed by
 * the `search_message_bodies` search index.
 *
 * WHY IT IS OPTIONAL, AND OPT-IN. Message bodies are sealed at rest with the
 * instance data key (`lib/atRestBodies.ts`); Convex indexes the PLAINTEXT of a
 * `searchField`, so anything indexable is a plaintext carve-out. `snippet` is
 * the carve-out that already existed. This widens it from 200 characters to
 * ~8KB, which is a real change in what a database dump reveals — so it is
 * OFF unless an operator turns it on, and turning it off again does not just
 * stop writing: it schedules a sweep that CLEARS every excerpt already stored
 * (`bodySearchBackfill.purgeSearchBodies`). Absent column ⇒ exactly the
 * pre-idea-32 behaviour. See docs/adr/0059-widened-body-search-carve-out.md.
 *
 * TWO INDEXES, NOT ONE. `search_messages` (on `snippet`) stays. A single index
 * repointed at `searchBody` would make every message delivered before the field
 * existed vanish from search until a backfill finished — a silent regression
 * dressed up as an empty result, which is the exact failure this idea exists to
 * remove. Instead the read path picks the body index only once BOTH the switch
 * is on AND this mailbox's backfill has completed, the same completeness gate
 * `filename:` uses for the attachment index.
 */

import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';

/**
 * Excerpt ceiling, in characters. ~8KB of UTF-16 text: deep enough that the
 * clause in section 8.2 of a contract is findable, bounded enough that the
 * plaintext carve-out stays an EXCERPT rather than "the body, again". The plan
 * names 4-16KB; 8KB is the middle of that band.
 */
export const SEARCH_BODY_MAX_CHARS = 8000;

/** Minimal entities an HTML→text pass has to resolve for the tokens to be right
 * (`AT&amp;T` must index as `AT&T`, not as `AT`, `amp` and `T`). Deliberately
 * short: this is a search excerpt, not a renderer. */
const ENTITIES: Record<string, string> = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&#39;': "'",
	'&apos;': "'",
	'&nbsp;': ' ',
};

function htmlToSearchText(html: string): string {
	return html
		.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

/**
 * Build the indexable excerpt for one message.
 *
 * Prefers the plain-text part and falls back to a tag-stripped HTML part.
 * Unlike {@link buildSnippet} (which stops at the text part even when it is
 * blank — a quirk its callers depend on for the preview line) a BLANK text part
 * falls through to the HTML here: an html-only message is exactly the kind of
 * mail whose depth this field exists to reach, and an empty excerpt would make
 * it permanently unfindable.
 *
 * Whitespace is collapsed in both branches. The search index tokenizes anyway,
 * so runs of newlines and indentation are pure budget: collapsing them buys
 * real words inside the same {@link SEARCH_BODY_MAX_CHARS} ceiling.
 *
 * Truncation backs up to the last word boundary when one is near the cut, so
 * the final token is a word the message actually contains rather than a prefix
 * that matches nothing.
 */
export function buildSearchBody(text: string | undefined, html: string | undefined): string {
	const fromText = text?.replace(/\s+/g, ' ').trim() ?? '';
	const source = fromText || (html ? htmlToSearchText(html).replace(/\s+/g, ' ').trim() : '');
	if (source.length <= SEARCH_BODY_MAX_CHARS) return source;
	const cut = source.slice(0, SEARCH_BODY_MAX_CHARS);
	const lastSpace = cut.lastIndexOf(' ');
	// Only honour the boundary when it is not a drastic loss; a body with no
	// spaces at all (a base64 blob, some CJK text) keeps the hard cut.
	return lastSpace > SEARCH_BODY_MAX_CHARS - 64 ? cut.slice(0, lastSpace) : cut;
}

/** Both gates are pure reads, so a query context and a mutation context both fit. */
type SearchBodyReaderCtx = QueryCtx | MutationCtx;

/**
 * Is deep body indexing turned on for this instance? Absent ⇒ NO — the
 * carve-out is opt-in, so an instance that has never visited the setting keeps
 * the 200-character snippet behaviour it shipped with.
 */
export async function isBodySearchIndexingEnabled(ctx: SearchBodyReaderCtx): Promise<boolean> {
	const settings = await ctx.db.query('instanceSettings').first();
	return settings?.isBodySearchIndexingEnabled === true;
}

/**
 * Has this mailbox's excerpt backfill finished? Until it has, the body index is
 * a partial view (only mail delivered since the switch was flipped), and
 * searching it would return LESS than the snippet index it replaced.
 */
export async function isBodySearchIndexComplete(
	ctx: SearchBodyReaderCtx,
	mailboxId: Id<'mailboxes'>
): Promise<boolean> {
	const job = await ctx.db
		.query('mailBodySearchBackfillJobs')
		.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
		.first();
	return job?.status === 'completed' && job?.mode === 'index';
}

/** Which search index a free-text query for this mailbox should read. */
export type BodySearchMode = 'body' | 'snippet';

/**
 * Resolve the index for one mailbox. `'body'` needs BOTH the instance switch
 * and a completed backfill; anything else is `'snippet'`, which is what search
 * has always done.
 */
export async function resolveBodySearchMode(
	ctx: SearchBodyReaderCtx,
	mailboxId: Id<'mailboxes'>
): Promise<BodySearchMode> {
	if (!(await isBodySearchIndexingEnabled(ctx))) return 'snippet';
	return (await isBodySearchIndexComplete(ctx, mailboxId)) ? 'body' : 'snippet';
}

/** The narrowing both search indexes can express. `from` is deliberately absent:
 * the grammar's `from:` is a partial token, not a full address, so it cannot use
 * an exact `.eq('fromAddress')` and stays a post-filter at the call site. */
export interface TextSearchNarrowing {
	mailboxId: Id<'mailboxes'>;
	text: string;
	folderId?: Id<'mailFolders'>;
	flagSeen?: boolean;
	flagFlagged?: boolean;
}

/** The `.eq()` chain both search indexes share, structurally. */
interface SearchFilterable<Self> {
	eq(fieldName: 'folderId', value: Id<'mailFolders'>): Self;
	eq(fieldName: 'flagSeen' | 'flagFlagged', value: boolean): Self;
}

/**
 * The indexed free-text read, over whichever plaintext this mailbox may search.
 *
 * The two indexes carry IDENTICAL filter fields, so the only difference is which
 * column the words are matched against — which is why the filter chain is
 * written once here rather than duplicated per call site. The `mode` is the
 * CALLER'S, resolved by {@link resolveBodySearchMode}, so the read path can
 * never accidentally pick the deeper index for a mailbox whose excerpts do not
 * exist yet.
 */
export function textSearchQuery(
	ctx: QueryCtx,
	mode: BodySearchMode,
	narrowing: TextSearchNarrowing
) {
	const narrow = <T extends SearchFilterable<T>>(start: T): T => {
		let filtered = start;
		if (narrowing.folderId) filtered = filtered.eq('folderId', narrowing.folderId);
		if (narrowing.flagSeen !== undefined) filtered = filtered.eq('flagSeen', narrowing.flagSeen);
		if (narrowing.flagFlagged !== undefined)
			filtered = filtered.eq('flagFlagged', narrowing.flagFlagged);
		return filtered;
	};
	return mode === 'body'
		? ctx.db
				.query('mailMessages')
				.withSearchIndex('search_message_bodies', (q) =>
					narrow(q.search('searchBody', narrowing.text).eq('mailboxId', narrowing.mailboxId))
				)
		: ctx.db
				.query('mailMessages')
				.withSearchIndex('search_messages', (q) =>
					narrow(q.search('snippet', narrowing.text).eq('mailboxId', narrowing.mailboxId))
				);
}
