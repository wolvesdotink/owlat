/**
 * All inboxes and the unified folders are Postbox folder routes of their own:
 * `/dashboard/postbox/all-inboxes`, `all-sent`, `all-drafts`, `all-archive`,
 * `all-spam` and `all-trash`, each with `/<messageId>` for the reader. The
 * list, the reader and every move between them (j/k, back, auto-advance after
 * an archive) stay in the merged view the same way they stay in one folder:
 * they build their links from the `[folder]` segment. A segment can never be a
 * folder id (Convex ids carry no hyphen) or a system role.
 *
 * `?in=<mailboxId>` narrows the list to one mailbox, `?provider=<key>` to the
 * mailboxes of one provider (see `mailboxProviderKey`), and, in All inboxes
 * only, `?category=<key>` to one smart-inbox category, the filter the links
 * from Today and the Workbench carry. A mailbox narrow wins over a provider
 * narrow, so a link never asks for both.
 */

/** The system folder roles (`mailFolders.role`), in rail order. */
export const UNIFIED_FOLDER_ROLES = [
	'inbox',
	'sent',
	'drafts',
	'archive',
	'spam',
	'trash',
] as const;
export type UnifiedFolderRole = (typeof UNIFIED_FOLDER_ROLES)[number];

const SEGMENT_BY_ROLE: Readonly<Record<UnifiedFolderRole, string>> = {
	inbox: 'all-inboxes',
	sent: 'all-sent',
	drafts: 'all-drafts',
	archive: 'all-archive',
	spam: 'all-spam',
	trash: 'all-trash',
};
const ROLE_BY_SEGMENT = new Map(
	Object.entries(SEGMENT_BY_ROLE).map(([role, segment]) => [segment, role as UnifiedFolderRole])
);

export const ALL_INBOXES_FOLDER = SEGMENT_BY_ROLE.inbox;
export const ALL_INBOXES_PATH = `/dashboard/postbox/${ALL_INBOXES_FOLDER}`;

/** The route segment of a unified folder: `all-sent` for Sent. */
export function unifiedFolderSegment(role: UnifiedFolderRole): string {
	return SEGMENT_BY_ROLE[role];
}

/** The role a `[folder]` segment shows across mailboxes, or null for any other folder route. */
export function unifiedFolderRole(param: string | string[] | undefined): UnifiedFolderRole | null {
	return typeof param === 'string' ? (ROLE_BY_SEGMENT.get(param) ?? null) : null;
}

export function isAllInboxesFolder(param: string | string[] | undefined): boolean {
	return param === ALL_INBOXES_FOLDER;
}

