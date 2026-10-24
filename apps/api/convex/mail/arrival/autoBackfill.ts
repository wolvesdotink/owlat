/**
 * Read on arrival: a finished history import starts the
 * mailbox's 30-day interpretation backfill on its own, once.
 *
 * Called from the import's completion mutation (`mail/migrationBackfill.ts
 * completeBackfillImport`). It starts the existing walk
 * (`interpret/backfill.ts startBackfill`, with its caps, the 300-thread
 * pause included) when ALL hold:
 *
 *   - the mailbox is a personal one (shared mailboxes are unchanged);
 *   - it has no `interpretAutoBackfillAt` marker: durable and idempotent, a
 *     second import completion starts nothing;
 *   - the owner has read on arrival on;
 *   - no walk of the mailbox is running, paused or cancelled: a running one
 *     covers it, a pause at a cap stays a safety cap, and a cancellation is
 *     never undone. A completed walk starts over with a new cutoff.
 *
 * The marker is set in the same mutation. No import, no backfill: existing
 * mailboxes are not backfilled automatically.
 *
 * Isolate-safe; not a Convex function.
 */

import type { Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { isPersonalMailbox } from '../permissions';
import { startBackfill } from '../interpret/backfill';
import { isReadOnArrivalOn } from '../interpret/preferences';

export type AutoBackfill = 'started' | 'marked' | 'skipped';

/** Start the backfill after an import, once (see the module doc). */
export async function startAutoBackfillAfterImport(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>
): Promise<AutoBackfill> {
	const mailbox = await ctx.db.get(mailboxId);
	if (!mailbox || !isPersonalMailbox(mailbox)) return 'skipped';
	if (mailbox.interpretAutoBackfillAt !== undefined) return 'skipped';
	if (!(await isReadOnArrivalOn(ctx, mailbox.userId))) return 'skipped';
	await ctx.db.patch(mailboxId, { interpretAutoBackfillAt: Date.now() });
	const job = await ctx.db
		.query('interpretBackfillJobs')
		.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
		.first();
	// A walk already there is left as it is: running, paused at a cap (which
	// stays a safety cap), or cancelled (never undone). A finished one starts over.
	if (job && job.status !== 'completed') return 'marked';
	const { started } = await startBackfill(ctx, mailboxId);
	return started ? 'started' : 'marked';
}
