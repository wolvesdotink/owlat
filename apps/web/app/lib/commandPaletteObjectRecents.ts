/**
 * The palette's JUMP-BACK memory: the last few records this person opened —
 * conversations, Team Inbox threads, campaigns, contacts, automations and
 * templates — so the idle ⌘K lists them above the recent searches, and ⌘K then
 * Enter goes straight back to the last one.
 *
 * It records OPENS, wherever they happen (a click in a list, a link, the
 * palette), not palette selections: the question it answers is "what was I just
 * looking at", which the search history cannot.
 *
 * Kept per user and per organization (two people on one machine, or one person
 * in two organizations, never see each other's records), newest first, one entry
 * per record, at most {@link MAX_OBJECT_RECENTS}.
 *
 * Pure: storage IO and the reactive store live in
 * `~/composables/useCommandPaletteObjectRecents`.
 */

/** The kinds of record the jump-back list remembers. */
const PALETTE_OBJECT_KINDS = [
	'conversation',
	'teamThread',
	'campaign',
	'contact',
	'automation',
	'template',
] as const;
export type PaletteObjectKind = (typeof PALETTE_OBJECT_KINDS)[number];

/** One opened record. */
export interface PaletteObjectRecent {
	kind: PaletteObjectKind;
	/** The record's id; with `kind`, the dedupe key. */
	id: string;
	/** What it was called when it was opened (a subject, a name). */
	title: string;
	/** The route that reopens it. */
	href: string;
	/** Conversations only: the mailbox to select before opening it. */
	mailboxId?: string;
	/**
	 * Conversations only: the message the route opens. The record id is the
	 * thread's, so a search hit for any message of it can still be matched.
	 */
	messageId?: string;
	/** When it was last opened (ms epoch). */
	openedAt: number;
}

/** How many records the list keeps. */
export const MAX_OBJECT_RECENTS = 10;

/** Long subjects are clipped on the way in; the row truncates anyway. */
const MAX_TITLE_LENGTH = 200;

const STORAGE_KEY_PREFIX = 'owlat_recent_objects';

/** The storage key for one person in one organization. Pure. */
export function objectRecentsStorageKey(userId: string, organizationId: string | null): string {
	return `${STORAGE_KEY_PREFIX}:${userId}:${organizationId ?? 'none'}`;
}

function isKind(value: unknown): value is PaletteObjectKind {
	return typeof value === 'string' && (PALETTE_OBJECT_KINDS as readonly string[]).includes(value);
}

function nonEmpty(value: unknown): value is string {
	return typeof value === 'string' && value.trim() !== '';
}

/** One stored entry, or null when it is not a record this version understands. */
function normalizeEntry(value: unknown): PaletteObjectRecent | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	if (!isKind(raw['kind']) || !nonEmpty(raw['id']) || !nonEmpty(raw['title'])) return null;
	// Only in-app routes: a hand-edited entry must not turn the palette into a
	// way to navigate somewhere else.
	if (!nonEmpty(raw['href']) || !raw['href'].startsWith('/dashboard/')) return null;
	if (typeof raw['openedAt'] !== 'number' || !Number.isFinite(raw['openedAt'])) return null;
	return {
		kind: raw['kind'],
		id: raw['id'],
		title: raw['title'].trim().slice(0, MAX_TITLE_LENGTH),
		href: raw['href'],
		...(nonEmpty(raw['mailboxId']) ? { mailboxId: raw['mailboxId'] } : {}),
		...(nonEmpty(raw['messageId']) ? { messageId: raw['messageId'] } : {}),
		openedAt: raw['openedAt'],
	};
}

/** Newest first, one entry per record, capped. Pure. */
function normalizeList(entries: readonly PaletteObjectRecent[]): PaletteObjectRecent[] {
	const seen = new Set<string>();
	const kept: PaletteObjectRecent[] = [];
	for (const entry of [...entries].sort((a, b) => b.openedAt - a.openedAt)) {
		const key = objectRecentKey(entry);
		if (seen.has(key)) continue;
		seen.add(key);
		kept.push(entry);
		if (kept.length >= MAX_OBJECT_RECENTS) break;
	}
	return kept;
}

/**
 * Read the stored list. Anything absent, truncated or hand-edited reads as the
 * entries that still make sense (or none) rather than throwing. Pure.
 */
export function parseObjectRecents(raw: string | null): PaletteObjectRecent[] {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return normalizeList(
		parsed.map(normalizeEntry).filter((entry): entry is PaletteObjectRecent => entry !== null)
	);
}

/** Whether two entries are the same record (a conversation also by its message). */
function sameRecord(a: PaletteObjectRecent, b: PaletteObjectRecent): boolean {
	if (a.kind !== b.kind) return false;
	if (a.id === b.id) return true;
	// A reader that opened before its thread loaded recorded the message id;
	// the same conversation recorded again under its thread id replaces it.
	return a.messageId !== undefined && a.messageId === b.messageId;
}

/**
 * Record an open: the record moves to the front (with its newest title and
 * route), the oldest falls off past the cap. Pure.
 */
export function pushObjectRecent(
	list: readonly PaletteObjectRecent[],
	entry: PaletteObjectRecent
): PaletteObjectRecent[] {
	const normalized = normalizeEntry(entry);
	if (!normalized) return [...list];
	return normalizeList([
		normalized,
		...list.filter((existing) => !sameRecord(existing, normalized)),
	]);
}

/**
 * When each record (and, for conversations, the message the route opens) was
 * last opened, for the ranking tie-break. Pure.
 */
export function objectRecencyIndex(list: readonly PaletteObjectRecent[]): Map<string, number> {
	const index = new Map<string, number>();
	for (const entry of list) {
		for (const id of [entry.id, entry.messageId]) {
			if (id && !index.has(id)) index.set(id, entry.openedAt);
		}
	}
	return index;
}

/** The icon each kind of record carries in the list. */
export const PALETTE_OBJECT_ICONS: Readonly<Record<PaletteObjectKind, string>> = {
	conversation: 'lucide:mail',
	teamThread: 'lucide:inbox',
	campaign: 'lucide:megaphone',
	contact: 'lucide:user',
	automation: 'lucide:workflow',
	template: 'lucide:file-text',
};

/** The dedupe key of a record: its kind and its id. */
export function objectRecentKey(entry: Pick<PaletteObjectRecent, 'kind' | 'id'>): string {
	return `${entry.kind}:${entry.id}`;
}

/**
 * The entries the jump-back list offers: the records on screen right now are
 * left out, so the first row — the one ⌘K then Enter runs — is always the one
 * you were on BEFORE this. Pure.
 */
export function jumpBackEntries(
	list: readonly PaletteObjectRecent[],
	onScreen: ReadonlySet<string>
): PaletteObjectRecent[] {
	return list.filter((entry) => !onScreen.has(objectRecentKey(entry)));
}
