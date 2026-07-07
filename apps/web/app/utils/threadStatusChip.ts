/**
 * ONE status vocabulary for conversation threads.
 *
 * Every inbox-adjacent surface (team inbox list, thread detail, activity feed,
 * dashboard cards) renders a thread's status through this single roll-up so the
 * language never drifts. It collapses three independent dimensions —
 * `thread.status`, the newest inbound's draft state, and the snooze state —
 * into exactly ONE chip, honouring the Focused-Owlat rule of at most one status
 * chip per row.
 *
 * Precedence (highest first):
 *   1. Resolved  — terminal. `resolved` OR the legacy `closed` (merged to a
 *      single "Resolved" state in the UI; both stay readable in data).
 *   2. Snoozed   — an active snooze outranks any open/draft state.
 *   3. Draft ready — a reviewable agent draft is waiting on a human.
 *   4. Waiting on them — we replied; the ball is in their court.
 *   5. Open      — the default active state.
 *
 * Weight-based emphasis + a single dot per the design system: the chip carries
 * a `variant` that maps to a semantic dot colour, never a large fill. Copy is
 * human ("Waiting on them", "Draft ready") — no enum strings, no AI jargon.
 */

export type ThreadChipVariant = 'success' | 'warning' | 'info' | 'muted';

export interface ThreadStatusChip {
	label: string;
	variant: ThreadChipVariant;
}

/** The raw signals the roll-up reads. Callers pass only what they have. */
export interface ThreadChipInput {
	/** Thread lifecycle status. `closed` is treated as `resolved`. */
	status: 'open' | 'waiting' | 'resolved' | 'closed';
	/**
	 * The thread's latest draft-status projection. `pending` means an agent
	 * draft is ready for human review (inbound `draft_ready`). Absent when no
	 * draft is outstanding.
	 */
	latestDraftStatus?: 'pending' | 'approved' | 'rejected' | 'sent' | null;
	/** Active snooze wake time (ms epoch), if the thread is snoozed. */
	snoozedUntil?: number | null;
	/** Injectable clock for deterministic tests. Defaults to `Date.now()`. */
	now?: number;
}

/**
 * Roll a thread's signals up to exactly one status chip.
 *
 * A `snoozedUntil` in the past is treated as not-snoozed (the wake cron simply
 * hasn't run yet), so the chip never lies about a lapsed snooze.
 */
export function threadStatusChip(input: ThreadChipInput): ThreadStatusChip {
	const now = input.now ?? Date.now();

	// 1. Resolved is terminal — a resolved/closed thread is never shown as
	//    snoozed or draft-ready.
	if (input.status === 'resolved' || input.status === 'closed') {
		return { label: 'Resolved', variant: 'muted' };
	}

	// 2. An active snooze outranks open + draft.
	if (input.snoozedUntil != null && input.snoozedUntil > now) {
		return { label: 'Snoozed', variant: 'info' };
	}

	// 3. A reviewable draft is the most actionable open state.
	if (input.latestDraftStatus === 'pending') {
		return { label: 'Draft ready', variant: 'warning' };
	}

	// 4. We replied and are waiting on them.
	if (input.status === 'waiting') {
		return { label: 'Waiting on them', variant: 'muted' };
	}

	// 5. Default active state.
	return { label: 'Open', variant: 'success' };
}

/**
 * Semantic dot colour class for a chip variant. A dot (not a fill) keeps the
 * chip recessive per the design system; terracotta brand is reserved for
 * primary actions, so `success` uses the green success token, not brand.
 */
export function threadChipDotClass(variant: ThreadChipVariant): string {
	switch (variant) {
		case 'success':
			return 'bg-success';
		case 'warning':
			return 'bg-warning';
		case 'info':
			return 'bg-info';
		case 'muted':
			return 'bg-text-tertiary';
	}
}
