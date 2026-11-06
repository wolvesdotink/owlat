/**
 * "Check for mail": the desktop tray item and the command palette action ask
 * the mail-sync worker to sync the caller's connected accounts now, instead of
 * on its folder timer (apps/mail-sync `POST /sync`).
 *
 * Hosted mailboxes need nothing: their mail is pushed in by the MTA as it
 * arrives. The accounts are those behind every mailbox the caller can read,
 * their personal one and each team inbox they belong to, through the same
 * `loadAccessibleMailboxes` the unread count uses.
 */

import { v } from 'convex/values';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { internalAction } from '../../_generated/server';
import { rateLimiter } from '../../lib/rateLimiter';
import { postboxMutation } from '../_helpers';
import { pokeMailSyncCheck } from '../mtaClient';
import { loadAccessibleMailboxes } from '../permissions';
import { CONNECTABLE_ACCOUNT_STATUSES } from './accountShared';

const connectable = new Set<string>(CONNECTABLE_ACCOUNT_STATUSES);

/**
 * `accounts` is how many connected accounts the request covers, so the client
 * can say there is nothing to check. `throttled` means the request was not
 * passed on, because the same person asked a few times in a row.
 */
// all-members: every member may sync the accounts behind the mailboxes they can already read.
export const request = postboxMutation({
	args: {},
	handler: async (ctx, _args, session): Promise<{ accounts: number; throttled?: true }> => {
		const mailboxes = await loadAccessibleMailboxes(
			ctx,
			session.userId,
			session.activeOrganizationId
		);
		const accountIds: Id<'externalMailAccounts'>[] = [];
		for (const mailbox of mailboxes) {
			if (mailbox.status !== 'active' || mailbox.kind !== 'external') continue;
			if (!mailbox.externalAccountId) continue;
			const account = await ctx.db.get(mailbox.externalAccountId);
			if (!account || !connectable.has(account.status)) continue;
			accountIds.push(account._id);
		}
		if (accountIds.length === 0) return { accounts: 0 };
		const { ok } = await rateLimiter.limit(ctx, 'mailCheckNow', { key: session.userId });
		if (!ok) return { accounts: accountIds.length, throttled: true };
		await ctx.scheduler.runAfter(0, internal.mail.external.checkForMail.wakeWorker, {
			accountIds,
		});
		return { accounts: accountIds.length };
	},
});

export const wakeWorker = internalAction({
	args: { accountIds: v.array(v.id('externalMailAccounts')) },
	handler: async (_ctx, args): Promise<void> => {
		await pokeMailSyncCheck(args.accountIds);
	},
});
