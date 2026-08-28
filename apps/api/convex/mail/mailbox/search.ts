/**
 * Mailbox search — free-text + structured query across one mailbox's messages.
 *
 * Kept apart from `mailbox/queries.ts` because it is the one read whose shape
 * is driven by the query PARSER (`parseSearchQuery` on the web side) rather
 * than by a folder/label view: its arg list, its two index branches, and its
 * post-filter chain all track the search grammar.
 *
 * Siblings: `mailbox/identity.ts` (CRUD + provisioning), `mailbox/queries.ts`
 * (list views), `mailbox/messages.ts` (single-message reads).
 */

import { v } from 'convex/values';
import { publicQuery } from '../../lib/authedFunctions';
import type { QueryCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { loadAccessibleMailboxes, loadReadableMailbox } from '../permissions';
import { readSession, type FolderRole } from './shared';
import {
	type MailboxPage,
	type MailboxScanPosition,
	decodeMultiCursor,
	encodeMultiCursor,
	isConsumed,
	mergeMailboxPages,
	positionRows,
} from './searchCursor';

/**
 * Excluded operands (`-from:ines`), per operator. Arrays because several
 * exclusions of one operator are a conjunction, unlike the positive operators
 * where the parser's last occurrence wins.
 */
const searchNegationValidator = v.object({
	text: v.optional(v.array(v.string())),
	from: v.optional(v.array(v.string())),
	to: v.optional(v.array(v.string())),
	cc: v.optional(v.array(v.string())),
	bcc: v.optional(v.array(v.string())),
	subject: v.optional(v.array(v.string())),
	filename: v.optional(v.array(v.string())),
	labelName: v.optional(v.array(v.string())),
	folderRole: v.optional(v.array(v.string())),
});

/**
 * One conjunction of search terms — the whole query, or one side of an `OR`.
 * Shared between the top-level args and the `or` array so both sides of a
 * disjunction speak exactly the same grammar.
 */
const searchClauseFields = {
	// Pre-parsed query payload; the web side calls
	// `parseSearchQuery(rawText)` before calling us so the parser
	// stays close to the UI.
	text: v.string(),
	// Quoted runs from the raw query ("exact phrase"). Their words are also in
	// `text`, so the search index still does the indexed narrowing; these
	// additionally require ADJACENCY, which a token index cannot express.
	// Already lowercased by the parser.
	phrases: v.optional(v.array(v.string())),
	from: v.optional(v.string()),
	to: v.optional(v.string()),
	cc: v.optional(v.string()),
	bcc: v.optional(v.string()),
	subject: v.optional(v.string()),
	// Attachment filename substring. Once this mailbox's `mailAttachments` index
	// is built, a text-free `filename:` query DRIVES the scan off it (see
	// `searchByFilename`) and so reaches attachments of any age; on a mailbox
	// whose index is still partial it stays the post-filter it always was,
	// narrowing a page rather than the scan.
	filename: v.optional(v.string()),
	hasAttachment: v.optional(v.boolean()),
	flagSeen: v.optional(v.boolean()),
	flagFlagged: v.optional(v.boolean()),
	folderRole: v.optional(v.string()),
	labelName: v.optional(v.string()),
	beforeMs: v.optional(v.number()),
	afterMs: v.optional(v.number()),
	// Raw RFC822 size bounds, in bytes, both strict.
	largerThan: v.optional(v.number()),
	smallerThan: v.optional(v.number()),
	not: v.optional(searchNegationValidator),
};

const searchClauseValidator = v.object(searchClauseFields);

type SearchClause = {
	text: string;
	phrases?: string[];
	from?: string;
	to?: string;
	cc?: string;
	bcc?: string;
	subject?: string;
	filename?: string;
	hasAttachment?: boolean;
	flagSeen?: boolean;
	flagFlagged?: boolean;
	folderRole?: string;
	labelName?: string;
	beforeMs?: number;
	afterMs?: number;
	largerThan?: number;
	smallerThan?: number;
	not?: {
		text?: string[];
		from?: string[];
		to?: string[];
		cc?: string[];
		bcc?: string[];
		subject?: string[];
		filename?: string[];
		labelName?: string[];
		folderRole?: string[];
	};
};

/** Names resolved once per request and shared by every clause that uses them. */
interface ResolvedNames {
	folderByRole: Map<string, Id<'mailFolders'> | null>;
	labelByName: Map<string, Id<'mailLabels'> | null>;
}

/**
 * A clause whose `in:`/`label:` names no existing folder or label can never
 * match anything, so it is dropped before the scan instead of being carried
 * through it. When EVERY clause is dead the search short-circuits to empty.
 */
function isDeadClause(clause: SearchClause, names: ResolvedNames): boolean {
	if (clause.folderRole && !names.folderByRole.get(clause.folderRole)) return true;
	if (clause.labelName && !names.labelByName.get(clause.labelName)) return true;
	return false;
}

function includesAll(haystack: string, needles: string[] | undefined): boolean {
	return !needles || needles.every((needle) => haystack.includes(needle));
}

function excludesAll(haystack: string, needles: string[] | undefined): boolean {
	return !needles || needles.every((needle) => !haystack.includes(needle));
}

/**
 * Does this message satisfy one clause?
 *
 * `filterText` decides whether the clause's free text is re-checked here.
 * Normally it is NOT: the search index already narrowed the scan to it, and a
 * strict substring re-check would throw away the index's stemming and
 * prefix-matching (searching "meetings" would stop finding "meeting"). A
 * disjunction has no single indexed text to narrow by, so those queries run
 * off the arrival index and every clause has to check its own text — coarser
 * matching, but the only honest option once the index is out of the picture.
 */
function matchesClause(
	m: Doc<'mailMessages'>,
	clause: SearchClause,
	names: ResolvedNames,
	filterText: boolean
): boolean {
	const folderId = clause.folderRole ? names.folderByRole.get(clause.folderRole) : undefined;
	if (clause.folderRole && m.folderId !== folderId) return false;

	if (clause.from && !m.fromAddress.includes(clause.from)) return false;
	if (clause.to && !m.toAddresses.some((a) => a.includes(clause.to as string))) return false;
	if (clause.cc && !m.ccAddresses.some((a) => a.includes(clause.cc as string))) return false;
	if (clause.bcc && !m.bccAddresses.some((a) => a.includes(clause.bcc as string))) return false;
	if (clause.subject && !m.subject.toLowerCase().includes(clause.subject)) return false;

	const filenames = m.attachments.map((a) => a.filename.toLowerCase());
	if (clause.filename && !filenames.some((name) => name.includes(clause.filename as string))) {
		return false;
	}

	// Every quoted phrase must appear verbatim in the subject or the
	// snippet — the two fields the caller can actually see in a result row.
	const haystack = `${m.subject}\n${m.snippet}`.toLowerCase();
	if (clause.phrases && !includesAll(haystack, clause.phrases)) return false;
	if (filterText && clause.text) {
		const words = clause.text.toLowerCase().split(/\s+/).filter(Boolean);
		if (!includesAll(haystack, words)) return false;
	}

	if (clause.hasAttachment !== undefined && m.hasAttachments !== clause.hasAttachment) return false;
	if (clause.flagSeen !== undefined && m.flagSeen !== clause.flagSeen) return false;
	if (clause.flagFlagged !== undefined && m.flagFlagged !== clause.flagFlagged) return false;

	if (clause.labelName) {
		const labelId = names.labelByName.get(clause.labelName);
		if (!labelId || !m.labelIds.includes(labelId)) return false;
	}

	if (clause.beforeMs !== undefined && m.receivedAt >= clause.beforeMs) return false;
	if (clause.afterMs !== undefined && m.receivedAt <= clause.afterMs) return false;
	if (clause.largerThan !== undefined && m.rawSize <= clause.largerThan) return false;
	if (clause.smallerThan !== undefined && m.rawSize >= clause.smallerThan) return false;

	const not = clause.not;
	if (not) {
		if (!excludesAll(haystack, not.text)) return false;
		if (!excludesAll(m.fromAddress, not.from)) return false;
		if (!excludesAll(m.toAddresses.join(' '), not.to)) return false;
		if (!excludesAll(m.ccAddresses.join(' '), not.cc)) return false;
		if (!excludesAll(m.bccAddresses.join(' '), not.bcc)) return false;
		if (!excludesAll(m.subject.toLowerCase(), not.subject)) return false;
		if (!excludesAll(filenames.join('\n'), not.filename)) return false;
		// An exclusion that names a label or folder which does not exist excludes
		// nothing — it must not silently empty the result set.
		for (const name of not.labelName ?? []) {
			const labelId = names.labelByName.get(name);
			if (labelId && m.labelIds.includes(labelId)) return false;
		}
		for (const role of not.folderRole ?? []) {
			const excluded = names.folderByRole.get(role);
			if (excluded && m.folderId === excluded) return false;
		}
	}

	return true;
}

/**
 * Resolve every `in:` role and `label:` name a clause set mentions — positive
 * and negated — once per mailbox, so a disjunction doesn't re-read the same
 * folder per alternative.
 */
async function resolveNames(
	ctx: QueryCtx,
	mailboxId: Id<'mailboxes'>,
	clauses: readonly SearchClause[]
): Promise<ResolvedNames> {
	const names: ResolvedNames = { folderByRole: new Map(), labelByName: new Map() };
	// Labels are stored with their display casing while the parser lowercases
	// every operand, so `label:work` has to reach a label named "Work". The
	// indexed exact hit is tried first and the case-insensitive sweep over the
	// mailbox's (few) labels is the fallback.
	let allLabels: Doc<'mailLabels'>[] | null = null;
	for (const clause of clauses) {
		for (const role of [clause.folderRole, ...(clause.not?.folderRole ?? [])]) {
			if (!role || names.folderByRole.has(role)) continue;
			const folder = await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) =>
					q.eq('mailboxId', mailboxId).eq('role', role as FolderRole)
				)
				.first();
			names.folderByRole.set(role, folder?._id ?? null);
		}
		for (const name of [clause.labelName, ...(clause.not?.labelName ?? [])]) {
			if (!name || names.labelByName.has(name)) continue;
			const exact = await ctx.db
				.query('mailLabels')
				.withIndex('by_mailbox_and_name', (q) => q.eq('mailboxId', mailboxId).eq('name', name))
				.first();
			if (exact) {
				names.labelByName.set(name, exact._id);
				continue;
			}
			allLabels ??= await ctx.db
				.query('mailLabels')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
				.collect(); // bounded: one mailbox's labels
			const insensitive = allLabels.find((label) => label.name.toLowerCase() === name);
			names.labelByName.set(name, insensitive?._id ?? null);
		}
	}
	return names;
}

