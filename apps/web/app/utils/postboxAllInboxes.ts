/**
 * All inboxes is a Postbox folder route, `/dashboard/postbox/all-inboxes` and
 * `/dashboard/postbox/all-inboxes/<messageId>`, so the list, the reader and
 * every move between them (j/k, back, auto-advance after an archive) stay in
 * the merged view the same way they stay in one folder: they build their links
 * from the `[folder]` segment. The segment can never be a folder id (Convex
 * ids carry no hyphen) or a system role.
 *
 * `?in=<mailboxId>` narrows the list to one inbox and `?category=<key>` to one
 * smart-inbox category, the two filters the links from Today and the
 * Workbench carry.
 */

export const ALL_INBOXES_FOLDER = 'all-inboxes';
export const ALL_INBOXES_PATH = `/dashboard/postbox/${ALL_INBOXES_FOLDER}`;

export function isAllInboxesFolder(param: string | string[] | undefined): boolean {
	return param === ALL_INBOXES_FOLDER;
}

export interface AllInboxesFilter {
	in?: string | null;
	category?: string | null;
}

/** The query every All inboxes route keeps: `?in=…&category=…`, or ''. */
export function allInboxesQuerySuffix(filter: AllInboxesFilter): string {
	const query = new URLSearchParams();
	if (filter.in) query.set('in', filter.in);
	if (filter.category) query.set('category', filter.category);
	const search = query.toString();
	return search ? `?${search}` : '';
}

/** The All inboxes list, narrowed to one inbox and/or one category. */
export function allInboxesHref(filter: AllInboxesFilter = {}): string {
	return `${ALL_INBOXES_PATH}${allInboxesQuerySuffix(filter)}`;
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

/** One Inbox the merged query reads: the mailbox and its Inbox folder. */
export interface AllInboxesSource<M extends string = string, F extends string = string> {
	mailboxId: M;
	folderId: F;
}

/**
 * The sources for the merged query, in the order the inboxes are listed:
 * every inbox whose Inbox folder is known, or only `only` when it names one
 * of them.
 */
export function allInboxesSources<M extends string, F extends string>(
	rows: readonly { mailboxId: M; inboxFolderId: F | null }[],
	only: string | null
): AllInboxesSource<M, F>[] {
	const out: AllInboxesSource<M, F>[] = [];
	for (const row of rows) {
		if (!row.inboxFolderId || (only && row.mailboxId !== only)) continue;
		out.push({ mailboxId: row.mailboxId, folderId: row.inboxFolderId });
	}
	return out;
}
