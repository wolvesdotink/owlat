/**
 * Team Inbox filter-pill model + URL <-> state serialization.
 *
 * The active filter lives in the `?filter=` query param so a view is
 * shareable, bookmarkable, and survives back/forward. The default view (Open)
 * carries NO query param, keeping the canonical URL clean.
 */

/**
 * The status tabs. Four, one per thread state: assignment is a separate
 * filter ({@link INBOX_ASSIGNEES}) and "waiting over 24h" is a highlight + sort
 * inside Open, not a tab of its own (it was a subset of another tab).
 */
export const INBOX_FILTERS = ['open', 'waiting', 'snoozed', 'resolved'] as const;

export type InboxFilter = (typeof INBOX_FILTERS)[number];

export const DEFAULT_INBOX_FILTER: InboxFilter = 'open';

/** The assignment filter beside the status tabs. `anyone` = no narrowing. */
export const INBOX_ASSIGNEES = ['anyone', 'me', 'unassigned'] as const;

export type InboxAssignee = (typeof INBOX_ASSIGNEES)[number];

export const DEFAULT_INBOX_ASSIGNEE: InboxAssignee = 'anyone';

/** Label per assignment option, as catalog keys (module scope never calls `useI18n`). */
export const INBOX_ASSIGNEE_META: Record<InboxAssignee, { label: string }> = {
	anyone: { label: 'shared.inboxAssignees.anyone' },
	me: { label: 'shared.inboxAssignees.me' },
	unassigned: { label: 'shared.inboxAssignees.unassigned' },
};

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
	waiting: {
		label: 'shared.inboxFilters.waiting.label',
		empty: 'shared.inboxFilters.waiting.empty',
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
 * Links minted before the tabs were split: `?filter=mine`, `?filter=unassigned`
 * and `?filter=waiting-24h` still resolve — to the Open tab, with the
 * assignment (or the oldest-waiting order) they used to mean.
 */
const LEGACY_FILTERS: Record<string, { assignee?: InboxAssignee; sort?: InboxSort }> = {
	mine: { assignee: 'me' },
	unassigned: { assignee: 'unassigned' },
	'waiting-24h': { sort: 'oldest-waiting' },
};

function firstValue(raw: unknown): unknown {
	return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Parse the `?filter=` query value into a filter, falling back to the default
 * for anything absent or unrecognised (Vue Router yields `string | string[] |
 * null | undefined` for a query key). A legacy slug lands on the default tab.
 */
export function parseInboxFilter(raw: unknown): InboxFilter {
	const value = firstValue(raw);
	return isInboxFilter(value) ? value : DEFAULT_INBOX_FILTER;
}

/**
 * The assignment a view asks for: `?assignee=` wins, otherwise a legacy
 * `?filter=mine|unassigned` supplies it, otherwise anyone.
 */
export function parseInboxAssignee(rawAssignee: unknown, rawFilter?: unknown): InboxAssignee {
	const value = firstValue(rawAssignee);
	if (typeof value === 'string' && (INBOX_ASSIGNEES as readonly string[]).includes(value)) {
		return value as InboxAssignee;
	}
	const legacy = firstValue(rawFilter);
	return (typeof legacy === 'string' && LEGACY_FILTERS[legacy]?.assignee) || DEFAULT_INBOX_ASSIGNEE;
}

/** The sort a legacy `?filter=` slug implies, if any (`waiting-24h` → oldest waiting). */
export function legacyInboxSort(rawFilter: unknown): InboxSort | undefined {
	const legacy = firstValue(rawFilter);
	return typeof legacy === 'string' ? LEGACY_FILTERS[legacy]?.sort : undefined;
}

/**
 * Serialize a filter to a query value: `undefined` for the default (so the URL
 * stays bare) and the raw slug otherwise.
 */
export function inboxFilterToQuery(filter: InboxFilter): string | undefined {
	return filter === DEFAULT_INBOX_FILTER ? undefined : filter;
}

/** Same for the assignment: `anyone` keeps the URL bare. */
export function inboxAssigneeToQuery(assignee: InboxAssignee): string | undefined {
	return assignee === DEFAULT_INBOX_ASSIGNEE ? undefined : assignee;
}

/** The `assignee` argument the queries take (`anyone` = absent). */
export function inboxAssigneeArg(assignee: InboxAssignee): 'me' | 'unassigned' | undefined {
	return assignee === 'anyone' ? undefined : assignee;
}

/**
 * Live counts for the tab row, as `getThreadFilterCounts` returns them (already
 * narrowed by the active assignment). `waitingOver24h` is not a tab: it feeds
 * the "waiting over 24h" highlight inside Open. The query also returns legacy
 * `mine` / `unassigned` counts the page no longer reads.
 */
export interface InboxFilterCounts {
	open: number;
	waiting: number;
	snoozed: number;
	resolved: number;
	waitingOver24h: number;
	/** Counts read at most this many rows; a slice at the ceiling shows "99+". */
	cap: number;
}