/** How many mailboxes one fan-out search may scan. Bounds the per-page reads. */
const MAX_SEARCH_MAILBOXES = 10;

/** Hard ceiling on one mailbox's raw page, including a re-read tie-group prefix. */
const MAX_SCAN_ROWS = 512;

/**
 * The mailboxes a fan-out search runs over: the explicitly requested ones
 * (each re-checked through the same read gate as the single-mailbox path, so an
 * id the caller cannot read is dropped rather than searched), or — when none
 * are named — every ACTIVE mailbox the caller can reach (own + shared
 * memberships).
 */
async function resolveTargets(
	ctx: QueryCtx,
	requested: Id<'mailboxes'>[] | undefined
): Promise<Id<'mailboxes'>[]> {
	if (requested) {
		const readable: Id<'mailboxes'>[] = [];
		for (const id of [...new Set(requested)].slice(0, MAX_SEARCH_MAILBOXES)) {
			const mailbox = await loadReadableMailbox(ctx, id);
			if (mailbox) readable.push(mailbox._id);
		}
		return readable;
	}
	const session = await readSession(ctx);
	if (!session) return [];
	const mailboxes = await loadAccessibleMailboxes(
		ctx,
		session.userId,
		session.activeOrganizationId
	);
	return mailboxes
		.filter((mailbox) => mailbox.status === 'active')
		.slice(0, MAX_SEARCH_MAILBOXES)
		.map((mailbox) => mailbox._id);
}

