/**
 * Split inbox — the read behind the sectioned inbox renderer (idea 24).
 *
 * `mailFilters` was a full condition/action engine whose only reading effect was
 * moving mail to another folder, i.e. hiding it. `pinToSection` is the effect
 * between "one pile" and "out of sight": the message STAYS in the inbox and
 * carries a section name (`mailMessages.pinnedSection`, stamped at delivery by
 * deliveryPipeline/routing.ts and by the retroactive sweep in filterRun.ts).
 *
 * There is deliberately no section table. A section exists exactly as long as an
 * enabled filter names it, and the ORDER of the sections is the order of those
 * filters (`priority` ascending) — the same ordering the user already edits to
 * decide which rule wins. Deleting the rule retires the section; the mail it
 * filed simply falls back into "Everything else" on the next read.
 *
 * ── PAGING: WHY EACH SECTION HAS ITS OWN LIMIT ──────────────────────────────
 * The obvious implementation — page the inbox once and bucket the page
 * client-side — starves sections. A section fed by a chatty sender (CI, alerts)
 * fills every page, so a quiet section ("Team") stays empty until the user has
 * scrolled past hundreds of rows, and "Everything else" is worst hit because it
 * is defined by absence.
 *
 * So each NAMED section walks its OWN index range (`by_folder_and_section_and_received`)
 * with its OWN limit, and "load more" grows exactly one section. The cost is one
 * indexed read per section, which is why {@link MAX_SECTIONS} is small and hard.
 * The trade-off this makes instead: it is a bounded take, not keyset paging — a
 * Convex query may paginate only once, and one section's cursor could not be
 * spent on behalf of the others. `hasMore` is therefore honest per section and
 * the client raises that section's limit rather than passing a cursor.
 *
 * ── WHY THE REMAINDER IS NOT THE `pinnedSection === undefined` SLICE ────────
 * "Everything else" is the only section that CANNOT be read by index equality.
 * Nothing ever clears `mailMessages.pinnedSection`, so a row keeps the name it
 * was stamped with after the rule that named it is deleted, disabled or renamed
 * — and delivery stamps any matching name, including one past {@link MAX_SECTIONS}.
 * Reading the remainder as `eq(pinnedSection, undefined)` would drop every such
 * row out of BOTH lists: no named section carries the name, and the remainder
 * excludes it because the field is set. Retiring a rule would silently hide the
 * mail it had filed.
 *
 * The remainder therefore walks the folder in arrival order
 * (`by_folder_and_received`) and skips only the rows whose stamp names a section
 * this read is actually rendering. Anything else — an orphaned name, an over-cap
 * name, no name at all — folds into "Everything else", which is what the section
 * model promises. The walk is bounded by {@link REMAINDER_SCAN_FACTOR}/
 * {@link REMAINDER_MAX_SCAN}: when the budget runs out before the page is full,
 * `hasMore` is true and the client raises the limit (which raises the budget).
 */

import { v } from 'convex/values';
import type { QueryCtx } from '../_generated/server';
import { publicQuery } from '../lib/authedFunctions';
import type { Doc, Id } from '../_generated/dataModel';
import { loadReadableMailbox } from './permissions';
import { isMessageSnoozed } from '../lib/mailSnooze';

/**
 * How many named sections one inbox can render. Each section costs its own
 * indexed page read plus its own unread count, so this bounds the query's fan-out.
 * Filters beyond the cap keep filing mail (the row still carries the name); their
 * sections just fold into "Everything else" until an earlier one is retired.
 */
export const MAX_SECTIONS = 8;

/** Rows returned per section when the client asks for no specific limit. */
export const DEFAULT_SECTION_LIMIT = 20;

/** Ceiling on a single section's page, however much the client asks for. */
export const MAX_SECTION_LIMIT = 200;

/**
 * Unread counting stops here. A section header says "9+" past the cap rather
 * than walking an unbounded range to print an exact number nobody reads.
 */
export const UNREAD_COUNT_CAP = 99;

