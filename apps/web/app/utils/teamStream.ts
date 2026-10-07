/**
 * The team thread stream's pure rules (SPEC §7 "Team"): how loaded pages
 * become one list, which rows a stream shows (system lines grouped, a "new"
 * divider), and the composer's `#` item link. Free of Vue and Convex so each
 * rule is unit-testable.
 */
import type {
	BriefItemView,
	TeamOpenItemsView,
	TeamStreamEntry,
} from '../../../api/convex/mail/interpret/briefShape';

export type ActivityEntry = Extract<TeamStreamEntry, { kind: 'activity' }>;
export type NoteEntry = Extract<TeamStreamEntry, { kind: 'note' }>;
export type ReplyEntry = Extract<TeamStreamEntry, { kind: 'teamReply' }>;
export type EmailEntry = Extract<TeamStreamEntry, { kind: 'customerEmail' }>;

interface Position {
	at: number;
	key: string;
}

/** Ascending stream order: time, then key. */
export function compareStream(a: Position, b: Position): number {
	if (a.at !== b.at) return a.at - b.at;
	return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Loaded pages as one list, oldest first. A page boundary can move while a
 * newer page re-runs, so an entry may arrive twice: the newest copy wins.
 */
export function mergeStreamPages(
	pages: readonly (readonly TeamStreamEntry[] | null | undefined)[]
): TeamStreamEntry[] {
	const byKey = new Map<string, TeamStreamEntry>();
	// Oldest page first, so the newest page's copy of an entry is the one kept.
	for (const page of [...pages].reverse()) {
		for (const entry of page ?? []) byKey.set(entry.key, entry);
	}
	return [...byKey.values()].sort(compareStream);
}

/** One row of the rendered stream. */
export type StreamRow =
	| { kind: 'entry'; key: string; entry: TeamStreamEntry }
	| { kind: 'opened'; key: string; at: number; entries: ActivityEntry[] }
	| { kind: 'newDivider'; key: string };

/** New items noted within this span read as one "N new actions" line. */
const OPENED_GROUP_MS = 5 * 60_000;

function isOpenedLine(entry: TeamStreamEntry): entry is ActivityEntry {
	return entry.kind === 'activity' && entry.activity.type === 'item_opened';
}

function isOwnEntry(entry: TeamStreamEntry, viewerId: string | null): boolean {
	if (!viewerId) return false;
	if (entry.kind === 'note') return entry.authorId === viewerId;
	if (entry.kind === 'teamReply') return entry.authorUserId === viewerId;
	return false;
}

/**
 * The rows a stream shows: consecutive "new item" lines become one, and a
 * "New" divider goes before the first entry past the viewer's saved place
 * that someone else wrote.
 */
export function buildStreamRows(
	entries: readonly TeamStreamEntry[],
	opts: { seenPosition?: Position | null; viewerId?: string | null } = {}
): StreamRow[] {
	const rows: StreamRow[] = [];
	const seen = opts.seenPosition ?? null;
	let isDividerPlaced = seen === null;
	for (const entry of entries) {
		if (
			!isDividerPlaced &&
			compareStream(entry, seen!) > 0 &&
			!isOwnEntry(entry, opts.viewerId ?? null)
		) {
			rows.push({ kind: 'newDivider', key: `new:${entry.key}` });
			isDividerPlaced = true;
		}
		const last = rows.at(-1);
		if (isOpenedLine(entry)) {
			if (last?.kind === 'opened' && entry.at - last.at <= OPENED_GROUP_MS) {
				last.entries.push(entry);
				continue;
			}
			rows.push({ kind: 'opened', key: entry.key, at: entry.at, entries: [entry] });
			continue;
		}
		rows.push({ kind: 'entry', key: entry.key, entry });
	}
	return rows;
}

/**
 * Where a host that renders the emails itself (the Postbox reader, Answer
 * mode) puts the stream's notes and system lines: after the email they follow
 * in the stream. `anchorOf` names the host's row for an email or reply entry
 * (null keeps the previous one, e.g. a message the host has not loaded).
 */
export function placeStreamExtras(
	entries: readonly TeamStreamEntry[],
	anchorOf: (entry: EmailEntry | ReplyEntry) => string | null
): { leading: TeamStreamEntry[]; after: Map<string, TeamStreamEntry[]> } {
	const leading: TeamStreamEntry[] = [];
	const after = new Map<string, TeamStreamEntry[]>();
	let anchor: string | null = null;
	for (const entry of entries) {
		if (entry.kind === 'customerEmail' || entry.kind === 'teamReply') {
			anchor = anchorOf(entry) ?? anchor;
			continue;
		}
		if (!anchor) leading.push(entry);
		else after.set(anchor, [...(after.get(anchor) ?? []), entry]);
	}
	return { leading, after };
}

/** The newest entry's position, for `markSeen({streamPosition})`. */
export function newestPosition(entries: readonly TeamStreamEntry[]): Position | null {
	const last = entries.at(-1);
	return last ? { at: last.at, key: last.key } : null;
}

/** Live notes linked to each item: the "· 2 notes" on a pinned item. */
export function noteCountsByItem(entries: readonly TeamStreamEntry[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const entry of entries) {
		if (entry.kind !== 'note' || entry.isDeleted || !entry.threadItemId) continue;
		counts.set(entry.threadItemId, (counts.get(entry.threadItemId) ?? 0) + 1);
	}
	return counts;
}

/** Live notes in the stream that mention `userId`. */
export function countMentionsOf(
	entries: readonly TeamStreamEntry[],
	userId: string | null | undefined
): number {
	if (!userId) return 0;
	return entries.filter(
		(e) => e.kind === 'note' && !e.isDeleted && e.mentionedUserIds.includes(userId)
	).length;
}

/** Every open item a team view lists, for the `#` picker: the team's first. */
export function linkableItems(view: TeamOpenItemsView | null | undefined): BriefItemView[] {
	if (!view) return [];
	return [...view.forTeam, ...view.unclear, ...view.waitingOnOthers].filter(
		(item) => item.status === 'open'
	);
}

/**
 * The `#fragment` being typed at `caret`, or null. The `#` must start the text
 * or follow whitespace; the fragment runs to the caret without whitespace.
 */
export function activeItemQuery(
	text: string,
	caret: number
): { start: number; fragment: string } | null {
	const before = text.slice(0, caret);
	const match = /(^|\s)#([^\s#]*)$/.exec(before);
	if (!match) return null;
	const start = before.length - match[2]!.length - 1;
	return { start, fragment: match[2]! };
}

/** Remove the typed `#fragment` once an item is picked; the link is kept beside the text. */
export function removeItemQuery(
	text: string,
	start: number,
	caret: number
): { text: string; caret: number } {
	return { text: text.slice(0, start) + text.slice(caret), caret: start };
}

/** The items the `#` picker offers for a fragment, matched on their text. */
export function matchItems(
	items: readonly BriefItemView[],
	fragment: string,
	limit = 6
): BriefItemView[] {
	const q = fragment.trim().toLowerCase();
	return items.filter((item) => !q || item.text.toLowerCase().includes(q)).slice(0, limit);
}

/** The emojis a note offers to react with, in this order. */
export const QUICK_REACTIONS = ['👍', '✅', '👀', '🙏'] as const;
