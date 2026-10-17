/**
 * The reply seed's recipients (composables/postbox/postboxReplySpec.ts): a
 * reply goes to the sender, and a reply to our own message (a follow-up, a
 * nudge from the Answer queue) goes to the people it went to, never back to
 * us; its Cc stays the reply-all hint.
 */
import { describe, expect, it } from 'vitest';
import { buildReplyComposeSeed } from '../postboxReplySpec';

const OWN = new Set(['me@example.com']);
const base = {
	_id: 'msg-1',
	subject: 'The signed contract?',
	ccAddresses: ['legal@acme.test'],
	receivedAt: Date.UTC(2026, 9, 15, 10),
	htmlBodyInline: '<p>Could you send it?</p>',
};

describe('buildReplyComposeSeed', () => {
	it('replies to the sender of their message', async () => {
		const seed = await buildReplyComposeSeed(
			'reply',
			{ ...base, fromAddress: 'sam@acme.test', toAddresses: ['me@example.com'] },
			{ mailboxId: 'mb-1' as never, ownAddresses: OWN }
		);
		expect(seed.prefillTo).toEqual(['sam@acme.test']);
		expect(seed.replyAllRecipients).toEqual(['legal@acme.test']);
	});

	it('replies to the recipients of our own message', async () => {
		const seed = await buildReplyComposeSeed(
			'reply',
			{
				...base,
				fromAddress: 'Me <ME@example.com>',
				toAddresses: ['sam@acme.test', 'me@example.com'],
			},
			{ mailboxId: 'mb-1' as never, ownAddresses: OWN }
		);
		expect(seed.prefillTo).toEqual(['sam@acme.test']);
		expect(seed.replyAllRecipients).toEqual(['legal@acme.test']);
		expect(seed.inReplyToMessageId).toBe('msg-1');
	});

	it('falls back to the Cc of our own message when its To was only us (F8)', async () => {
		const seed = await buildReplyComposeSeed(
			'reply',
			{ ...base, fromAddress: 'me@example.com', toAddresses: ['me@example.com'] },
			{ mailboxId: 'mb-1' as never, ownAddresses: OWN }
		);
		expect(seed.prefillTo).toEqual(['legal@acme.test']);
		expect(seed.replyAllRecipients).toBeUndefined();
	});
});
