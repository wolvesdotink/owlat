/**
 * Which external account is the caller's OWN mailbox.
 *
 * Every personal-external surface (the connected-mailbox card, disconnect,
 * purge, reconnect, the sending switch, the move flow, the personal import)
 * resolves the caller's account through here, so they all agree on one rule:
 * an account is personal when its MAILBOX is (`mailboxes.scope`). The account
 * row carries no sharing flag of its own, which is what lets a personal mailbox
 * become a team inbox (`mail/teamInboxConversion.ts`) with a single write.
 */

import type { QueryCtx, MutationCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';
import { mailboxScope } from '../mailbox/shared';

/**
 * Is this account the connecting user's own PERSONAL mailbox?
 *
 * Read off the account's mailbox (`mailboxes.scope`), the one field that says
 * whether a mailbox is someone's own or org infrastructure. A team inbox backed
 * by this account, or a deliverability SEED the operator connects so Owlat can
 * mail itself, is never the caller's personal inbox, so it must not mask one,
 * block a connect, or appear on a personal surface. An account whose mailbox row
 * is gone has nothing personal left to show.
 */
async function isPersonalAccount(
	ctx: QueryCtx | MutationCtx,
	a: Doc<'externalMailAccounts'>
): Promise<boolean> {
	if (a.purpose === 'seed') return false;
	const mailbox = await ctx.db.get(a.mailboxId);
	return mailbox !== null && mailboxScope(mailbox) === 'personal';
}

/**
 * Does this account belong to the ORG rather than to the member who connected
 * it? True for a deliverability seed (`purpose: 'seed'`) and for any account
 * whose mailbox is a team inbox or a seed.
 *
 * The GDPR paths ask this rather than {@link isPersonalAccount}, because they
 * must keep treating an account as the member's own after its mailbox row is
 * gone: member erasure deletes the personal mailbox before it reaches the
 * credential rows, and a subject-access export still owes the member an
 * account whose mailbox was purged. So only positive evidence of org ownership
 * keeps a row out, and every other account the member connected is theirs.
 */
export async function isOrgInfrastructureAccount(
	ctx: QueryCtx | MutationCtx,
	account: Doc<'externalMailAccounts'>
): Promise<boolean> {
	if (account.purpose === 'seed') return true;
	const mailbox = await ctx.db.get(account.mailboxId);
	return mailbox !== null && mailboxScope(mailbox) !== 'personal';
}

/** The subset of `accounts` that are personal, in their original order. */
export async function personalAccounts(
	ctx: QueryCtx | MutationCtx,
	accounts: Array<Doc<'externalMailAccounts'>>
): Promise<Array<Doc<'externalMailAccounts'>>> {
	const personal = await Promise.all(accounts.map((a) => isPersonalAccount(ctx, a)));
	return accounts.filter((_, i) => personal[i]);
}

/**
 * The user's single LIVE *personal* external account — the one still
 * connected/syncing that they own 1:1.
 *
 * A user has at most one non-`disconnected` personal account (the connect guard
 * enforces it), but a completed "move my mailbox here" leaves a `disconnected`
 * archive row behind that COEXISTS with a freshly-connected account. `by_user` +
 * `.first()` returns the OLDEST row, so after a move it hands back the archive
 * and the live account is missed. Resolve by state instead: skip `disconnected`
 * rows and return the (unique) live one, or `null` when none is live.
 *
 * Accounts behind a team inbox are excluded: their `userId` records the admin
 * who connected them, but they are org infrastructure governed by
 * `mailboxMembers`, so a team inbox can never mask, block, or be mistaken for a
 * user's own mailbox.
 */
export async function getLivePersonalExternalAccountForUser(
	ctx: QueryCtx | MutationCtx,
	userId: string
): Promise<Doc<'externalMailAccounts'> | null> {
	const accounts = await ctx.db
		.query('externalMailAccounts')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.collect(); // bounded: ≤ 1 live personal + a handful of archived/shared rows per user
	const live = accounts.filter((a) => a.status !== 'disconnected');
	return (await personalAccounts(ctx, live))[0] ?? null;
}

/**
 * The mailbox this caller DISCONNECTED on `address`, if there is one — the row a
 * reconnect re-attaches to instead of provisioning a second mailbox on the same
 * address.
 *
 * Soft-disconnect keeps the synced mail; without this lookup that promise is
 * empty, because the dup-check below only sees ACTIVE mailboxes, so reconnecting
 * would mint a fresh empty mailbox and strand every retained message in a row no
 * screen can reach. Deliberately narrow: the caller's own PERSONAL account, the
 * same canonical address, and a mailbox that is soft-deleted. A completed move's
 * archive keeps its mailbox ACTIVE, so it can never be resurrected here, and a
 * shared team inbox or a seed is not a personal account at all.
 */
export async function findRetainedPersonalAccount(
	ctx: QueryCtx | MutationCtx,
	userId: string,
	options: { address?: string; forDeletion?: boolean } = {}
): Promise<{ account: Doc<'externalMailAccounts'>; mailbox: Doc<'mailboxes'> } | null> {
	const { address, forDeletion = false } = options;
	const rows = await ctx.db
		.query('externalMailAccounts')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.collect(); // bounded: a handful of the caller's own account rows
	const candidates = (await personalAccounts(ctx, rows))
		.filter(
			(a) =>
				a.status === 'disconnected' &&
				// A purge is already deleting this one: it has no mail to hand back,
				// and re-attaching it would hand the owner a mailbox the cascade is
				// about to delete underneath them.
				a.purgeStartedAt === undefined &&
				// An admin retired this mailbox. Reconnecting must not undo that
				// silently — but DELETING it must stay possible, or an admin removal
				// would strand the owner's mail somewhere neither of them can reach:
				// the admin has no purge for a personal mailbox, and the owner would
				// have no surface for it.
				(forDeletion || a.adminRetiredAt === undefined)
		)
		.sort((a, b) => b.updatedAt - a.updatedAt);
	for (const account of candidates) {
		const mailbox = await ctx.db.get(account.mailboxId);
		// Ownership follows the ACCOUNT (read through `by_user` on the caller, and
		// personal by `isPersonalAccount`), which is 1:1 with its mailbox — so there
		// is no second ownership question to ask here. The one write that can move a
		// mailbox's `userId` out from under its account row,
		// `mailboxMembers.transferOwnership`, refuses anything that is not
		// `scope === 'shared'`, and a shared mailbox is not personal. What is asked
		// is the state: only a soft-deleted external mailbox is one a disconnect
		// left behind.
		if (!mailbox || mailbox.status !== 'deleted' || mailbox.kind !== 'external') continue;
		if (address !== undefined && mailbox.address !== address) continue;
		return { account, mailbox };
	}
	return null;
}