/**
 * One mailbox's slice of a fan-out page, read with a MANUAL keyset (Convex
 * allows a single `.paginate()` per function execution, so N mailboxes cannot
 * each paginate natively).
 *
 * The free-text branch is the exception: the search index is relevance-ordered
 * and exposes no keyset, so a fan-out text search reads one page per mailbox
 * and reports that mailbox as complete (`done`) — deeper text matches stay
 * reachable through the single-mailbox path, which still paginates natively.
 */
async function scanMailbox(
	ctx: QueryCtx,
	mailboxId: Id<'mailboxes'>,
	clauses: readonly SearchClause[],
	limit: number,
	previous: MailboxScanPosition | null
): Promise<MailboxPage<Doc<'mailMessages'>>> {
	const names = await resolveNames(ctx, mailboxId, clauses);
	const live = clauses.filter((clause) => !isDeadClause(clause, names));
	if (live.length === 0) return { mailboxId, previous, rows: [], done: true };

	const disjunctive = live.length > 1;
	const single = disjunctive ? null : live[0]!;
	if (single && single.text) {
		const folderId = single.folderRole
			? (names.folderByRole.get(single.folderRole) ?? undefined)
			: undefined;
		const hits = await ctx.db
			.query('mailMessages')
			.withSearchIndex('search_messages', (q) => {
				let filtered = q.search('snippet', single.text).eq('mailboxId', mailboxId);
				if (folderId) filtered = filtered.eq('folderId', folderId);
				if (single.flagSeen !== undefined) filtered = filtered.eq('flagSeen', single.flagSeen);
				if (single.flagFlagged !== undefined)
					filtered = filtered.eq('flagFlagged', single.flagFlagged);
				return filtered;
			})
			.take(limit);
		return {
			mailboxId,
			previous,
			rows: positionRows(hits.filter((m) => matchesClause(m, single, names, false))),
			done: true,
		};
	}

	// The range bound is `<=` because a `(receivedAt, _id)` compound bound is not
	// expressible, so resuming re-reads the boundary timestamp's whole tie group.
	// Reading `skip` extra rows covers exactly that re-read prefix, so every page
	// still surfaces up to `limit` fresh rows — even at `limit: 1` inside a long
	// tie group. The overall take stays bounded by MAX_SCAN_ROWS; a tie group
	// past that bound ends the walk rather than looping on it.
	const takeCount = Math.min(limit + (previous?.skip ?? 0), MAX_SCAN_ROWS);
	const scanned = await ctx.db
		.query('mailMessages')
		.withIndex('by_mailbox_and_received', (q) =>
			previous
				? q.eq('mailboxId', mailboxId).lte('receivedAt', previous.at)
				: q.eq('mailboxId', mailboxId)
		)
		.order('desc')
		.take(takeCount);
	const positioned = positionRows(scanned);
	const fresh = positioned.filter((entry) => !isConsumed(entry.position, previous));
	return {
		mailboxId,
		previous,
		rows: fresh.filter((entry) =>
			live.some((clause) => matchesClause(entry.row, clause, names, disjunctive))
		),
		scanned: positioned[positioned.length - 1]?.position,
		done: scanned.length < takeCount || fresh.length === 0,
	};
}

