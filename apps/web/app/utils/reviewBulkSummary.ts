/**
 * Pure toast-copy builders for the Review Queue's bulk actions (piece C2).
 * The bulk mutations return one outcome PER id (never throwing on partial
 * failure — decision D6), and these keep the partial results honest in one
 * shared line: "8 approved, 2 held — Dana is replying, 1 had no draft".
 * Split out of the composable so the copy is unit-testable without Convex.
 *
 * Nothing here calls `useI18n`: this module is pure, so each clause comes back
 * as an i18n key plus the values it interpolates and the composable runs the
 * pair through `t(key, params)` before joining the line (the convention the
 * other sentence tables under `app/utils` follow).
 */

export interface BulkApproveOutcome {
	inboundMessageId: string;
	outcome: 'approved' | 'no_draft' | 'reply_in_progress' | 'not_found';
	heldByName?: string;
}

export interface BulkRejectOutcome {
	inboundMessageId: string;
	outcome: 'rejected' | 'not_found';
}

export interface BulkUndoOutcome {
	inboundMessageId: string;
	cancelled: boolean;
}

/** One clause of a summary line: an i18n key plus its interpolations. */
export interface BulkSummaryClause {
	key: string;
	params?: Record<string, unknown>;
}

/** "8 approved" | "8 approved, 2 held — Dana is replying, 1 had no draft, 1 no longer in the queue" */
export function summarizeBulkApprove(outcomes: BulkApproveOutcome[]): BulkSummaryClause[] {
	const approved = outcomes.filter((o) => o.outcome === 'approved').length;
	const held = outcomes.filter((o) => o.outcome === 'reply_in_progress');
	const noDraft = outcomes.filter((o) => o.outcome === 'no_draft').length;
	const gone = outcomes.filter((o) => o.outcome === 'not_found').length;

	const parts: BulkSummaryClause[] = [
		{ key: 'shared.reviewBulkSummary.approved', params: { count: approved } },
	];
	if (held.length > 0) {
		// One teammate → name them; several → keep it collective.
		const names = [...new Set(held.map((o) => o.heldByName).filter(Boolean))];
		parts.push(
			names.length === 1
				? {
						key: 'shared.reviewBulkSummary.heldByOne',
						params: { count: held.length, name: names[0] },
					}
				: { key: 'shared.reviewBulkSummary.heldByMany', params: { count: held.length } }
		);
	}
	if (noDraft > 0)
		parts.push({ key: 'shared.reviewBulkSummary.noDraft', params: { count: noDraft } });
	if (gone > 0) parts.push({ key: 'shared.reviewBulkSummary.gone', params: { count: gone } });
	return parts;
}

/** "8 rejected" | "8 rejected, 2 no longer in the queue" */
export function summarizeBulkReject(outcomes: BulkRejectOutcome[]): BulkSummaryClause[] {
	const rejected = outcomes.filter((o) => o.outcome === 'rejected').length;
	const gone = outcomes.filter((o) => o.outcome === 'not_found').length;
	const parts: BulkSummaryClause[] = [
		{ key: 'shared.reviewBulkSummary.rejected', params: { count: rejected } },
	];
	if (gone > 0) parts.push({ key: 'shared.reviewBulkSummary.gone', params: { count: gone } });
	return parts;
}

/**
 * Undo-all result line, mirroring the single-approve undo copy: a full undo
 * confirms the drafts are back, a partial one names how many were too late,
 * and an entirely-too-late undo is the honest "already on their way".
 */
export function summarizeBulkUndo(outcomes: BulkUndoOutcome[]): {
	text: BulkSummaryClause;
	allCancelled: boolean;
} {
	const cancelled = outcomes.filter((o) => o.cancelled).length;
	const missed = outcomes.length - cancelled;
	if (missed === 0) {
		return {
			text:
				cancelled === 1
					? { key: 'shared.reviewBulkSummary.undoneOne' }
					: { key: 'shared.reviewBulkSummary.undoneMany', params: { count: cancelled } },
			allCancelled: true,
		};
	}
	if (cancelled === 0) {
		return {
			text:
				missed === 1
					? { key: 'shared.reviewBulkSummary.tooLateOne' }
					: { key: 'shared.reviewBulkSummary.tooLateMany' },
			allCancelled: false,
		};
	}
	return {
		text: {
			key:
				cancelled === 1
					? 'shared.reviewBulkSummary.undonePartialOne'
					: 'shared.reviewBulkSummary.undonePartialMany',
			params: { cancelled, missed },
		},
		allCancelled: false,
	};
}
