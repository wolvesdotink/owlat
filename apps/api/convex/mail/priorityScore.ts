/**
 * Reply Queue priority scoring — a single continuous score that blends WHO
 * sent a message (deterministic sender importance) with the LLM's content
 * urgency, so ranking is no longer "urgency bucket, then age".
 *
 * Pure + framework-free (no Convex/Vue imports) so the ordering contract is
 * unit-testable and shareable. The persisted score is TIME-INVARIANT (it folds
 * in urgency + sender importance only); message age is applied by the client
 * comparator as a tiebreak, so a stored score never goes stale.
 *
 * Deterministic sender importance is the COLD-START baseline: before (or
 * without) any LLM refinement, a message from a VIP or a frequently-mailed
 * contact already outranks a stranger. The LLM urgency then nudges it.
 */

export type PriorityUrgency = 'high' | 'normal' | 'low';

/**
 * The deterministic "how much does this sender matter to me" signal, derived
 * from the personal address book (mailContacts) + explicit owner overrides.
 * Every field is optional so an unknown first-time sender scores as a stranger.
 */
export interface SenderSignal {
	/** Explicit per-contact VIP flag the owner set — the strongest signal. */
	isVip?: boolean;
	/** The address is in the personal address book (a known correspondent). */
	isKnownContact?: boolean;
	/** Frecency score (contactFrecencyScore): recency × frequency, ~10..150. */
	frecency?: number;
	/** The owner explicitly accepted this sender through the HEY-style screener. */
	accepted?: boolean;
}

/** Content-urgency weight — the LLM's 3-bucket urgency mapped to a number. */
const URGENCY_WEIGHT: Record<PriorityUrgency, number> = { high: 100, normal: 50, low: 20 };

/** Person baseline once an address is a known correspondent (before frecency). */
const KNOWN_CONTACT_BASE = 30;
/** Frecency multiplier + cap — a runaway useCount can't drown out being a VIP. */
const FRECENCY_WEIGHT = 0.4;
const FRECENCY_CAP = 50;
/** Small bump for a sender the owner accepted through the screener. */
const ACCEPTED_BONUS = 10;

/** Relative weight of WHO (importance) vs WHAT (urgency) in the blended score. */
const IMPORTANCE_WEIGHT = 0.6;
const URGENCY_BLEND_WEIGHT = 0.4;

/**
 * Deterministic sender-importance component, 0..100. An explicit VIP flag
 * saturates it (dominates every frecency/urgency combination for a non-VIP);
 * otherwise it accrues from being a known person + how frecent they are + an
 * accepted-through-screener bump. Pure/deterministic.
 */
export function senderImportanceScore(signal: SenderSignal): number {
	if (signal.isVip) return 100;
	let score = 0;
	if (signal.isKnownContact) score += KNOWN_CONTACT_BASE;
	score += Math.min(FRECENCY_CAP, Math.max(0, signal.frecency ?? 0) * FRECENCY_WEIGHT);
	if (signal.accepted) score += ACCEPTED_BONUS;
	return Math.min(100, Math.round(score));
}

/**
 * The unified cross-thread priority score (higher ranks first). Blends the
 * deterministic sender importance with the LLM's content urgency so a terse
 * note from a critical contact outranks a wordy ask from a stranger. Pure and
 * time-invariant — the client comparator adds age as a tiebreak.
 */
export function computePriorityScore(opts: {
	urgency: PriorityUrgency;
	sender: SenderSignal;
}): number {
	const importance = senderImportanceScore(opts.sender);
	const urgency = URGENCY_WEIGHT[opts.urgency];
	return Math.round(importance * IMPORTANCE_WEIGHT + urgency * URGENCY_BLEND_WEIGHT);
}

/**
 * HEY-style screener gate: when the owner has turned the first-time-sender
 * screener ON, hold an unknown/unaccepted sender OUT of the Reply Queue and
 * clarification loop until they accept them. A VIP, a known correspondent, or
 * a sender the owner already accepted always passes. Fail-open: with the
 * screener OFF this is a no-op, so it never changes today's behaviour.
 */
export function isScreenedOut(opts: {
	screenerEnabled: boolean;
	sender: SenderSignal;
}): boolean {
	if (!opts.screenerEnabled) return false;
	const s = opts.sender;
	if (s.isVip || s.accepted || s.isKnownContact) return false;
	return true;
}

/** Fallback score for a row without a persisted priorityScore (pre-migration
 * rows / follow-ups): map its urgency bucket alone. Keeps the comparator total
 * even before every row has been re-scored. */
export function urgencyFallbackScore(urgency: PriorityUrgency): number {
	return URGENCY_WEIGHT[urgency];
}