/**
 * Rows the remainder walk may read per row it keeps. The remainder filters in
 * code rather than on the index, so a folder whose recent mail is mostly pinned
 * costs more reads than it returns; this bounds that overfetch.
 */
export const REMAINDER_SCAN_FACTOR = 5;

/** Hard ceiling on rows read by one remainder walk, whatever the limit asks. */
export const REMAINDER_MAX_SCAN = 500;

/** One section of the split inbox, as the renderer consumes it. */
export interface InboxSection {
	/** The section name, or `null` for the trailing "Everything else". */
	name: string | null;
	messages: Doc<'mailMessages'>[];
	/** More mail exists in THIS section past its own limit. */
	hasMore: boolean;
	unreadCount: number;
	/**
	 * `unreadCount` is a floor, not the exact number — render it as "{count}+".
	 * True when the count hit {@link UNREAD_COUNT_CAP}, or when the remainder's
	 * walk spent its scan budget before it ran out of unread mail.
	 */
	isUnreadCapped: boolean;
}

/**
 * The ordered, deduplicated section names a mailbox's filters define.
 *
 * Pure, so the ordering contract is unit-testable without a database: enabled
 * filters only, `priority` ascending (the run order the user already edits),
 * first mention wins for a name claimed twice, capped at {@link MAX_SECTIONS}.
 */
export function sectionNamesFromFilters(
	filters: ReadonlyArray<Pick<Doc<'mailFilters'>, 'isEnabled' | 'priority' | 'actions'>>
): string[] {
	const ordered = [...filters].filter((f) => f.isEnabled).sort((a, b) => a.priority - b.priority);
	const names: string[] = [];
	for (const filter of ordered) {
		for (const action of filter.actions) {
			if (action.type !== 'pinToSection') continue;
			const name = action.sectionName?.trim();
			if (!name || names.includes(name)) continue;
			names.push(name);
			if (names.length >= MAX_SECTIONS) return names;
		}
	}
	return names;
}

/**
 * Does this row belong to "Everything else"?
 *
 * Yes for an unstamped row, and yes for a row stamped with a name that no
 * section on screen carries — an orphan left by a deleted, disabled or renamed
 * rule, or a name pushed past {@link MAX_SECTIONS}. Membership is decided by the
 * names being RENDERED, so the remainder is a true complement and no message can
 * fall between the two reads.
 */
export function belongsToRemainder(
	pinnedSection: string | undefined,
	renderedNames: ReadonlySet<string>
): boolean {
	if (!pinnedSection) return true;
	return !renderedNames.has(pinnedSection);
}

/**
 * Resolve the per-section page size the caller asked for. Unknown sections and
 * out-of-range numbers fall back to the default rather than erroring — a stale
 * client holding a limit for a since-deleted section must not break the read.
 */
export function resolveSectionLimit(
	limits: ReadonlyArray<{ section: string; limit: number }> | undefined,
	section: string | null
): number {
	const key = section ?? '';
	const found = limits?.find((l) => l.section === key)?.limit;
	if (found === undefined || !Number.isFinite(found)) return DEFAULT_SECTION_LIMIT;
	return Math.min(Math.max(1, Math.floor(found)), MAX_SECTION_LIMIT);
}

/**
 * The inbox, split into its sections.
 *
 * Read-only and additive: a mailbox with no `pinToSection` filter gets a single
 * "Everything else" section holding the whole inbox, which renders exactly like
 * the flat list. Snoozed mail is excluded here for the same reason the flat list
 * excludes it — it is hidden from the folder until it wakes.
 */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const listSections = publicQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		/** Per-section page sizes; `''` addresses the "Everything else" section. */
		limits: v.optional(v.array(v.object({ section: v.string(), limit: v.number() }))),
	},
	handler: async (ctx, args): Promise<{ sections: InboxSection[] }> => {
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return { sections: [] };

		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('role', 'inbox')
			)
			.first();
		if (!folder) return { sections: [] };

		const filters = await ctx.db
			.query('mailFilters')
			.withIndex('by_mailbox_and_priority', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: one mailbox's filters
		const names = sectionNamesFromFilters(filters);

		const now = Date.now();
		const sections: InboxSection[] = [];
		for (const name of names) {
			const limit = resolveSectionLimit(args.limits, name);
			sections.push(await readSection(ctx, folder._id, name, limit, now));
		}
		// The remainder goes last: it reads as the bottom of the inbox rather than
		// competing with the named sections. It is the complement of exactly the
		// names read above, so nothing can fall between the two reads.
		sections.push(
			await readRemainder(
				ctx,
				folder._id,
				new Set(names),
				resolveSectionLimit(args.limits, null),
				now
			)
		);
		return { sections };
	},
});

