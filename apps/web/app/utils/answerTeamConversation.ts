/**
 * A Team inbox thread as Answer mode's conversation column reads it: the
 * customer's messages in order, each followed by what the team sent back (the
 * reply that answered it, then any follow-ups), and which of them open in full.
 *
 * Pure, so the timeline and the default expansion are unit-testable.
 */

export interface TeamConversationInbound {
	_id: string;
	_creationTime: number;
	processingStatus: string;
	draftResponse?: string | null;
}

export interface TeamConversationFollowUp {
	_id: string;
	inReplyToMessageId?: string | null;
}

export type TeamConversationEntry<M, F> =
	| { kind: 'inbound'; key: string; message: M }
	| { kind: 'reply'; key: string; message: M }
	| { kind: 'followUp'; key: string; followUp: F };

/** The thread in reading order: each message, its sent reply, its follow-ups. */
export function teamConversationEntries<
	M extends TeamConversationInbound,
	F extends TeamConversationFollowUp,
>(messages: readonly M[], followUps: readonly F[]): TeamConversationEntry<M, F>[] {
	const ordered = [...messages].sort((a, b) => a._creationTime - b._creationTime);
	const entries: TeamConversationEntry<M, F>[] = [];
	for (const message of ordered) {
		entries.push({ kind: 'inbound', key: message._id, message });
		if (message.processingStatus === 'sent' && message.draftResponse) {
			entries.push({ kind: 'reply', key: `reply:${message._id}`, message });
		}
		for (const followUp of followUps) {
			if (followUp.inReplyToMessageId === message._id) {
				entries.push({ kind: 'followUp', key: followUp._id, followUp });
			}
		}
	}
	return entries;
}

/**
 * The messages that open in full by default: the newest one, and the one the
 * reply answers when that is an older message. Everything else is a one-line
 * row until clicked, as in the Postbox's Answer mode.
 */
export function teamConversationOpenIds(
	messages: readonly TeamConversationInbound[],
	answeringId: string | null
): Set<string> {
	const open = new Set<string>();
	let newest: TeamConversationInbound | null = null;
	for (const message of messages) {
		if (!newest || message._creationTime > newest._creationTime) newest = message;
	}
	if (newest) open.add(newest._id);
	if (answeringId) open.add(answeringId);
	return open;
}