/** True on any unified folder route, the list or an open message. */
export function isUnifiedFolderPath(path: string): boolean {
	const match = /^\/dashboard\/postbox\/([^/?#]+)/.exec(path);
	return unifiedFolderRole(match?.[1]) !== null;
}

export interface AllInboxesFilter {
	in?: string | null;
	provider?: string | null;
	category?: string | null;
}

/** The query every unified folder route keeps: `?in=…&category=…`, or ''. */
export function allInboxesQuerySuffix(filter: AllInboxesFilter): string {
	const query = new URLSearchParams();
	if (filter.in) query.set('in', filter.in);
	else if (filter.provider) query.set('provider', filter.provider);
	if (filter.category) query.set('category', filter.category);
	const search = query.toString();
	return search ? `?${search}` : '';
}

/** A unified folder's list, narrowed by mailbox or provider (and, in the Inbox, category). */
export function unifiedFolderHref(role: UnifiedFolderRole, filter: AllInboxesFilter = {}): string {
	const kept = role === 'inbox' ? filter : { ...filter, category: null };
	return `/dashboard/postbox/${SEGMENT_BY_ROLE[role]}${allInboxesQuerySuffix(kept)}`;
}

/** The All inboxes list, narrowed to one inbox and/or one category. */
export function allInboxesHref(filter: AllInboxesFilter = {}): string {
	return unifiedFolderHref('inbox', filter);
}

/** One mailbox's own folder of that role, with its folders around it. */
export function mailboxFolderHref(role: UnifiedFolderRole, mailboxId: string): string {
	return `/dashboard/postbox/${role}?mailbox=${encodeURIComponent(mailboxId)}`;
}

/**
 * Where the old `/dashboard/inboxes` route sends a link: All inboxes with the
 * same filters, or the team inbox for `?in=team`, which named it there.
 */
export function legacyInboxesRedirect(query: Record<string, unknown>): string {
	const only = typeof query['in'] === 'string' ? query['in'] : null;
	const category = typeof query['category'] === 'string' ? query['category'] : null;
	return only === 'team' ? '/dashboard/inbox' : allInboxesHref({ in: only, category });
}

/**
 * Where a mailbox `g` chord goes from a unified folder: the unified folder of
 * that role with the same mailbox or provider narrow, so `g t` in All inboxes
 * is All Sent rather than one mailbox's Sent. Null outside the unified routes.
 */
export function unifiedChordTarget(
	role: UnifiedFolderRole,
	param: string | string[] | undefined,
	filter: AllInboxesFilter
): string | null {
	if (unifiedFolderRole(param) === null) return null;
	return unifiedFolderHref(role, { in: filter.in, provider: filter.provider });
}

/** Hosted here; every connected mailbox is keyed by the IMAP host it syncs from. */
export const OWLAT_PROVIDER = 'owlat';

export interface ProviderSourceRow {
	isConnected?: boolean;
	providerHost?: string | null;
}

/** The provider a mailbox is narrowed under: `owlat`, or its IMAP host. */
export function mailboxProviderKey(row: ProviderSourceRow): string {
	if (!row.isConnected) return OWLAT_PROVIDER;
	return row.providerHost?.trim().toLowerCase() || 'imap';
}

/** IMAP hosts people know by the provider's name. */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
	'imap.gmail.com': 'Gmail',
	'outlook.office365.com': 'Outlook',
	'imap-mail.outlook.com': 'Outlook',
	'imap.mail.me.com': 'iCloud',
	'imap.fastmail.com': 'Fastmail',
	'imap.mail.yahoo.com': 'Yahoo',
};

/**
 * The name a provider key is shown under, or null for the hosted one, whose
 * name is the caller's own copy.
 */
export function providerName(key: string): string | null {
	if (key === OWLAT_PROVIDER) return null;
	return PROVIDER_NAMES[key] ?? key;
}

/** The providers the rows span, in the order they first appear, with how many mailboxes each. */
export function mailboxProviders(
	rows: readonly ProviderSourceRow[]
): { key: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const key = mailboxProviderKey(row);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts].map(([key, count]) => ({ key, count }));
}

/** One folder the merged query reads: the mailbox and its folder of the list's role. */
export interface AllInboxesSource<M extends string = string, F extends string = string> {
	mailboxId: M;
	folderId: F;
}

export interface AllInboxesSourceRow<M extends string, F extends string> extends ProviderSourceRow {
	mailboxId: M;
	folderIds: Readonly<Record<UnifiedFolderRole, F | null>>;
}

export interface AllInboxesNarrow {
	/** One mailbox (`?in=`), or null. Wins over `provider`. */
	only: string | null;
	/** One provider key (`?provider=`), or null. */
	provider: string | null;
}

/** Whether a mailbox row stays in a list narrowed this way. */
export function matchesNarrow(
	row: ProviderSourceRow & { mailboxId: string },
	narrow: AllInboxesNarrow
): boolean {
	if (narrow.only) return row.mailboxId === narrow.only;
	if (narrow.provider) return mailboxProviderKey(row) === narrow.provider;
	return true;
}

/**
 * The sources for the merged query, in the order the mailboxes are listed:
 * every mailbox the narrow keeps whose folder of `role` is known.
 */
export function allInboxesSources<M extends string, F extends string>(
	rows: readonly AllInboxesSourceRow<M, F>[],
	role: UnifiedFolderRole,
	narrow: AllInboxesNarrow
): AllInboxesSource<M, F>[] {
	const out: AllInboxesSource<M, F>[] = [];
	for (const row of rows) {
		const folderId = row.folderIds[role];
		if (!folderId || !matchesNarrow(row, narrow)) continue;
		out.push({ mailboxId: row.mailboxId, folderId });
	}
	return out;
}
