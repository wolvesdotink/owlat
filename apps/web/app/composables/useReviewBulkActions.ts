/**
 * Bulk approve / reject wiring for the Review Queue browse list (piece C2).
 *
 * Runs the batch mutations (`inbox/bulkMutations.ts`) against the current
 * selection, keeps the optimistic row-hiding honest per id (only rows whose
 * outcome really removed them from the queue stay hidden), and arms ONE shared
 * countdown-undo toast for the batch's C1 undo window — its Undo pulls every
 * still-held send back via `undoAutoSends`, reporting partial results ("2
 * approvals undone — 1 already sent") the same way the approve toast does.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	summarizeBulkApprove,
	summarizeBulkReject,
	summarizeBulkUndo,
	type BulkApproveOutcome,
	type BulkRejectOutcome,
	type BulkSummaryClause,
} from '~/utils/reviewBulkSummary';

export function useReviewBulkActions(opts: {
	/** The current selection (message ids). */
	ids: Ref<string[]>;
	clearSelection: () => void;
	/** The browse list's optimistic row hide/restore (usePostboxOptimisticHide). */
	hideRow: (id: string) => void;
	unhideRow: (id: string) => void;
}) {
	const { t } = useI18n();

	const approveOp = useBackendOperation(api.inbox.bulkMutations.approveDrafts, {
		label: () => t('shared.reviewBulkActions.approveDrafts'),
	});
	const rejectOp = useBackendOperation(api.inbox.bulkMutations.rejectDrafts, {
		label: () => t('shared.reviewBulkActions.rejectDrafts'),
	});
	const undoOp = useBackendOperation(api.inbox.bulkMutations.undoAutoSends, {
		label: () => t('shared.reviewBulkActions.undoApprovals'),
	});

	const { arm: armApproveUndo } = useReviewApproveUndo();
	const { showToast } = useToast();

	/**
	 * The summary builders hand back key+params clauses (they are pure); this is
	 * the render boundary that turns them into the one line the toast shows.
	 */
	const summaryLine = (clauses: BulkSummaryClause[]): string =>
		clauses.map((clause) => t(clause.key, clause.params ?? {})).join(', ');

	const isBusy = ref(false);

	/** Undo-all for the batch's shared window: cancel each held send, restore
	 * the rows that really came back, and report the rest honestly. */
	async function undoApprovedBatch(approvedIds: string[]) {
		const result = await undoOp.run({
			inboundMessageIds: approvedIds as Id<'inboundMessages'>[],
		});
		if (result === undefined) return; // categorized failure — already toasted
		for (const outcome of result.outcomes) {
			if (outcome.cancelled) opts.unhideRow(outcome.inboundMessageId);
		}
		const summary = summarizeBulkUndo(result.outcomes);
		showToast(
			t(summary.text.key, summary.text.params ?? {}),
			summary.allCancelled ? 'success' : 'warning'
		);
	}

	async function approveSelected() {
		const ids = [...opts.ids.value];
		if (ids.length === 0 || isBusy.value) return;
		isBusy.value = true;
		// Optimistic: hide the whole selection; per-id outcomes restore the rows
		// that did NOT leave the queue (held / draftless).
		for (const id of ids) opts.hideRow(id);
		try {
			const result = await approveOp.run({
				inboundMessageIds: ids as Id<'inboundMessages'>[],
			});
			if (result === undefined) {
				for (const id of ids) opts.unhideRow(id);
				return;
			}
			const outcomes = result.outcomes as BulkApproveOutcome[];
			const approvedIds: string[] = [];
			for (const outcome of outcomes) {
				if (outcome.outcome === 'approved') approvedIds.push(outcome.inboundMessageId);
				// `not_found` rows left the queue anyway — keep them hidden; the
				// live subscription confirms.
				else if (outcome.outcome !== 'not_found') opts.unhideRow(outcome.inboundMessageId);
			}
			opts.clearSelection();

			const summary = summaryLine(summarizeBulkApprove(outcomes));
			if (result.undo && approvedIds.length > 0) {
				armApproveUndo({
					inboundMessageId: approvedIds[0]!,
					sendAt: result.undo.sendAt,
					label: summary,
					onUndo: () => undoApprovedBatch(approvedIds),
				});
			} else {
				showToast(summary, approvedIds.length > 0 ? 'success' : 'warning');
			}
		} finally {
			isBusy.value = false;
		}
	}

	async function rejectSelected() {
		const ids = [...opts.ids.value];
		if (ids.length === 0 || isBusy.value) return;
		isBusy.value = true;
		for (const id of ids) opts.hideRow(id);
		try {
			const result = await rejectOp.run({
				inboundMessageIds: ids as Id<'inboundMessages'>[],
			});
			if (result === undefined) {
				for (const id of ids) opts.unhideRow(id);
				return;
			}
			// Both outcomes remove the row from the queue's perspective — nothing
			// to restore; the summary still names the rows that were already gone.
			opts.clearSelection();
			showToast(summaryLine(summarizeBulkReject(result.outcomes as BulkRejectOutcome[])));
		} finally {
			isBusy.value = false;
		}
	}

	return { isBusy, approveSelected, rejectSelected };
}
