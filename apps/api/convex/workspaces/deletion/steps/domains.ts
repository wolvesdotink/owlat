import { internal } from '../../../_generated/api';
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
 * `sendingDomainLifecycle.remove` is an `internalMutation`. We invoke
 * it via the generated `internal` API surface rather than importing
 * the handler directly so the call goes through the framework's
 * validator + dispatch (matches the cross-runtime call shape from
 * CONVENTIONS.md).
 */
export const domainsStep = defineStep({
	table: 'domains',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('domains').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			await ctx.runMutation(internal.domains.lifecycle.remove, {
				domainId: row._id,
				userId: 'system',
			});
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
