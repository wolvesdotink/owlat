/**
 * Campaign attention classifier — the single roll-up that decides whether a
 * campaign genuinely needs a human decision, and (if so) what the one inline
 * action should say.
 *
 * The campaign command center opens on "Needs attention" so the operator sees
 * only campaigns that are actually waiting on them — an undecided A/B test, a
 * stopped/failed send, something held for review, or a send that goes out
 * today. Everything else is browsing (All / Drafts / Scheduled / Sent).
 *
 * Precedence (highest first) — a campaign lands in exactly one bucket so the
 * row shows at most one attention chip + at most one inline action:
 *   1. A/B decision   — the test has run and no winner is picked yet.
 *   2. Needs review    — held in review, or its content was blocked.
 *   3. Send stopped    — a cancelled/failed send the operator may want to revive.
 *   4. Going out today  — scheduled for today (or overdue and still scheduled).
 *
 * Copy is human: "Pick winner", "Review", "Resume" — no enum strings, no AI
 * jargon. Pure and clock-injectable so the ordering logic is unit-testable.
 */

import type { CampaignStatus } from '~/composables/useCampaignStatusBadge';

export type CampaignAttentionReason =
	| 'ab_decision'
	| 'needs_review'
	| 'send_stopped'
	| 'scheduled_today';

/** The raw campaign signals the classifier reads (a subset of the list row). */
export interface CampaignAttentionInput {
	status: CampaignStatus;
	scheduledAt?: number | null;
	isABTest?: boolean | null;
	abTestStatus?: 'pending' | 'testing' | 'winner_selected' | null;
	abWinner?: 'A' | 'B' | null;
	contentBlockReason?: string | null;
	/** Injectable clock for deterministic tests. Defaults to `Date.now()`. */
	now?: number;
}

export interface CampaignAttention {
	needsAttention: boolean;
	reason: CampaignAttentionReason | null;
	/** One inline primary-action label, or null when the row is view-only. */
	actionLabel: string | null;
}

/** How one attention reason presents in the UI. */
export interface CampaignAttentionDisplay {
	/** Roll-up chip label shown on the row (the state). */
	chipLabel: string;
	/** Status-dot utility class for the chip. */
	dot: string;
	/** Inline primary-action label (the verb), or null when the row is view-only. */
	actionLabel: string | null;
}

/**
 * The single reason → copy map. Chip label (state) and action label (verb) live
 * together so they can't drift into a near-duplicate ("Pick a winner" chip next
 * to a "Pick winner" button); the classifier and the row both read from here.
 */
export const CAMPAIGN_ATTENTION_DISPLAY: Record<CampaignAttentionReason, CampaignAttentionDisplay> =
	{
		ab_decision: { chipLabel: 'Winner pending', dot: 'bg-brand', actionLabel: 'Pick winner' },
		needs_review: { chipLabel: 'Needs review', dot: 'bg-warning', actionLabel: 'Review' },
		send_stopped: { chipLabel: 'Send stopped', dot: 'bg-error', actionLabel: 'Resume' },
		scheduled_today: { chipLabel: 'Going out today', dot: 'bg-brand', actionLabel: null },
	};

const NOT_NEEDED: CampaignAttention = {
	needsAttention: false,
	reason: null,
	actionLabel: null,
};

/** Build the attention verdict for a reason, taking its action label from the map. */
function needing(reason: CampaignAttentionReason): CampaignAttention {
	return {
		needsAttention: true,
		reason,
		actionLabel: CAMPAIGN_ATTENTION_DISPLAY[reason].actionLabel,
	};
}

/** Exclusive upper bound (ms epoch) of the calendar day containing `now`. */
function endOfLocalDay(now: number): number {
	const d = new Date(now);
	d.setHours(23, 59, 59, 999);
	return d.getTime();
}

/**
 * Classify one campaign into its attention bucket (or none). The first matching
 * rule wins, so the returned reason is the single most-actionable one.
 */
export function classifyCampaignAttention(input: CampaignAttentionInput): CampaignAttention {
	const now = input.now ?? Date.now();

	// 1. An A/B test whose split has run but has no declared winner is the most
	//    actionable state — a human must pick. A `winner_selected` test is done.
	if (
		input.isABTest === true &&
		input.abTestStatus === 'testing' &&
		input.abWinner == null &&
		input.status !== 'draft'
	) {
		return needing('ab_decision');
	}

	// 2. Held for review, or content the scanner blocked — a decision either way.
	if (
		input.status === 'pending_review' ||
		(input.contentBlockReason != null &&
			input.contentBlockReason !== '' &&
			input.status !== 'sent' &&
			input.status !== 'sending')
	) {
		return needing('needs_review');
	}

	// 3. A stopped/failed send the operator may want to revive.
	if (input.status === 'cancelled') {
		return needing('send_stopped');
	}

	// 4. Scheduled for today, or overdue and still scheduled (the cron hasn't
	//    fired yet) — surfaced so it isn't a surprise. View-only; no inline action.
	if (
		input.status === 'scheduled' &&
		input.scheduledAt != null &&
		input.scheduledAt <= endOfLocalDay(now)
	) {
		return needing('scheduled_today');
	}

	return NOT_NEEDED;
}
