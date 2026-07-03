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
	needed: boolean;
	questions: ReplyQueueClarificationQuestion[];
	askedAt: number;
	answeredAt?: number;
	/** The starter reply produced after answering — flips the card to Draft ready. */
	draft?: string;
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
	fromAddress: string;
	fromName?: string;
	subject: string;
	snippet: string;
	receivedAt: number;
}

const URGENCY_RANK: Record<ReplyQueueUrgency, number> = { high: 0, normal: 1, low: 2 };

/**
 * Queue order: urgency first (high → normal → low), then age — the message
 * that has been waiting the longest (oldest receivedAt) comes first.
 */
export function compareReplyQueueItems(
	a: Pick<ReplyQueueItem, 'urgency' | 'receivedAt'>,
	b: Pick<ReplyQueueItem, 'urgency' | 'receivedAt'>
): number {
	const byUrgency = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
	if (byUrgency !== 0) return byUrgency;
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
	item: Pick<ReplyQueueItem, 'clarification'>,
): 'needs_input' | 'needs_you' {
	return item.clarification ? 'needs_input' : 'needs_you';
}

/**
 * The lifecycle state of a "Needs your input" card:
 *   - 'asking'   — questions are open, waiting on the owner.
 *   - 'drafting' — answered, the starter reply has not landed yet.
 *   - 'ready'    — the starter reply is ready (flip to "Draft ready").
 * Pure so the card's state machine is unit-testable.
 */
export function clarificationCardState(
	clarification: Pick<ReplyQueueClarification, 'answeredAt' | 'draft'> | undefined,
): 'asking' | 'drafting' | 'ready' | null {
	if (!clarification) return null;
	if (clarification.draft) return 'ready';
	if (clarification.answeredAt) return 'drafting';
	return 'asking';
}