/** One NAMED section's page + unread count, both bounded indexed reads. */
async function readSection(
	ctx: QueryCtx,
	folderId: Id<'mailFolders'>,
	name: string,
	limit: number,
	now: number
): Promise<InboxSection> {
	const raw = await ctx.db
		.query('mailMessages')
		.withIndex('by_folder_and_section_and_received', (q) =>
			q.eq('folderId', folderId).eq('pinnedSection', name)
		)
		.order('desc')
		.take(limit + 1);
	const hasMore = raw.length > limit;
	const messages = raw.slice(0, limit).filter((m) => !isMessageSnoozed(m, now));

	const unread = await ctx.db
		.query('mailMessages')
		.withIndex('by_folder_and_section_and_seen', (q) =>
			q.eq('folderId', folderId).eq('pinnedSection', name).eq('flagSeen', false)
		)
		.take(UNREAD_COUNT_CAP + 1);
	const unreadRows = unread.filter((m) => !isMessageSnoozed(m, now));
	return {
		name,
		messages,
		hasMore,
		unreadCount: Math.min(unreadRows.length, UNREAD_COUNT_CAP),
		isUnreadCapped: unreadRows.length > UNREAD_COUNT_CAP,
	};
}

/**
 * "Everything else": every inbox row the named sections did not take.
 *
 * Streamed rather than taken, because the exclusion is not expressible on an
 * index (see the header note on orphaned stamps). Both walks are bounded by a
 * scan budget, so the cost is proportional to the page asked for even when the
 * top of the folder is entirely pinned.
 */
async function readRemainder(
	ctx: QueryCtx,
	folderId: Id<'mailFolders'>,
	renderedNames: ReadonlySet<string>,
	limit: number,
	now: number
): Promise<InboxSection> {
	const budget = Math.min(limit * REMAINDER_SCAN_FACTOR, REMAINDER_MAX_SCAN);

	const messages: Doc<'mailMessages'>[] = [];
	let hasMore = false;
	let scanned = 0;
	for await (const row of ctx.db
		.query('mailMessages')
		.withIndex('by_folder_and_received', (q) => q.eq('folderId', folderId))
		.order('desc')) {
		if (scanned >= budget) {
			// Out of budget with the page unfilled: there may well be more, and
			// raising this section's limit raises the budget with it.
			hasMore = true;
			break;
		}
		scanned += 1;
		if (!belongsToRemainder(row.pinnedSection, renderedNames)) continue;
		if (isMessageSnoozed(row, now)) continue;
		if (messages.length === limit) {
			hasMore = true;
			break;
		}
		messages.push(row);
	}

	let unreadCount = 0;
	let isUnreadCapped = false;
	let unreadScanned = 0;
	for await (const row of ctx.db
		.query('mailMessages')
		.withIndex('by_folder_and_seen', (q) => q.eq('folderId', folderId).eq('flagSeen', false))) {
		if (unreadScanned >= REMAINDER_MAX_SCAN) {
			// The count becomes a floor, which is exactly what "{count}+" says.
			isUnreadCapped = true;
			break;
		}
		unreadScanned += 1;
		if (!belongsToRemainder(row.pinnedSection, renderedNames)) continue;
		if (isMessageSnoozed(row, now)) continue;
		if (unreadCount === UNREAD_COUNT_CAP) {
			isUnreadCapped = true;
			break;
		}
		unreadCount += 1;
	}

	return { name: null, messages, hasMore, unreadCount, isUnreadCapped };
}
