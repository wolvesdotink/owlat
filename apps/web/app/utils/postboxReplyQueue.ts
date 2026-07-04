/**
 * Pure helpers for the Postbox Reply Queue (the "emails waiting on you" task
 * list). Ranking and headline fallback live here — free of Convex/Vue — so
 * the ordering contract is unit-testable.
 */

export type ReplyQueueUrgency = 'high' | 'normal' | 'low';

/** A single clarification question shown on a "Needs your input" card. */
export interface ReplyQueueClarificationQuestion {
	id: string;
	slotType: string;
	text: string;
	/** Provenance + "Owlat will never ask for your password" promise. */
	attribution: string;
	/** Suggested scoped answers rendered as one-tap chips (multiple choice). */
	options?: string[];
	/** The owner's answer — present once answered. */
	answer?: { value: string; at: number };
}

/** The clarification payload on a needs-reply thread (server shape). */
export interface ReplyQueueClarification {
	isNeeded: boolean;
	questions: ReplyQueueClarificationQuestion[];
	askedAt: number;
	answeredAt?: number;
	/** The starter reply produced after answering — flips the card to Draft ready. */
	draft?: string;
}

/** Draft-quality self-check surfaced next to a draft-on-arrival slot. */
export interface ReplyQueueDraftQuality {
	score: number;
	complete: boolean;
	grounded: boolean;
	flags: string[];
}

/**
 * Draft-on-arrival review slot (postbox.aiDraft): a reply pre-generated the
 * moment the message landed, via the SAME shared draft service the B2B agent
 * runs. Surfaced as a "Draft ready — review & send" affordance on the plain
 * needs-you row. HUMAN REVIEW ONLY — its presence never auto-sends.
 */
export interface ReplyQueueDraftSlot {
	/** The pre-generated reply body (options[0] === this). */
	draft: string;
	/** Reply subject (Re: …) composed from the trigger message. */
	draftSubject?: string;
	/** Confidence shown next to the draft (0..1) — the quality self-check score. */
	confidence: number;
	/** Draft-quality self-check; absent when the check failed (shown as unverified). */
	quality?: ReplyQueueDraftQuality;
	/** Alternative pickable drafts (present only on low-confidence / low-quality cases). */
	options?: string[];
	/** When the slot was generated. */
	generatedAt: number;
}

export interface ReplyQueueItem {
	/**
	 * 'needs_reply' — an inbound message waiting on OUR reply (default).
	 * 'followup'   — our sent message whose "remind me if no reply" deadline
	 *                passed; we're waiting on THEM.
	 */
	kind?: 'needs_reply' | 'followup';
	/** Who we're waiting on (follow-up items only) — the first recipient. */
	waitingOn?: string;
	threadId: string;
	messageId: string;
	urgency: ReplyQueueUrgency;
	/**
	 * Unified cross-thread priority score (server-computed in mail/priorityScore.ts):
	 * the deterministic sender-importance signal (VIP / known contact / frecency)
	 * blended with the LLM urgency. The Reply Queue ranks by THIS, not the 3-bucket
	 * urgency — a terse note from a VIP outranks a wordy ask from a stranger. Absent
	 * only on rows persisted before scoring existed; the comparator then falls back
	 * to the urgency bucket.
	 */
	priorityScore?: number;
	/** One-line "what they are asking" — present only after LLM refinement. */
	askSummary?: string;
	/** ISO date (YYYY-MM-DD) when the message states a deadline. */
	dueHint?: string;
	detectedAt: number;
	source: 'heuristic' | 'llm';
	/**
	 * Clarification loop: when present, the AI decided a good reply needs a fact
	 * only the owner can supply. Renders as a "Needs your input" card until the
	 * owner answers, then a "Draft ready" card. Absent for a plain needs-reply.
	 */
	clarification?: ReplyQueueClarification;
	/**
	 * Draft-on-arrival review slot (postbox.aiDraft): present when a reply was
	 * pre-generated for this thread. Drives the "Draft ready — review & send"
	 * affordance on the row. Absent when the flag is off or generation failed.
	 */
	draftSlot?: ReplyQueueDraftSlot;
	fromAddress: string;
	fromName?: string;
	subject: string;
	snippet: string;
	receivedAt: number;
}

/**
 * Fallback score for a row without a persisted priorityScore (rows classified
 * before scoring existed): map the urgency bucket alone. Mirrors the server
 * weights in mail/priorityScore.ts so mixed old/new rows stay comparable.
 */
