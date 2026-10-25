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
			{ mailboxId: 'mb-1' as never, ownAddresses: OWN, autoLoadImages: true }
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
			{ mailboxId: 'mb-1' as never, ownAddresses: OWN, autoLoadImages: true }
		);
		expect(seed.prefillTo).toEqual(['sam@acme.test']);
		expect(seed.replyAllRecipients).toEqual(['legal@acme.test']);
		expect(seed.inReplyToMessageId).toBe('msg-1');
	});

	it('falls back to the Cc of our own message when its To was only us (F8)', async () => {
		const seed = await buildReplyComposeSeed(
			'reply',
			{ ...base, fromAddress: 'me@example.com', toAddresses: ['me@example.com'] },
			{ mailboxId: 'mb-1' as never, ownAddresses: OWN, autoLoadImages: true }
		);
		expect(seed.prefillTo).toEqual(['legal@acme.test']);
		expect(seed.replyAllRecipients).toBeUndefined();
	});

	it('quotes remote images only where the reader would load them', async () => {
		const html = '<p>Deal</p><img src="https://cdn.example/a.jpg" width="400" height="200">';
		const from = { ...base, htmlBodyInline: html, fromAddress: 'sam@acme.test', toAddresses: [] };
		const ctx = { mailboxId: 'mb-1' as never, ownAddresses: OWN };
		const shown = await buildReplyComposeSeed('reply', from, { ...ctx, autoLoadImages: true });
		expect(shown.prefillBodyHtml).toContain('cdn.example/a.jpg');

		const optedOut = await buildReplyComposeSeed('forward', from, {
			...ctx,
			autoLoadImages: false,
		});
		expect(optedOut.prefillBodyHtml).not.toContain('cdn.example');

		const trusted = await buildReplyComposeSeed('forward', from, {
			...ctx,
			autoLoadImages: false,
			isSenderAllowed: true,
		});
		expect(trusted.prefillBodyHtml).toContain('cdn.example/a.jpg');

		const spam = await buildReplyComposeSeed(
			'reply',
			{ ...from, spamVerdict: 'spam' },
			{ ...ctx, autoLoadImages: true, isSenderAllowed: true }
		);
		expect(spam.prefillBodyHtml).not.toContain('cdn.example');
	});

	it('quotes a selected passage of an older message and replies to its sender', async () => {
		const older = {
			...base,
			_id: 'msg-old',
			fromAddress: 'sam@acme.test',
			toAddresses: ['me@example.com', 'ops@acme.test'],
			// The whole body is not needed: nothing is downloaded for a passage.
			htmlBodyStorageId: 'blob-1',
			hasBodyBlob: true,
			htmlBodyInline: undefined,
		};
		const seed = await buildReplyComposeSeed('replyAll', older, {
			mailboxId: 'mb-1' as never,
			ownAddresses: OWN,
			autoLoadImages: true,
			quotedPassage: 'Fine by <me> & you',
		});
		expect(seed.inReplyToMessageId).toBe('msg-old');
		expect(seed.prefillTo).toEqual(['sam@acme.test']);
		expect(seed.prefillCc).toEqual(['ops@acme.test', 'legal@acme.test']);
		expect(seed.prefillBodyHtml).toContain('owlat_selected_quote');
		expect(seed.prefillBodyHtml).toContain('Fine by &lt;me&gt; &amp; you');
		expect(seed.prefillBodyHtml).not.toContain('Could you send it?');
	});

	it('keeps the original in a forward even with a passage', async () => {
		const seed = await buildReplyComposeSeed(
			'forward',
			{ ...base, fromAddress: 'sam@acme.test', toAddresses: [] },
			{ mailboxId: 'mb-1' as never, ownAddresses: OWN, autoLoadImages: true, quotedPassage: 'x' }
		);
		expect(seed.prefillBodyHtml).toContain('Could you send it?');
		expect(seed.prefillBodyHtml).not.toContain('owlat_selected_quote');
	});
});