/**
 * Has the attachment index been built over this mailbox's EXISTING mail?
 *
 * `mail/attachmentIndex.ts` writes a junction row for every message delivered
 * after the index shipped, but mail older than that only enters the index when
 * the backfill (`mail/attachmentBackfill.ts`) walks it. Until that walk
 * completes the index is a partial view of the mailbox, so the search stays on
 * the post-filter it always used rather than silently narrowing to "files we
 * happen to have indexed".
 */
async function isAttachmentIndexComplete(
	ctx: QueryCtx,
	mailboxId: Id<'mailboxes'>
): Promise<boolean> {
	const job = await ctx.db
		.query('mailAttachmentBackfillJobs')
		.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
		.first();
	return job?.status === 'completed';
}

/**
 * Index-driven `filename:` — the scan runs over `mailAttachments`, not over
 * `mailMessages`.
 *
 * The junction table (schema/mail.ts, written by `mail/attachmentIndex.ts`) is
 * the only indexable view of what used to be an unindexable array on the
 * message, so this is where `filename:` stops being a post-filter that could
 * only see one page of recent mail and becomes an actual search.
 *
 * The page unit is an ATTACHMENT, so several files on one message collapse to a
 * single result row (dedup within the page) and the returned page can be
 * shorter than the attachment page. The cursor is the attachment index's, which
 * keeps continuation exact: rows are consumed, never skipped. The remaining
 * clause facets (`from:`, `is:unread`, dates, sizes, exclusions) still run as
 * post-filters against the loaded message, so the operator composes with
 * everything else in the grammar exactly as before.
 */