const URGENCY_FALLBACK_SCORE: Record<ReplyQueueUrgency, number> = {
	high: 100,
	normal: 50,
	low: 20,
};

/** The ranking key for a row: its priority score, or the urgency fallback. */
function effectiveScore(item: Pick<ReplyQueueItem, 'urgency' | 'priorityScore'>): number {
	return item.priorityScore ?? URGENCY_FALLBACK_SCORE[item.urgency];
}

/**
 * Queue order: unified priority score first (highest score = most important,
 * so a VIP's terse note outranks a stranger's wordy ask), then age — among
 * equally-scored rows the one waiting the longest (oldest receivedAt) comes
 * first. Replaces the old "urgency bucket, then age" ordering.
 */
export function compareReplyQueueItems(
	a: Pick<ReplyQueueItem, 'urgency' | 'receivedAt' | 'priorityScore'>,
	b: Pick<ReplyQueueItem, 'urgency' | 'receivedAt' | 'priorityScore'>
): number {
	const byScore = effectiveScore(b) - effectiveScore(a); // higher score first
	if (byScore !== 0) return byScore;
	return a.receivedAt - b.receivedAt;
}

/**
 * Card headline: the AI's askSummary when present, else the subject — the
 * deterministic queue must read fine with AI disabled or failed.
 */
export function replyQueueHeadline(
	item: Pick<ReplyQueueItem, 'askSummary' | 'subject' | 'kind' | 'waitingOn'> &
		Partial<Pick<ReplyQueueItem, 'fromAddress'>>
): string {
	// Follow-up items invert the framing: WE are waiting on THEM.
	if (item.kind === 'followup') {
		const who = item.waitingOn?.trim() || item.fromAddress?.trim();
		return who ? `You're waiting on ${who}` : "You're waiting on a reply";
	}
	const ask = item.askSummary?.trim();
	if (ask) return ask;
	return item.subject.trim() || '(no subject)';
}

/**
 * Human label for the LLM's ISO due hint ("Due Jul 3"), or null when the
 * hint is absent/unparseable — the card simply omits the chip then.
 */
export function formatReplyQueueDueHint(dueHint: string | undefined): string | null {
	if (!dueHint) return null;
	const parsed = new Date(dueHint);
	if (Number.isNaN(parsed.getTime())) return null;
	// The hint is a calendar date ("YYYY-MM-DD"), which new Date() parses as
	// UTC midnight — format in UTC too, or every west-of-UTC user would see
	// the deadline one day early.
	return `Due ${parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
}

/**
 * Which section a queue row belongs to. A thread with an unanswered
 * clarification goes in "Needs your input"; everything else ("Needs you")
 * keeps the plain needs-reply / follow-up rows. A clarification that has been
 * answered (draft produced or drafting) stays in "Needs your input" — the row
 * is the same task the owner is still finishing.
 */
export function replyQueueSection(
	item: Pick<ReplyQueueItem, 'clarification'>
): 'needs_input' | 'needs_you' {
	return item.clarification ? 'needs_input' : 'needs_you';
}

/**
 * Bucket a draft-on-arrival slot's confidence (the quality self-check score, or
 * a low fallback when the check failed) into a human label + severity for the
 * review chip. Pure so the mapping is unit-testable. Deliberately conservative:
 * this is a REVIEW hint, never an auto-send authorization.
 */
export function draftSlotConfidence(slot: Pick<ReplyQueueDraftSlot, 'confidence' | 'quality'>): {
	label: string;
	level: 'high' | 'medium' | 'low' | 'unverified';
} {
	if (!slot.quality) return { label: 'Unverified', level: 'unverified' };
	if (slot.confidence >= 0.8) return { label: 'High confidence', level: 'high' };
	if (slot.confidence >= 0.6) return { label: 'Medium confidence', level: 'medium' };
	return { label: 'Low confidence', level: 'low' };
}

/**
 * The lifecycle state of a "Needs your input" card:
 *   - 'asking'   — questions are open, waiting on the owner.
 *   - 'drafting' — answered, the starter reply has not landed yet.
 *   - 'ready'    — the starter reply is ready (flip to "Draft ready").
 * Pure so the card's state machine is unit-testable.
 */
export function clarificationCardState(
	clarification: Pick<ReplyQueueClarification, 'answeredAt' | 'draft'> | undefined
): 'asking' | 'drafting' | 'ready' | null {
	if (!clarification) return null;
	if (clarification.draft) return 'ready';
	if (clarification.answeredAt) return 'drafting';
	return 'asking';
}
