/**
 * Countdown-undo toast state for review-queue approvals.
 *
 * A human Approve is now held server-side for `agentConfig.humanApproveUndoDelayMs`
 * (piece C1 / decision D5) with the same cancellable `pendingAutoSend` marker as
 * autonomous sends. This singleton (mirroring usePostboxUndoSend) lets any review
 * surface arm the shared "Approved — Undo (14s)" toast after a successful approve;
 * ReviewApproveUndoToast reads the state, renders the live countdown, and runs the
 * armed surface's undo when clicked — so browse-list rows reappear and the focus
 * flow rewinds through their own inverses, not a second wiring here.
 */

interface ReviewApproveUndoState {
	visible: boolean;
	/** The message whose approve is still inside its undo window. For a BULK
	 * approve (piece C2) this is the first approved id — the armed handler
	 * carries the full batch. */
	inboundMessageId: string | null;
	/** When the held send fires (ms epoch) — drives the countdown. */
	sendAt: number;
	/** Optional partial-result line for a bulk approve ("8 approved, 2 held —
	 * Dana is replying"). Absent for a single approve, which keeps the
	 * original "Approved" copy. */
	label?: string;
}

// The armed surface's undo callback, kept BESIDE the reactive state rather than
// in it (functions don't belong in useState) — the same split useToast keeps
// between its toast list and dismissHandlers. Singleton like the state: arming
// a new approve replaces the previous window's handler.
let undoHandler: (() => void | Promise<void>) | null = null;

export function useReviewApproveUndo() {
	const state = useState<ReviewApproveUndoState>('review:approve-undo', () => ({
		visible: false,
		inboundMessageId: null,
		sendAt: 0,
	}));

	/** Arm the toast for a fresh approve; `onUndo` is the surface's true inverse
	 * (for a bulk approve: undo-all across the batch's shared window). */
	function arm(args: {
		inboundMessageId: string;
		sendAt: number;
		label?: string;
		onUndo: () => void | Promise<void>;
	}) {
		state.value = {
			visible: true,
			inboundMessageId: args.inboundMessageId,
			sendAt: args.sendAt,
			...(args.label !== undefined ? { label: args.label } : {}),
		};
		undoHandler = args.onUndo;
	}

	function dismiss() {
		state.value = { visible: false, inboundMessageId: null, sendAt: 0 };
		undoHandler = null;
	}

	/**
	 * Run the armed undo (the toast's Undo button). Dismisses first so a slow
	 * mutation can't be double-fired from the same window.
	 */
	async function runUndo() {
		const handler = undoHandler;
		dismiss();
		if (handler) await handler();
	}

	return { state, arm, dismiss, runUndo };
}

/**
 * The undo window an approve result carries while the server-side window is
 * open (`approveDraft` returns `undo: { sendAt }` for a positive
 * humanApproveUndoDelayMs). Narrowing helper shared by the review surfaces.
 */
export function approveUndoWindow(result: unknown): { sendAt: number } | undefined {
	if (typeof result !== 'object' || result === null) return undefined;
	const undo = (result as { undo?: { sendAt?: unknown } }).undo;
	return undo && typeof undo.sendAt === 'number' ? { sendAt: undo.sendAt } : undefined;
}

/**
 * The lost-race soft error `approveDraft` returns when the lifecycle edge was
 * refused — a double-click, or a teammate approved/declined the draft first
 * (`{ success: false, reason: 'not_found' }`, the bulk path's `not_found`
 * outcome for a single id). Nothing was scheduled, so a caller that sees this
 * must toast the honest "already handled" line, arm NO undo countdown, and
 * treat the item as gone from the queue rather than as an approval of its own.
 */
export function isApproveAlreadyHandled(result: unknown): boolean {
	if (typeof result !== 'object' || result === null) return false;
	const soft = result as { success?: unknown; reason?: unknown };
	return soft.success === false && soft.reason === 'not_found';
}
