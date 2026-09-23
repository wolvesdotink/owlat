import { extractEmailAddress } from '~/utils/emailAddress';

/**
 * Who the reader's Team discussion is NOT sent to: the latest sender in the
 * thread who is not one of the mailbox's own addresses, by display name when
 * the message carries one. Empty when every message is ours (the composer then
 * falls back to "the sender").
 */
export function discussionCounterpartyLabel(
	messages: ReadonlyArray<{ fromAddress: string; fromName?: string | null }>,
	ownAddresses: ReadonlySet<string>
): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		const address = extractEmailAddress(message.fromAddress);
		if (address && !ownAddresses.has(address)) return message.fromName?.trim() || address;
	}
	return '';
}
