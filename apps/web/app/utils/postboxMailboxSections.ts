/**
 * Postbox sidebar mailbox grouping.
 *
 * Splits the mailboxes a user can reach into their PERSONAL mailbox(es) and the
 * shared TEAM inboxes they belong to, so the sidebar can render a distinct
 * "Team" section (LOCKED decision 7 of the 2026-07-10 experience plan: a team
 * inbox is a `mailboxes` row with `scope='shared'` governed by explicit
 * membership). Operates on the `mail.mailbox.accessible` rows — the caller's
 * accessible+active set with precomputed label/scope/unread — so the switcher,
 * its badges, and the Cmd-K entries all derive from one truth. Pure so the
 * derivation is unit-testable without mounting the Convex-backed sidebar.
 *
 * `scope` is `'personal'` for every non-shared mailbox (the query normalizes the
 * optional row field), so a user with only their own mailbox yields an empty
 * `team` list and the sidebar leaves personal behaviour untouched.
 */

export interface PostboxAccessibleMailbox {
	mailboxId: string;
	label: string;
	scope: 'personal' | 'shared';
	unread: number;
}

export interface PostboxSidebarSections<T extends PostboxAccessibleMailbox> {
	personal: T[];
	team: T[];
}

/** True when the mailbox is a shared (team) inbox. */
export function isSharedMailbox(mailbox: PostboxAccessibleMailbox): boolean {
	return mailbox.scope === 'shared';
}

/**
 * Group accessible mailboxes into personal vs team, each sorted by their label
 * so the sidebar order is stable regardless of query result ordering.
 */
export function derivePostboxSidebarSections<T extends PostboxAccessibleMailbox>(
	mailboxes: readonly T[]
): PostboxSidebarSections<T> {
	const byLabel = (a: T, b: T): number =>
		a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
	const personal = mailboxes
		.filter((m) => !isSharedMailbox(m))
		.slice()
		.sort(byLabel);
	const team = mailboxes.filter(isSharedMailbox).slice().sort(byLabel);
	return { personal, team };
}
