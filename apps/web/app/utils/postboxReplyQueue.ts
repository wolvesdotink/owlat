/**
 * Pure helpers for the Postbox Reply Queue (the "emails waiting on you" task
 * list). Ranking and headline fallback live here — free of Convex/Vue — so
 * the ordering contract is unit-testable.
 */

export type ReplyQueueUrgency = 'high' | 'normal' | 'low';

export interface ReplyQueueItem {
	threadId: string;
	messageId: string;
	urgency: ReplyQueueUrgency;
	/** One-line "what they are asking" — present only after LLM refinement. */
	askSummary?: string;
	/** ISO date (YYYY-MM-DD) when the message states a deadline. */
	dueHint?: string;
	detectedAt: number;
	source: 'heuristic' | 'llm';
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
	item: Pick<ReplyQueueItem, 'askSummary' | 'subject'>
): string {
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
	return `Due ${parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}
