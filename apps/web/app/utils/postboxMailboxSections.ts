/**
 * Postbox sidebar mailbox grouping.
 *
 * Splits the mailboxes a user can reach into their PERSONAL mailbox(es) and the
 * shared TEAM inboxes they belong to, so the sidebar can render a distinct
 * "Team" section (LOCKED decision 7 of the 2026-07-10 experience plan: a team
 * inbox is a `mailboxes` row with `scope='shared'` governed by explicit
 * membership). Pure so the derivation is unit-testable without mounting the
 * Convex-backed sidebar.
 *
 * `scope` is optional on the row: undefined ⇒ personal (back-compat for every
 * pre-shared-inbox mailbox), so a user with only their own mailbox yields an
 * empty `team` list and the sidebar leaves personal behaviour untouched.
 */

export interface PostboxSidebarMailbox {
	_id: string;
	address: string;
	displayName?: string;
	scope?: 'personal' | 'shared';
}

export interface PostboxSidebarSections<T extends PostboxSidebarMailbox> {
	personal: T[];
	team: T[];
}

/** True when the mailbox is a shared (team) inbox. */
export function isSharedMailbox(mailbox: PostboxSidebarMailbox): boolean {
	return mailbox.scope === 'shared';
}

/**
 * Group accessible mailboxes into personal vs team, each sorted by their
 * display label (falling back to the address) so the sidebar order is stable
 * regardless of query result ordering.
 */
export function derivePostboxSidebarSections<T extends PostboxSidebarMailbox>(
	mailboxes: readonly T[]
): PostboxSidebarSections<T> {
	const byLabel = (a: T, b: T): number =>
		mailboxLabel(a).localeCompare(mailboxLabel(b), undefined, { sensitivity: 'base' });
	const personal = mailboxes
		.filter((m) => !isSharedMailbox(m))
		.slice()
		.sort(byLabel);
	const team = mailboxes.filter(isSharedMailbox).slice().sort(byLabel);
	return { personal, team };
}

/** Human label for a mailbox row — the display name, else the address. */
export function mailboxLabel(mailbox: PostboxSidebarMailbox): string {
	const name = mailbox.displayName?.trim();
	return name && name.length > 0 ? name : mailbox.address;
}
