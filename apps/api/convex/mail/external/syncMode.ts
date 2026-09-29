/**
 * Choosing how far an external mailbox syncs (`externalMailAccounts.syncMode`).
 *
 * 'full' (the default) keeps Owlat and the provider in step both ways
 * (`remoteOps.ts`, `remoteState.ts`). 'incoming' only brings new mail in, for a
 * member who wants to manage the mailbox in Owlat and leave the provider as it
 * is. Switching to 'incoming' drops the write-backs still queued; switching back
 * to 'full' starts over with a merging reconcile (see `remoteState.ts`), so what
 * changed on either side meanwhile is reconciled rather than overwritten.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { Doc } from '../../_generated/dataModel';
import { throwNotFound } from '../../_utils/errors';
import { externalSyncModeValidator, type ExternalSyncMode } from '../../lib/validators/mail';
import { postboxMutation } from '../_helpers';
import { externalMailMutation } from './externalFeature';
import { getLivePersonalExternalAccountForUser } from './personalAccount';
import { requireSharedExternalAccount } from './sharedInbox';
import { nudgeWorker } from './remoteOps';

/** Queued write-backs deleted per step when sync is narrowed to new mail only. */
const DISCARD_BATCH = 200;

async function applySyncMode(
	ctx: MutationCtx,
	account: Doc<'externalMailAccounts'>,
	mode: ExternalSyncMode
): Promise<void> {
	if ((account.syncMode ?? 'full') === mode) return;
	await ctx.db.patch(account._id, {
		syncMode: mode,
		fullSyncAlignedAt: undefined,
		updatedAt: Date.now(),
	});
	if (mode === 'incoming') {
		await ctx.scheduler.runAfter(0, internal.mail.external.syncMode.discardRemoteOps, {
			accountId: account._id,
		});
	}
	// The worker reads the mode every cycle; the nudge starts one now.
	await nudgeWorker(ctx, account._id);
}

/** Set how the caller's own connected mailbox syncs. */
// authz: self — resolves the caller's own live personal external account.
export const setSyncMode = externalMailMutation({
	args: { mode: externalSyncModeValidator },
	handler: async (ctx, args, session) => {
		const account = await getLivePersonalExternalAccountForUser(ctx, session.userId);
		if (!account) throwNotFound('External mail account');
		await applySyncMode(ctx, account, args.mode);
	},
});

/** Set how an external team inbox syncs. */
// authz: requireSharedExternalAccount → requireMailboxAccess(owner) + shared-external gate.
export const setSharedSyncMode = postboxMutation({
	args: { mailboxId: v.id('mailboxes'), mode: externalSyncModeValidator },
	handler: async (ctx, args) => {
		const { account } = await requireSharedExternalAccount(ctx, args.mailboxId);
		await applySyncMode(ctx, account, args.mode);
	},
});

/** Drop the write-backs queued before the account was narrowed to new mail only. */
export const discardRemoteOps = internalMutation({
	args: { accountId: v.id('externalMailAccounts') },
	handler: async (ctx, args) => {
		const account = await ctx.db.get(args.accountId);
		if (!account || account.syncMode !== 'incoming') return;
		const ops = await ctx.db
			.query('externalMailRemoteOps')
			.withIndex('by_account_and_next_attempt', (q) => q.eq('accountId', args.accountId))
			.take(DISCARD_BATCH);
		for (const op of ops) await ctx.db.delete(op._id);
		if (ops.length === DISCARD_BATCH) {
			await ctx.scheduler.runAfter(0, internal.mail.external.syncMode.discardRemoteOps, args);
		}
	},
});
