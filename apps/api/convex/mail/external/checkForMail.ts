/**
 * "Check for mail": the desktop tray item and the command palette action ask
 * the mail-sync worker to sync the caller's connected accounts now, instead of
 * on its folder timer (apps/mail-sync `POST /sync`).
 *
 * Hosted mailboxes need nothing: their mail is pushed in by the MTA as it
 * arrives. The accounts are those behind every mailbox the caller can read,
 * their personal one and each team inbox they belong to, through the same
 * `loadAccessibleMailboxes` the unread count uses.
 *
 * `request` is an action so it can wait for the worker's answer: the user is
 * told "checking" only when mail-sync took the request.
 */

import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { authedAction } from '../../lib/authedFunctions';
import { assertAnyFeatureEnabled } from '../../lib/featureFlags';
import { rateLimiter } from '../../lib/rateLimiter';
import { getMutationContext } from '../../lib/sessionOrganization';
import { internalMutation } from '../../lib/writeFence';
import { POSTBOX_FEATURE_FLAGS } from '../_helpers';
import { pokeMailSyncCheck } from '../mtaClient';
import { loadAccessibleMailboxes } from '../permissions';
import { CONNECTABLE_ACCOUNT_STATUSES } from './accountShared';

const connectable = new Set<string>(CONNECTABLE_ACCOUNT_STATUSES);

/**
 * `nothing_to_check`: the caller has no connected account (hosted mail only).
 * `rate_limited`: the same person asked a few times in a row, so the request
 * was not passed on. `failed`: mail-sync is not configured, unreachable, or
 * refused the request.
 */
export type CheckForMailStatus = 'checking' | 'failed' | 'nothing_to_check' | 'rate_limited';

/**
 * The accounts to sync, once the rate limit let the request through. Runs as
 * the action's caller, so it carries the same postbox flag floor and member
 * session as a `postboxMutation`.
 */
export const _claim = internalMutation({
	args: {},
	handler: async (
		ctx
	): Promise<
		| { status: 'nothing_to_check' | 'rate_limited' }
		| { status: 'ready'; accountIds: Id<'externalMailAccounts'>[] }
	> => {
		await assertAnyFeatureEnabled(ctx, POSTBOX_FEATURE_FLAGS);
		const session = await getMutationContext(ctx);
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
		if (accountIds.length === 0) return { status: 'nothing_to_check' };
		const { ok } = await rateLimiter.limit(ctx, 'mailCheckNow', { key: session.userId });
		if (!ok) return { status: 'rate_limited' };
		return { status: 'ready', accountIds };
	},
});

// all-members: every member may sync the accounts behind the mailboxes they can already read; `_claim` resolves them for the caller's own session.
export const request = authedAction({
	args: {},
	handler: async (ctx): Promise<{ status: CheckForMailStatus }> => {
		const claim = await ctx.runMutation(internal.mail.external.checkForMail._claim, {});
		if (claim.status !== 'ready') return { status: claim.status };
		const accepted = await pokeMailSyncCheck(claim.accountIds);
		return { status: accepted ? 'checking' : 'failed' };
	},
});
