/**
 * Give connected mailboxes the mail-sync worker parked on one refused login
 * another try (migration 0056).
 *
 * ImapFlow reports every NO to LOGIN as an authentication failure, and the
 * worker used to mark the account `auth_error` on the first one — including the
 * refusals a provider sends for passing reasons (Gmail's `[UNAVAILABLE]`, "Too
 * many simultaneous connections", an app password briefly answered with
 * "Invalid credentials"). `auth_error` is not connectable, so such a mailbox —
 * a shared team inbox included — stopped receiving mail until someone
 * re-entered a password that had never changed. The worker now only parks an
 * account once its login has been refused for 15 minutes straight
 * (apps/mail-sync/src/loginFailure.ts).
 *
 *   npx convex run migrations/0056_retry_parked_mail_accounts:run
 *
 * Run it once the worker carrying that change is deployed: every `auth_error`
 * mailbox goes back to `pending` and the worker is woken to connect it. One
 * whose credentials really are wrong is parked again after the grace period;
 * one whose Google authorization was revoked is parked again on its first
 * credential fetch, with the "Reconnect with Google" message restored. Seed
 * mailboxes are left alone: the inbound worker never connects them.
 *
 * Bounded: connected mailboxes per single-org deployment number in the tens.
 * Idempotent: a second run finds nothing parked.
 */

import { internalMutation } from '../lib/writeFence';
import { scheduleWorkerReconcile } from '../mail/external/accountShared';

export const run = internalMutation({
	args: {},
	handler: async (ctx): Promise<{ retried: number }> => {
		const parked = await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_status', (q) => q.eq('status', 'auth_error'))
			.collect(); // bounded: connected mailboxes per deployment (tens)
		const now = Date.now();
		let retried = 0;
		for (const account of parked) {
			if (account.purpose === 'seed') continue;
			await ctx.db.patch(account._id, { status: 'pending', lastError: undefined, updatedAt: now });
			retried += 1;
		}
		if (retried > 0) await scheduleWorkerReconcile(ctx);
		return { retried };
	},
});
