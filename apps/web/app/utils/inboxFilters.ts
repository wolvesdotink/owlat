/**
 * Team Inbox filter-pill model + URL <-> state serialization.
 *
 * The active filter lives in the `?filter=` query param so a view is
 * shareable, bookmarkable, and survives back/forward. The default view (Open)
 * carries NO query param, keeping the canonical URL clean.
 */

export const INBOX_FILTERS = [
	'open',
	'mine',
	'unassigned',
	'waiting',
	'waiting-24h',
	'snoozed',
	'resolved',
] as const;

export type InboxFilter = (typeof INBOX_FILTERS)[number];

export const DEFAULT_INBOX_FILTER: InboxFilter = 'open';

/**
 * How the list is ordered. `needs-attention` floats drafts-ready then
 * unassigned-unread; `oldest-waiting` puts the customer who has waited longest
 * first (the one metric a shared inbox exists to manage); `newest` is plain
 * recency, which by construction buries the oldest neglected thread.
 */
export const INBOX_SORTS = ['needs-attention', 'oldest-waiting', 'newest'] as const;

export type InboxSort = (typeof INBOX_SORTS)[number];
export const DEFAULT_INBOX_SORT: InboxSort = 'needs-attention';

/**
 * Label + icon per sort, as catalog keys (module scope never calls `useI18n`).
 * The chip that renders them is also the control that cycles them, so it needs
 * both the current name and something to move to.
 */
export const INBOX_SORT_META: Record<InboxSort, { label: string; icon: string }> = {
	'needs-attention': {
		label: 'shared.inboxSorts.needsAttention',
		icon: 'lucide:sparkles',
	},
	'oldest-waiting': { label: 'shared.inboxSorts.oldestWaiting', icon: 'lucide:timer' },
	newest: { label: 'shared.inboxSorts.newest', icon: 'lucide:arrow-down-wide-narrow' },
};

/** Normalise a stored/unknown value to a valid sort, defaulting safely. */
export function resolveInboxSort(value: unknown): InboxSort {
	return typeof value === 'string' && (INBOX_SORTS as readonly string[]).includes(value)
		? (value as InboxSort)
		: DEFAULT_INBOX_SORT;
}

/**
 * The sort a tap on the chip moves to. A cycle rather than a toggle now that
 * there are three: the chip states its current order, so the next one only has
 * to be predictable, and wrapping keeps every order one, two or three taps away.
 */
export function nextInboxSort(current: InboxSort): InboxSort {
	const index = INBOX_SORTS.indexOf(resolveInboxSort(current));
	return INBOX_SORTS[(index + 1) % INBOX_SORTS.length]!;
}

/**
 * Label + empty-state copy for each pill, as the catalog keys that carry them —
 * this table is module scope and never calls `useI18n`, so the pill row and the
 * inbox page are the render boundaries that word it.
 */
export const INBOX_FILTER_META: Record<InboxFilter, { label: string; empty: string }> = {
	open: { label: 'shared.inboxFilters.open.label', empty: 'shared.inboxFilters.open.empty' },
	mine: { label: 'shared.inboxFilters.mine.label', empty: 'shared.inboxFilters.mine.empty' },
	unassigned: {
		label: 'shared.inboxFilters.unassigned.label',
		empty: 'shared.inboxFilters.unassigned.empty',
	},
	waiting: {
		label: 'shared.inboxFilters.waiting.label',
		empty: 'shared.inboxFilters.waiting.empty',
	},
	'waiting-24h': {
		label: 'shared.inboxFilters.waiting24h.label',
		empty: 'shared.inboxFilters.waiting24h.empty',
	},
	snoozed: {
		label: 'shared.inboxFilters.snoozed.label',
		empty: 'shared.inboxFilters.snoozed.empty',
	},
	resolved: {
		label: 'shared.inboxFilters.resolved.label',
		empty: 'shared.inboxFilters.resolved.empty',
	},
};

function isInboxFilter(value: unknown): value is InboxFilter {
	return typeof value === 'string' && (INBOX_FILTERS as readonly string[]).includes(value);
}

/**
 * Parse the `?filter=` query value into a filter, falling back to the default
 * for anything absent or unrecognised (Vue Router yields `string | string[] |
 * null | undefined` for a query key).
 */
export function parseInboxFilter(raw: unknown): InboxFilter {
	const value = Array.isArray(raw) ? raw[0] : raw;
	return isInboxFilter(value) ? value : DEFAULT_INBOX_FILTER;
}

/**
 * Serialize a filter to a query value: `undefined` for the default (so the URL
 * stays bare) and the raw slug otherwise.
 */
export function inboxFilterToQuery(filter: InboxFilter): string | undefined {
	return filter === DEFAULT_INBOX_FILTER ? undefined : filter;
}

/**
 * Live counts for the pill row, exactly as `getThreadFilterCounts` returns
 * them. The wire field for the escalation pill is `waitingOver24h` rather than
 * the filter's own slug — a Convex object field is an identifier, and the slug
 * carries a hyphen — so {@link INBOX_FILTER_COUNT_KEY} is the one place the
 * two names are tied together.
 */
export interface InboxFilterCounts {
	open: number;
	mine: number;
	unassigned: number;
	waiting: number;
	waitingOver24h: number;
	snoozed: number;
	resolved: number;
	/** Counts read at most this many rows; a slice at the ceiling shows "99+". */
	cap: number;
}

export const INBOX_FILTER_COUNT_KEY: Record<
	InboxFilter,
	Exclude<keyof InboxFilterCounts, 'cap'>
> = {
	open: 'open',
	mine: 'mine',
	unassigned: 'unassigned',
	waiting: 'waiting',
	'waiting-24h': 'waitingOver24h',
	snoozed: 'snoozed',
	resolved: 'resolved',
};
