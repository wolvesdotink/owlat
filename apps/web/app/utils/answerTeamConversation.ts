/**
 * A Team inbox thread as Answer mode's conversation column reads it: which of
 * the customer's messages open in full (the order comes from the team stream).
 *
 * Pure, so the timeline and the default expansion are unit-testable.
 */

export interface TeamConversationInbound {
	_id: string;
	_creationTime: number;
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