async function searchByFilename(
	ctx: QueryCtx,
	mailboxId: Id<'mailboxes'>,
	clause: SearchClause,
	names: ResolvedNames,
	limit: number,
	cursor: string | null
): Promise<{ messages: Doc<'mailMessages'>[]; hasMore: boolean; nextCursor: string | null }> {
	const page = await ctx.db
		.query('mailAttachments')
		.withSearchIndex('search_filenames', (q) =>
			q.search('filename', clause.filename as string).eq('mailboxId', mailboxId)
		)
		.paginate({ cursor, numItems: limit });

	const seen = new Set<Id<'mailMessages'>>();
	const messages: Doc<'mailMessages'>[] = [];
	for (const row of page.page) {
		if (seen.has(row.messageId)) continue;
		seen.add(row.messageId);
		const message = await ctx.db.get(row.messageId);
		// A junction row that outlived its message (a teardown that lost a race)
		// must not surface as a result.
		if (!message || message.mailboxId !== mailboxId) continue;
		// The search index is token/prefix-based; the operator's contract is a
		// SUBSTRING, so the message-level check still has the final say.
		if (matchesClause(message, clause, names, false)) messages.push(message);
	}

	return {
		messages,
		hasMore: !page.isDone,
		nextCursor: page.isDone ? null : page.continueCursor,
	};
}

