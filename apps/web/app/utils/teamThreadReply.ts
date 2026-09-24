/**
 * Which message a Team inbox thread's reply composer answers, and whether a
 * human reply can be sent to it right now.
 *
 * A human reply rides the same path an agent draft does: the typed text is
 * saved as the message's working draft (`editDraft`) and then approved
 * (`approveDraft`), which schedules the send with its undo window. That path
 * starts at `draft_ready`. A message no agent is going to answer — it failed,
 * the agent is off and the pipeline stopped after the security scan, the
 * pipeline never picked it up (automated mail, the cost cap), the agent is
 * waiting on a question the person would rather not answer, or a teammate
 * rejected the draft or it was archived — is first taken over
 * (`manualReply.takeOverReply` → `draft_ready`), so a person can always write
 * the reply themselves. So is a message the agent is still drafting: the
 * takeover wins, and the agent's late draft is dropped.
 *
 * A message whose reply already went out (`sent`) takes a follow-up instead
 * (`followUps.sendFollowUp`), a second message with its own send and undo
 * window. States where Owlat is still reading the message, or the reply is on
 * its way, get a plain reason instead of a box that would fail on submit.
 *
 * Module scope never calls `useI18n`: reasons are catalog keys.
 */

/**
 * A person's reply: its body, and the subject (blank = keep the default). The
 * page's mutation wrappers (`useThreadDetail`) take it, and the composer
 * (`useTeamThreadComposer`) hands it to them.
 */
export interface TeamThreadReply {
	body: string;
	subject: string;
}

/** The slice of an inbound message this module reads. */
export interface ReplyTargetMessage {
	_id: string;
	processingStatus: string;
	draftResponse?: string | null;
	draftSubject?: string | null;
	subject?: string | null;
	/** The channel literal (`sms`, `whatsapp`, …) for non-email messages. */
	to?: string;
	_creationTime: number;
}

/**
 * Why the composer cannot send to the target right now, or `null` when it can.
 * `draft_ready` covers both an agent draft awaiting review and a draftless
 * escalation the agent handed to a person.
 */
export type ReplyBlocker = 'processing' | 'update' | 'sending' | 'answered' | 'quarantined';

const BLOCKERS: Record<string, ReplyBlocker> = {
	received: 'processing',
	security_check: 'processing',
	classifying: 'processing',
	informational: 'update',
	approved: 'sending',
	sent: 'answered',
	quarantined: 'quarantined',
};

/** Catalog key per blocker, rendered under the collapsed composer. */
export const REPLY_BLOCKER_KEYS: Record<ReplyBlocker, string> = {
	processing: 'dashboard.inbox.detail.composer.blocked.processing',
	update: 'dashboard.inbox.detail.composer.blocked.update',
	sending: 'dashboard.inbox.detail.composer.blocked.sending',
	answered: 'dashboard.inbox.detail.composer.blocked.answered',
	quarantined: 'dashboard.inbox.detail.composer.blocked.quarantined',
};

/**
 * What the viewer's instance allows, the server's takeover facts for the
 * message, and the clock. The facts come from `getThread`'s `takeOver` block,
 * computed by the same code `manualReply.takeOverReply` checks, so the composer
 * never opens on a message the server would refuse. A missing fact reads as
 * "not yet", never as sendable.
 */
export interface ReplyContext {
	/** Is the AI agent on? When it is off, a scanned message rests in `security_check`. */
	agentEnabled: boolean;
	/** The message's security scan has completed. */
	scanFinished?: boolean;
	/** Any agent action exists for the message: a pipeline run started. */
	pipelineStarted?: boolean;
	/** How long a `received` message waits before a person may take it over. */
	receivedWaitMs?: number;
	/** When the message arrived (`_creationTime`). */
	receivedAt?: number;
	/** The current time. */
	now?: number;
	/** The message came in on a non-email channel, which takes no follow-up. */
	isChannel?: boolean;
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
	if (status === 'rejected' || status === 'archived') return null;
	// Writing the reply instead of answering the agent's questions, or instead
	// of waiting for its draft.
	if (status === 'awaiting_clarification' || status === 'drafting') return null;
	if (status === 'sent' && !context.isChannel) return null;
	if (status === 'security_check' && !context.agentEnabled && context.scanFinished === true) {
		return null;
	}
	if (
		status === 'received' &&
		context.pipelineStarted === false &&
		context.receivedWaitMs !== undefined &&
		context.receivedAt !== undefined &&
		context.now !== undefined &&
		context.now - context.receivedAt >= context.receivedWaitMs
	) {
		return null;
	}
	return BLOCKERS[status] ?? 'processing';
}

/**
 * Does sending first have to take the message over from the agent? True for
 * every sendable state except `draft_ready`, which is already waiting on a
 * person, and `sent`, which takes a follow-up instead.
 */
export function needsTakeOver(status: string): boolean {
	return status !== 'draft_ready' && !isFollowUp(status);
}

const OUTBOUND_CHANNELS: ReadonlySet<string> = new Set(['sms', 'whatsapp', 'generic']);

/** Did the message come in on a non-email channel (its `to` is the channel literal)? */
export function isChannelMessage(message: Pick<ReplyTargetMessage, 'to'>): boolean {
	return message.to !== undefined && OUTBOUND_CHANNELS.has(message.to);
}

/** Is a reply to this message a follow-up, because its own reply already went out? */
export function isFollowUp(status: string): boolean {
	return status === 'sent';
}

/**
 * What the open composer says about where the text goes, when that is not the
 * plain answer to a waiting message: over the agent's unfinished draft, or as
 * a second message after the answer.
 */
export type ReplyNotice = 'takesOverDraft' | 'followUp';

export const REPLY_NOTICE_KEYS: Record<ReplyNotice, string> = {
	takesOverDraft: 'dashboard.inbox.detail.composer.notice.takesOverDraft',
	followUp: 'dashboard.inbox.detail.composer.notice.followUp',
};

export function replyNotice(status: string): ReplyNotice | null {
	if (status === 'drafting') return 'takesOverDraft';
	if (isFollowUp(status)) return 'followUp';
	return null;
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

/**
 * The messages other than the target that also hold a draft waiting for a
 * person, oldest first. Each gets its own note in the thread so none is
 * answered out of order or silently left behind.
 */
export function otherWaitingDrafts<T extends ReplyTargetMessage>(
	messages: readonly T[] | null | undefined,
	target: T | null
): T[] {
	if (!messages) return [];
	return messages
		.filter((m) => m.processingStatus === 'draft_ready' && m._id !== target?._id)
		.sort((a, b) => a._creationTime - b._creationTime);
}

/**
 * The subject a reply goes out under: the draft's, otherwise "Re: <subject>"
 * (the server's own fallback, `buildReplySubject`).
 */
export function replySubject(
	message: Pick<ReplyTargetMessage, 'draftSubject' | 'subject'>
): string {
	const draft = message.draftSubject?.trim();
	if (draft) return draft;
	const subject = message.subject ?? '';
	if (!subject) return '';
	return subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`;
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
