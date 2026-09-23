/**
 * Which message a Team inbox thread's reply composer answers, and whether a
 * human reply can be sent to it right now.
 *
 * A human reply rides the same path an agent draft does: the typed text is
 * saved as the message's working draft (`editDraft`) and then approved
 * (`approveDraft`), which schedules the send with its undo window. That path
 * starts at `draft_ready`. A message the agent will not draft — it failed, or
 * the agent is off and the pipeline stopped after the security scan — is first
 * taken over (`manualReply.takeOverReply` → `draft_ready`), so a person can
 * always write the reply themselves. States where the agent is still working,
 * or where no reply belongs, get a plain reason instead of a box that would
 * fail on submit.
 *
 * Module scope never calls `useI18n`: reasons are catalog keys.
 */

/** The slice of an inbound message this module reads. */
export interface ReplyTargetMessage {
	_id: string;
	processingStatus: string;
	draftResponse?: string | null;
	_creationTime: number;
}

/**
 * Why the composer cannot send to the target right now, or `null` when it can.
 * `draft_ready` covers both an agent draft awaiting review and a draftless
 * escalation the agent handed to a person.
 */
export type ReplyBlocker =
	| 'processing'
	| 'drafting'
	| 'needsInput'
	| 'update'
	| 'sending'
	| 'answered'
	| 'closed'
	| 'quarantined';

const BLOCKERS: Record<string, ReplyBlocker> = {
	received: 'processing',
	security_check: 'processing',
	classifying: 'processing',
	drafting: 'drafting',
	awaiting_clarification: 'needsInput',
	informational: 'update',
	approved: 'sending',
	sent: 'answered',
	rejected: 'closed',
	archived: 'closed',
	quarantined: 'quarantined',
};

/** Catalog key per blocker, rendered under the collapsed composer. */
export const REPLY_BLOCKER_KEYS: Record<ReplyBlocker, string> = {
	processing: 'dashboard.inbox.detail.composer.blocked.processing',
	drafting: 'dashboard.inbox.detail.composer.blocked.drafting',
	needsInput: 'dashboard.inbox.detail.composer.blocked.needsInput',
	update: 'dashboard.inbox.detail.composer.blocked.update',
	sending: 'dashboard.inbox.detail.composer.blocked.sending',
	answered: 'dashboard.inbox.detail.composer.blocked.answered',
	closed: 'dashboard.inbox.detail.composer.blocked.closed',
	quarantined: 'dashboard.inbox.detail.composer.blocked.quarantined',
};

/** What the viewer's instance allows, for the one state that depends on it. */
export interface ReplyContext {
	/** Is the AI agent on? When it is off, a scanned message rests in `security_check`. */
	agentEnabled: boolean;
}

/**
 * `null` = a person can reply to this message now (possibly after taking it
 * over, see {@link needsTakeOver}).
 */
export function replyBlocker(
	status: string,
	context: ReplyContext = { agentEnabled: true }
): ReplyBlocker | null {
	if (status === 'draft_ready' || status === 'failed') return null;
	if (status === 'security_check' && !context.agentEnabled) return null;
	return BLOCKERS[status] ?? 'processing';
}

/**
 * Does sending first have to take the message over from the agent? True for
 * every sendable state except `draft_ready`, which is already waiting on a
 * person.
 */
export function needsTakeOver(status: string): boolean {
	return status !== 'draft_ready';
}

/**
 * The message the composer answers: the newest one still waiting for a reply
 * (`draft_ready`), so an older message with a draft is never stranded behind a
 * newer one the agent is still reading; otherwise the newest message, whose
 * state then explains why there is nothing to send yet.
 */
export function pickReplyTarget<T extends ReplyTargetMessage>(
	messages: readonly T[] | null | undefined
): T | null {
	if (!messages || messages.length === 0) return null;
	const newestFirst = [...messages].sort((a, b) => b._creationTime - a._creationTime);
	return newestFirst.find((m) => m.processingStatus === 'draft_ready') ?? newestFirst[0] ?? null;
}

/** Does the target carry an agent draft worth pre-filling the composer with? */
export function hasAgentDraft(message: Pick<ReplyTargetMessage, 'draftResponse'>): boolean {
	return !!message.draftResponse?.trim();
}

/** Classification as the header's one line: category, plus priority when it matters. */
export interface ClassificationSummary {
	category: string;
	/** Only `high` / `urgent`: a normal or low priority is not worth a word. */
	priority: string | null;
}

const LOUD_PRIORITIES = new Set(['high', 'urgent']);

export function classificationSummary(
	classification: { category: string; priority: string } | null | undefined
): ClassificationSummary | null {
	if (!classification?.category) return null;
	return {
		category: classification.category,
		priority: LOUD_PRIORITIES.has(classification.priority) ? classification.priority : null,
	};
}

/**
 * The classification the header summarises: the newest message that has one.
 * A thread is about what the customer said last.
 */
export function latestClassification<
	T extends { _creationTime: number; classification?: { category: string; priority: string } },
>(messages: readonly T[] | null | undefined): T['classification'] | null {
	if (!messages) return null;
	let best: T | null = null;
	for (const m of messages) {
		if (!m.classification) continue;
		if (!best || m._creationTime > best._creationTime) best = m;
	}
	return best?.classification ?? null;
}
