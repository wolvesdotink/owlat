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
	'snoozed',
	'resolved',
] as const;

export type InboxFilter = (typeof INBOX_FILTERS)[number];

export const DEFAULT_INBOX_FILTER: InboxFilter = 'open';

export type InboxSort = 'needs-attention' | 'newest';
export const DEFAULT_INBOX_SORT: InboxSort = 'needs-attention';

/** Human label + empty-state copy for each pill. */
export const INBOX_FILTER_META: Record<InboxFilter, { label: string; empty: string }> = {
	open: { label: 'Open', empty: 'No open conversations. Inbox zero.' },
	mine: { label: 'Mine', empty: 'Nothing is assigned to you right now.' },
	unassigned: { label: 'Unassigned', empty: 'Every open thread has an owner.' },
	waiting: { label: 'Waiting', empty: 'No threads are waiting on a customer reply.' },
	snoozed: { label: 'Snoozed', empty: 'Nothing is snoozed. It will reappear here when it does.' },
	resolved: { label: 'Resolved', empty: 'No resolved conversations yet.' },
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
