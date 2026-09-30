/**
 * Quiescing the scheduler for a workspace deletion.
 *
 * The write fence refuses writes while the deletion runs, but a function
 * scheduled BEFORE it (a send-later, a snooze wake-up, an automation wait, a
 * retry with a long backoff) can fire after the deletion completed and the
 * fence came down, and write into the emptied workspace. This deployment holds
 * exactly one workspace (lib/sessionOrganization.ts), so every pending
 * scheduled function belongs to the workspace being deleted: the job cancels
 * them when it starts, and re-scans during verification for anything scheduled
 * since (a fenced mutation may still schedule without writing).
 *
 * The scan is bounded: one page of `_scheduled_functions` per transaction,
 * resumed from the `_creationTime` cursor saved on the job's progress row.
 */

import type { MutationCtx } from '../../_generated/server';

/** `_scheduled_functions` rows one quiesce transaction inspects. */
export const SCHEDULER_SCAN_PAGE = 200;

/**
 * Scheduled functions that must survive the deletion: an exact
 * `<module path>:<export>`, or a `<directory>/` prefix for a whole family.
 * `workspaceDeletionLifecycle.test.ts` resolves every entry against the real
 * modules, so renaming a survivor fails a test instead of silently getting it
 * cancelled.
 *
 *   - the deletion's own chain (drive, its retries);
 *   - the provider-side release of a removed sending domain, which the
 *     `domains` step itself schedules and which writes nothing;
 *   - member erasure, which closes a non-owner's account deletion (it only
 *     removes that user's rows outside the sweep while a deletion runs);
 *   - the mail to an account holder whose account is being deleted;
 *   - instance key material (Sealed Mail `keyVault`), which is outside the
 *     sweep;
 *   - the push of the inbound TLS policy to the MTA, which is instance
 *     infrastructure, not workspace data.
 */
export const SURVIVING_SCHEDULED_FUNCTIONS: readonly string[] = [
	'workspaces/deletion/',
	'domains/providers/registerAction:deleteDomainAction',
	'auth/memberErasure:eraseMemberData',
	'accountDeletionEmail:sendAccountDeletionEmail',
	'e2ee/',
	'mail/mailboxActions:pushInboundTlsPolicy',
];

/** `workspaces/deletion/walker.js:drive` and `…/walker:drive` read the same. */
function functionPath(name: string): string {
	return name.replace(/\.js(?=:)/, '');
}

export function isSurvivingScheduledFunction(name: string): boolean {
	const path = functionPath(name);
	return SURVIVING_SCHEDULED_FUNCTIONS.some((prefix) => path.startsWith(prefix));
}

export interface SchedulerScan {
	/** `_creationTime` of the last row inspected; unchanged when none was. */
	cursor: number | undefined;
	cancelled: number;
	/** The page came back short: nothing newer is left to inspect. */
	isDone: boolean;
}

/**
 * Cancel one page of pending scheduled functions created after `cursor`,
 * except the survivors. Rows already running, finished or cancelled are only
 * stepped over.
 */
export async function cancelPendingScheduledFunctions(
	ctx: MutationCtx,
	cursor: number | undefined
): Promise<SchedulerScan> {
	const page = await ctx.db.system
		.query('_scheduled_functions')
		.withIndex('by_creation_time', (q) =>
			cursor === undefined ? q : q.gt('_creationTime', cursor)
		)
		.take(SCHEDULER_SCAN_PAGE);
	let cancelled = 0;
	for (const job of page) {
		if (job.state.kind !== 'pending' || isSurvivingScheduledFunction(job.name)) continue;
		await ctx.scheduler.cancel(job._id);
		cancelled += 1;
	}
	return {
		cursor: page[page.length - 1]?._creationTime ?? cursor,
		cancelled,
		isDone: page.length < SCHEDULER_SCAN_PAGE,
	};
}