/**
 * Free-text + structured search across messages in one or many mailboxes.
 *
 * Keyset-paginated: pass `nextCursor` from the previous response to walk past
 * the first page (the pre-pagination implementation silently capped at 200
 * rows with no way to reach deeper matches). Post-filters that the search
 * index can't express (`from:`/`to:`/`cc:`/`subject:`/`filename:` substrings,
 * label, date range, size bounds, exclusions) shrink a page but never
 * invalidate its cursor — rows are consumed, not skipped, so continuation
 * stays complete.
 *
 * `or` carries the parser's single-level disjunction: each entry is a full
 * clause and a message matches when ANY clause does. A disjunction gives up
 * the search index (there is no one text every alternative shares) and walks
 * the arrival index instead — still paginated, just unnarrowed, exactly like
 * an operator-only query today.
 *
 * FAN-OUT. `mailboxIds` searches several mailboxes at once — and passing
 * neither `mailboxId` nor `mailboxIds` searches every mailbox the caller can
 * read (own + shared memberships, active only), so "search everywhere" needs no
 * client-side list. Each mailbox is read with its own keyset and the slices are
 * merged newest-first by `receivedAt`, with all positions carried in one opaque
 * cursor (see `./searchCursor`). Passing `mailboxId` alone keeps the original
 * single-mailbox path bit-for-bit — same index branches, same native
 * `.paginate()` cursor — so existing callers are untouched.
 */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const search = publicQuery({
	args: {
		// Single-mailbox search (legacy shape). Optional so a caller can fan out
		// over `mailboxIds`, or over everything readable by passing neither.
		mailboxId: v.optional(v.id('mailboxes')),
		mailboxIds: v.optional(v.array(v.id('mailboxes'))),
		...searchClauseFields,
		or: v.optional(v.array(searchClauseValidator)),
		limit: v.optional(v.number()),
		cursor: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const empty = { messages: [] as Doc<'mailMessages'>[], hasMore: false, nextCursor: null };
		const { mailboxId, mailboxIds, or, limit: rawLimit, cursor, ...primary } = args;
		const clauses: SearchClause[] = [primary as SearchClause, ...(or ?? [])];
		const limit = Math.min(rawLimit ?? 50, 200);

		// ── Fan-out: several mailboxes (or every readable one), manual keyset.
		if (!mailboxId || mailboxIds) {
			const targets = await resolveTargets(ctx, mailboxIds);
			if (targets.length === 0) return empty;
			const decoded = decodeMultiCursor(cursor);
			const pages: MailboxPage<Doc<'mailMessages'>>[] = [];
			for (const target of targets) {
				// A mailbox missing from a live cursor was drained on an earlier page.
				if (decoded && !(target in decoded)) continue;
				pages.push(await scanMailbox(ctx, target, clauses, limit, decoded?.[target] ?? null));
			}
			const merged = mergeMailboxPages(pages, limit);
			return {
				messages: merged.page,
				hasMore: merged.hasMore,
				nextCursor: merged.hasMore ? encodeMultiCursor(merged.cursor) : null,
			};
		}

		// ── Single mailbox: unchanged native pagination.
		const mailbox = await loadReadableMailbox(ctx, mailboxId);
		if (!mailbox) return empty;

		const names = await resolveNames(ctx, mailboxId, clauses);
		const live = clauses.filter((clause) => !isDeadClause(clause, names));
		if (live.length === 0) return empty;

		// A disjunction has no shared text to search on, so it walks the arrival
		// index and re-checks each clause's text in the post-filter.
		const disjunctive = live.length > 1;
		const single = disjunctive ? null : live[0]!;
		const folderId = single?.folderRole
			? (names.folderByRole.get(single.folderRole) ?? undefined)
			: undefined;

		// `filename:` with no free text scans the ATTACHMENT index instead of the
		// message table (idea 37). Before `mailAttachments` existed the operand
		// could only ever be a post-filter over one page of arrival-ordered mail,
		// so a contract sent two years ago was unfindable no matter how exactly
		// its name was typed. Now the scan itself is the filename search.
		//
		// ONLY once the index covers this mailbox's existing mail. The write path
		// fills it from delivery onward, so until the backfill has completed the
		// index is a partial view and driving the scan off it would make
		// `filename:` return LESS than the post-filter it replaced — a regression
		// dressed up as an empty result. Until then the post-filter below runs,
		// exactly as it did before the index shipped.
		if (
			single &&
			!single.text &&
			single.filename &&
			(await isAttachmentIndexComplete(ctx, mailboxId))
		) {
			return searchByFilename(ctx, mailboxId, single, names, limit, cursor ?? null);
		}

		// Both branches paginate natively: the text branch over the search index,
		// the no-text branch over the arrival index. The page may shrink below
		// `limit` after the post-filter; the cursor still marks the true scan
		// position, so "Load more" never skips or repeats a row.
		const page =
			single && single.text
				? await ctx.db
						.query('mailMessages')
						.withSearchIndex('search_messages', (q) => {
							let filtered = q.search('snippet', single.text).eq('mailboxId', mailboxId);
							if (folderId) filtered = filtered.eq('folderId', folderId);
							// `from` is a partial token (e.g. "sara"), not a full address, so it
							// can't use the search index's exact .eq('fromAddress') — the substring
							// post-filter below handles it for both the text and no-text branches.
							if (single.flagSeen !== undefined)
								filtered = filtered.eq('flagSeen', single.flagSeen);
							if (single.flagFlagged !== undefined)
								filtered = filtered.eq('flagFlagged', single.flagFlagged);
							return filtered;
						})
						.paginate({ cursor: cursor ?? null, numItems: limit })
				: await ctx.db
						.query('mailMessages')
						.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailboxId))
						.order('desc')
						.paginate({ cursor: cursor ?? null, numItems: limit });

		// Final filters that the search index couldn't express.
		const filtered = page.page.filter((m) =>
			live.some((clause) => matchesClause(m, clause, names, disjunctive))
		);

		return {
			messages: filtered,
			hasMore: !page.isDone,
			nextCursor: page.isDone ? null : page.continueCursor,
		};
	},
});
