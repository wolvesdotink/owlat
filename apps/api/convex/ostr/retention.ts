/**
 * Observer retention (plan §7.2), the ~90-day cutoff.
 *
 * This is not housekeeping. An evidence bundle holds the `h=`-signed headers
 * verbatim — Subject and To in practice — and the plan's answer to that is
 * custody plus a deletion date, so a prune that silently stops running is a
 * privacy regression rather than a disk-space one.
 *
 * The report queue ages out on the SAME cutoff, and that coupling is
 * load-bearing in the other direction: a queue row is the durable
 * `ReportDedupeStore` entry for its message, so a report must not survive its
 * bundle (it could then be committed to with nothing left to open at challenge
 * time), and a bundle must not survive its dedupe entry (the same replayed
 * message could be re-admitted). One cutoff, both tables.
 *
 * Batch commitments (§7.2.4) ride the same cutoff from the other end: an
 * opening is answered out of `ostrEvidence`, so a retained hash list whose
 * bundles are gone can only produce a refusal. The plan's challenge deadline
 * (T ≈ 14 days, §7.6) sits well inside 90, so nothing answerable is lost.
 *
 * The submission ledger goes with them: it holds signed attestations, which are
 * public by construction, but a ledger that grows forever is a ledger nobody
 * reads. Rows still owing an acceptance are kept regardless of age — dropping
 * one would quietly abandon evidence this observer said it had published. That
 * is bounded rather than open-ended: `settleSubmission` gives up after
 * `OSTR_MAX_SUBMISSION_ATTEMPTS`, marks the row abandoned, and hands it to this
 * prune, so a permanently unreachable log cannot grow the table forever.
 */

import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { OSTR_EVIDENCE_RETENTION_MS, OSTR_PRUNE_BATCH } from './config';

/**
 * Delete evidence, captured reports and settled submissions past the retention
 * window. Batched and self-rescheduling, like `maintenance/retention.ts`.
 *
 * Unconditional — it does NOT check whether observer mode is on. An operator
 * who switches observer mode off must still have their retained bundles age
 * out; gating the prune on the flag would make "turn it off" the one action
 * that keeps the data forever.
 */
export const pruneObserverData = internalMutation({
	args: {},
	handler: async (ctx): Promise<void> => {
		const cutoff = Date.now() - OSTR_EVIDENCE_RETENTION_MS;

		const [evidence, reports, commitments, submissions] = await Promise.all([
			ctx.db
				.query('ostrEvidence')
				.withIndex('by_created_at', (q) => q.lt('createdAt', cutoff))
				.take(OSTR_PRUNE_BATCH),
			ctx.db
				.query('ostrReportQueue')
				.withIndex('by_created_at', (q) => q.lt('createdAt', cutoff))
				.take(OSTR_PRUNE_BATCH),
			ctx.db
				.query('ostrBatchCommitments')
				.withIndex('by_created_at', (q) => q.lt('createdAt', cutoff))
				.take(OSTR_PRUNE_BATCH),
			ctx.db
				.query('ostrSubmissionLog')
				.withIndex('by_settled_and_created', (q) => q.eq('isSettled', true).lt('createdAt', cutoff))
				.take(OSTR_PRUNE_BATCH),
		]);

		for (const row of [...evidence, ...reports, ...commitments, ...submissions]) {
			await ctx.db.delete(row._id);
		}

		if (
			evidence.length === OSTR_PRUNE_BATCH ||
			reports.length === OSTR_PRUNE_BATCH ||
			commitments.length === OSTR_PRUNE_BATCH ||
			submissions.length === OSTR_PRUNE_BATCH
		) {
			await ctx.scheduler.runAfter(0, internal.ostr.retention.pruneObserverData, {});
		}
	},
});
