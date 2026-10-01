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
 * The scan is bounded by BYTES before any row is loaded, not only by rows: a
 * `_scheduled_functions` row carries its function's arguments (up to 4 MiB
 * each; some producers schedule whole message bodies), so 200 rows can outgrow
 * the 16 MiB a transaction may read. Each page asks Convex to stop at
 * `SCHEDULER_SCAN_BYTES`, which it can overshoot by at most the one row it was
 * reading: 8 MiB + 4 MiB of arguments stays well inside the limit. A page
 * stopped that way (`SplitRequired`) may be incomplete, so the scan cancels
 * what it got (cancelling is idempotent), keeps its position and re-reads with
 * fewer rows; a one-row page is always complete, so the scan never stalls. A
 * transaction that fails anyway (`recordFailure` in walker.ts) shrinks the
 * page as well, down to one row, instead of retrying the same read.
 *
 * Progress is saved on the job's progress row: `scheduledAfter` (everything
 * created up to that `_creationTime` has been inspected), the paginate cursor
 * inside the range after it, and the page size.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';
import { isTransactionLimitError } from '../../lib/convexLimitErrors';

/** Rows one scan page asks for at most. */
export const SCHEDULER_SCAN_PAGE = 200;
/** Bytes after which Convex stops a scan page (see above for the headroom). */
export const SCHEDULER_SCAN_BYTES = 8 * 1024 * 1024;
/**
 * How far before the newest row a finished pass saw the next pass restarts.
 * `_creationTime` is not commit order: a row committed after the pass read
 * past it can carry an equal or earlier time (a concurrent transaction, or one
 * that began before the newest row and committed after the read). A mutation
 * runs for about a second at most, so a few seconds covers it; rows re-read in
 * the overlap are stepped over or cancelled again, both harmless.
 */
export const SCHEDULER_RESCAN_MARGIN_MS = 5_000;

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

export type SchedulerScanPosition = Pick<
	Doc<'workspaceDeletionProgress'>,
	'scheduledAfter' | 'scheduledNewest' | 'scheduledCursor' | 'scheduledPageRows'
>;

export interface SchedulerScan {
	/** Where the next page starts, and how many rows it asks for. */
	position: SchedulerScanPosition;
	cancelled: number;
	/** Every row created up to now has been inspected. */
	isDone: boolean;
}

/**
 * The page size to retry with after a scan transaction failed: one row after a
 * limit error (a one-row page always fits, so there is no point stepping down
 * through retries while the workspace is read-only), a quarter otherwise.
 */
export function shrunkPageRows(position: SchedulerScanPosition, error: string): number {
	if (isTransactionLimitError(error)) return 1;
	return Math.max(1, Math.floor((position.scheduledPageRows ?? SCHEDULER_SCAN_PAGE) / 4));
}

/**
 * Cancel one byte-bounded page of pending scheduled functions, except the
 * survivors. Rows already running, finished or cancelled are only stepped
 * over. Uses the transaction's one `.paginate()`.
 */
export async function cancelPendingScheduledFunctions(
	ctx: MutationCtx,
	position: SchedulerScanPosition
): Promise<SchedulerScan> {
	const { scheduledAfter: after, scheduledCursor: cursor } = position;
	const pageRows = position.scheduledPageRows ?? SCHEDULER_SCAN_PAGE;
	const page = await ctx.db.system
		.query('_scheduled_functions')
		.withIndex('by_creation_time', (q) => (after === undefined ? q : q.gt('_creationTime', after)))
		.paginate({
			cursor: cursor ?? null,
			numItems: pageRows,
			maximumBytesRead: SCHEDULER_SCAN_BYTES,
		});
	let cancelled = 0;
	for (const job of page.page) {
		if (job.state.kind !== 'pending' || isSurvivingScheduledFunction(job.name)) continue;
		await ctx.scheduler.cancel(job._id);
		cancelled += 1;
	}

	// Cut short at the byte bound: possibly incomplete, so stay put and ask for
	// fewer rows. A page of one row is complete however it was stopped.
	if (page.pageStatus === 'SplitRequired' && page.page.length > 1) {
		return {
			position: { ...position, scheduledPageRows: Math.floor(page.page.length / 2) },
			cancelled,
			isDone: false,
		};
	}
	const grown = Math.min(SCHEDULER_SCAN_PAGE, pageRows * 2);
	// Carried across the pass's pages: its last page is often empty.
	const newest = page.page[page.page.length - 1]?._creationTime ?? position.scheduledNewest;
	if (page.isDone) {
		// Restart the next scan (verification's) with a fresh cursor, since a
		// cursor at the end of a range never sees rows added after it, and a
		// margin before the newest row seen (see SCHEDULER_RESCAN_MARGIN_MS). A
		// pass that saw no row keeps its start.
		return {
			position: {
				scheduledAfter: newest === undefined ? after : newest - SCHEDULER_RESCAN_MARGIN_MS,
				scheduledNewest: undefined,
				scheduledCursor: undefined,
				scheduledPageRows: grown,
			},
			cancelled,
			isDone: true,
		};
	}
	return {
		position: {
			scheduledAfter: after,
			scheduledNewest: newest,
			scheduledCursor: page.continueCursor,
			scheduledPageRows: grown,
		},
		cancelled,
		isDone: false,
	};
}
