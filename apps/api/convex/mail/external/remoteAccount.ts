/**
 * Which provider account mirrors a mailbox, and what its synced folders are
 * called there: the lookups write-back (`remoteOps.ts`), its reverse
 * (`remoteState.ts`) and transfers (`remoteAppend.ts`, `../mailboxTransfer.ts`)
 * share. A leaf, so `remoteAppend.ts` can use it without importing
 * `remoteOps.ts` back.
 */

import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';

/** The remote name each mapped local folder of an account syncs with. */
export async function remoteNamesByFolder(
	ctx: QueryCtx,
	accountId: Id<'externalMailAccounts'>
): Promise<Map<Id<'mailFolders'>, string>> {
	const rows = await ctx.db
		.query('externalMailFolderSync')
		.withIndex('by_account', (q) => q.eq('accountId', accountId))
		.collect(); // bounded: one row per synced folder of one account
	return new Map(rows.map((r) => [r.folderId, r.remoteName]));
}

/** An account whose provider is told about local changes: not set to new-mail-only. */
export function writesBack(account: Pick<Doc<'externalMailAccounts'>, 'syncMode'>): boolean {
	return (account.syncMode ?? 'full') === 'full';
}

/**
 * The account whose provider mirrors this mailbox, or null when nothing should
 * be written back: a hosted mailbox, a disconnected or purging account, or a
 * deliverability seed (org infrastructure, never a member's inbox).
 */
export async function liveAccountFor(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>
): Promise<Id<'externalMailAccounts'> | null> {
	const accounts = await ctx.db
		.query('externalMailAccounts')
		.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
		.collect(); // bounded: one live account per mailbox, plus the disconnected ones a re-attach left
	const live = accounts.find(
		(a) => a.status !== 'disconnected' && a.purpose !== 'seed' && a.purgeStartedAt === undefined
	);
	return live && writesBack(live) ? live._id : null;
}

/** Gmail's All Mail, by the names the worker maps to the archive (`apps/mail-sync/src/folders.ts`). */
const ALL_MAIL_NAMES = new Set(['[gmail]/all mail', '[google mail]/all mail']);

/**
 * The mailbox's local folders that mirror Gmail's All Mail. The provider never
 * runs a delete there: the worker retires it, since a message leaves All Mail
 * only through Trash (`apps/mail-sync/src/remoteOps.ts`). The worker mirrors no
 * other `\All` folder, so the name decides. Empty for a mailbox nothing is
 * written back for.
 */
export async function allMailFolderIds(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>
): Promise<Set<Id<'mailFolders'>>> {
	const accountId = await liveAccountFor(ctx, mailboxId);
	if (!accountId) return new Set();
	const names = await remoteNamesByFolder(ctx, accountId);
	return new Set(
		[...names].filter(([, name]) => ALL_MAIL_NAMES.has(name.toLowerCase())).map(([id]) => id)
	);
}
