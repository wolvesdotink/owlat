import { removeSendingDomain } from '../../../domains/lifecycle';
import { defineStep, DEFAULT_BATCH_SIZE } from './_common';

/**
 * Delegating step: routes through the **Sending domain lifecycle
 * (module)**'s `remove` entry, which fires the `delete_with_provider`
 * effect — SES.send(DeleteIdentityCommand) or DELETE on the MTA HTTP
 * API depending on `providerType`. Closes drift #4 from ADR-0025
 * (pre-deepening the wipe called `ctx.db.delete(d._id)` directly,
 * orphaning provider-side identity records).
 *
 * `userId: 'system'` because the org-wipe is platform-initiated, not
 * tied to a user. The audit log emitted by the lifecycle lands in
 * `auditLogs`, which is wiped second-to-last; the noise ends inside
 * the wipe.
 *
 * The lifecycle's removal runs INLINE on the walker's context rather than
 * through `ctx.runMutation(internal.domains.lifecycle.remove)`: a nested
 * mutation is built with the fenced builder, and the fence refuses its
 * audit-log write while this very deletion is active. The walker's context is
 * the one writer the fence exempts (lib/writeFence.ts).
 */
export const domainsStep = defineStep({
	table: 'domains',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('domains').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			await removeSendingDomain.handler(ctx, { domainId: row._id, userId: 'system' });
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
