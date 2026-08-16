/**
 * Pure toast-copy builders for the Review Queue's bulk actions (piece C2).
 * The bulk mutations return one outcome PER id (never throwing on partial
 * failure — decision D6), and these keep the partial results honest in one
 * shared line: "8 approved, 2 held — Dana is replying, 1 had no draft".
 * Split out of the composable so the copy is unit-testable without Convex.
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

const count = (n: number, label: string) => `${n} ${label}`;

/** "8 approved" | "8 approved, 2 held — Dana is replying, 1 had no draft, 1 no longer in the queue" */
export function summarizeBulkApprove(outcomes: BulkApproveOutcome[]): string {
	const approved = outcomes.filter((o) => o.outcome === 'approved').length;
	const held = outcomes.filter((o) => o.outcome === 'reply_in_progress');
	const noDraft = outcomes.filter((o) => o.outcome === 'no_draft').length;
	const gone = outcomes.filter((o) => o.outcome === 'not_found').length;

	const parts = [count(approved, 'approved')];
	if (held.length > 0) {
		// One teammate → name them; several → keep it collective.
		const names = [...new Set(held.map((o) => o.heldByName).filter(Boolean))];
		const who = names.length === 1 ? `${names[0]} is replying` : 'teammates are replying';
		parts.push(`${count(held.length, 'held')} — ${who}`);
	}
	if (noDraft > 0) parts.push(`${noDraft} had no draft`);
	if (gone > 0) parts.push(`${gone} no longer in the queue`);
	return parts.join(', ');
}

/** "8 rejected" | "8 rejected, 2 no longer in the queue" */
export function summarizeBulkReject(outcomes: BulkRejectOutcome[]): string {
	const rejected = outcomes.filter((o) => o.outcome === 'rejected').length;
	const gone = outcomes.filter((o) => o.outcome === 'not_found').length;
	const parts = [count(rejected, 'rejected')];
	if (gone > 0) parts.push(`${gone} no longer in the queue`);
	return parts.join(', ');
}

/**
 * Undo-all result line, mirroring the single-approve undo copy: a full undo
 * confirms the drafts are back, a partial one names how many were too late,
 * and an entirely-too-late undo is the honest "already on their way".
 */
export function summarizeBulkUndo(outcomes: BulkUndoOutcome[]): {
	text: string;
	allCancelled: boolean;
} {
	const cancelled = outcomes.filter((o) => o.cancelled).length;
	const missed = outcomes.length - cancelled;
	if (missed === 0) {
		return {
			text:
				cancelled === 1
					? 'Approval undone — the draft is back in the queue'
					: `Approvals undone — ${cancelled} drafts are back in the queue`,
			allCancelled: true,
		};
	}
	if (cancelled === 0) {
		return {
			text:
				missed === 1
					? 'Too late to undo — the reply is already on its way'
					: 'Too late to undo — the replies are already on their way',
			allCancelled: false,
		};
	}
	return {
		text: `${cancelled} approval${cancelled === 1 ? '' : 's'} undone — ${missed} already sent`,
		allCancelled: false,
	};
}
