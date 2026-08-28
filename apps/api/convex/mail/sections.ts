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
 * So each section walks its OWN index range (`by_folder_and_section_and_received`)
 * with its OWN limit, and "load more" grows exactly one section. The cost is one
 * indexed read per section, which is why {@link MAX_SECTIONS} is small and hard.
 * The trade-off this makes instead: it is a bounded take, not keyset paging — a
 * Convex query may paginate only once, and one section's cursor could not be
 * spent on behalf of the others. `hasMore` is therefore honest per section and
 * the client raises that section's limit rather than passing a cursor.
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

/** One section of the split inbox, as the renderer consumes it. */
export interface InboxSection {
	/** The section name, or `null` for the trailing "Everything else". */
	name: string | null;
	messages: Doc<'mailMessages'>[];
	/** More mail exists in THIS section past its own limit. */
	hasMore: boolean;
	unreadCount: number;
	/** `unreadCount` hit {@link UNREAD_COUNT_CAP} — render it as "99+". */
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
		// `null` last: "Everything else" is the remainder, so it reads as the
		// bottom of the inbox rather than competing with the named sections.
		for (const name of [...names, null]) {
			const limit = resolveSectionLimit(args.limits, name);
			sections.push(await readSection(ctx, folder._id, name, limit, now));
		}
		return { sections };
	},
});

/** One section's page + unread count, both bounded indexed reads. */
async function readSection(
	ctx: QueryCtx,
	folderId: Id<'mailFolders'>,
	name: string | null,
	limit: number,
	now: number
): Promise<InboxSection> {
	// `undefined` on the index addresses every message with no section — the
	// remainder, without a scan of the whole folder.
	const key = name ?? undefined;
	const raw = await ctx.db
		.query('mailMessages')
		.withIndex('by_folder_and_section_and_received', (q) =>
			q.eq('folderId', folderId).eq('pinnedSection', key)
		)
		.order('desc')
		.take(limit + 1);
	const hasMore = raw.length > limit;
	const messages = raw.slice(0, limit).filter((m) => !isMessageSnoozed(m, now));

	const unread = await ctx.db
		.query('mailMessages')
		.withIndex('by_folder_and_section_and_seen', (q) =>
			q.eq('folderId', folderId).eq('pinnedSection', key).eq('flagSeen', false)
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
