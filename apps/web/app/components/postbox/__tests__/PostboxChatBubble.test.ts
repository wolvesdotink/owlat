/**
 * A chat bubble shows what its sender wrote this time: the quoted history and
 * the signature are left out, attachments are chips that open the file, and
 * the full message is one click away. A clearsigned body is handed back to
 * the card without showing its content.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import PostboxChatBubble from '../PostboxChatBubble.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import type { PostboxReaderMessage } from '~/composables/postbox/postboxReaderMessage';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const REPLY = [
	'Thursday at 12:30 works.',
	'',
	'-- ',
	'Sam Lee',
	'Product Lead, Fabrikam',
	'',
	'On Mon, Nov 2, 2026 at 9:14 AM Dev Admin <dev@demo.localhost> wrote:',
	'> Are you free for lunch this week?',
	'> Best, Dev',
].join('\n');

function message(overrides: Partial<PostboxReaderMessage> = {}): PostboxReaderMessage {
	return {
		_id: 'mm_1',
		mailboxId: 'mb_1',
		threadId: 'th_1',
		fromAddress: 'sam@fabrikam.example',
		fromName: 'Sam Lee',
		toAddresses: ['dev@demo.localhost'],
		ccAddresses: [],
		subject: 'Re: Lunch this week?',
		receivedAt: Date.UTC(2026, 10, 2, 10),
		textBodyInline: REPLY,
		hasAttachments: false,
		attachments: [],
		...overrides,
	};
}

function mountBubble(props: { message?: PostboxReaderMessage; own?: boolean }) {
	return mount(PostboxChatBubble, {
		props: { message: message(), own: false, ...props },
		global: { plugins: [createTestI18n()], stubs: { UiAvatar: true } },
	});
}

describe('PostboxChatBubble', () => {
	it('shows only the new text, without the signature or the quoted history', () => {
		const bubble = mountBubble({});
		expect(bubble.get('[data-testid="chat-bubble-text"]').text()).toBe('Thursday at 12:30 works.');
		expect(bubble.text()).toContain('Sam Lee');
		expect(bubble.text()).not.toContain('Product Lead');
		expect(bubble.text()).not.toContain('Are you free');
		expectFullyLocalized(bubble);
	});

	it('reads the HTML body when there is one', () => {
		const bubble = mountBubble({
			message: message({
				textBodyInline: undefined,
				htmlBodyInline:
					'<div>See you there.</div><div class="gmail_quote">On Mon, Nov 2, 2026 at 9:14 AM Sam wrote:<blockquote>Thursday?</blockquote></div>',
			}),
		});
		expect(bubble.get('[data-testid="chat-bubble-text"]').text()).toBe('See you there.');
	});

	it('names the viewer as "You" and sits on the right for their own message', () => {
		const bubble = mountBubble({ own: true });
		expect(bubble.get('[data-testid="chat-bubble"]').attributes('data-own')).toBe('');
		expect(bubble.text()).toContain('You');
		expect(bubble.text()).not.toContain('Sam Lee');
	});

	it('hands a body that turns out to be clearsigned back to the card, unread', () => {
		const clearsigned = mountBubble({
			message: message({
				textBodyInline:
					'-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nPay to IBAN X\n-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----',
			}),
		});
		expect(clearsigned.emitted('secure')).toHaveLength(1);
		expect(clearsigned.text()).not.toContain('IBAN');
		expect(mountBubble({}).emitted('secure')).toBeUndefined();
	});

	it('says so when a message holds no new text', () => {
		const bubble = mountBubble({
			message: message({ textBodyInline: 'On Mon, Nov 2, 2026 at 9:14 AM Sam wrote:\n> Hi' }),
		});
		expect(bubble.text()).toContain('No new text in this message.');
	});

	it('opens a previewable attachment, downloads the rest, and offers the full message', async () => {
		const pdf = {
			filename: 'menu.pdf',
			contentType: 'application/pdf',
			size: 2048,
			partIndex: '2',
		};
		const zip = {
			filename: 'photos.zip',
			contentType: 'application/zip',
			size: 4096,
			partIndex: '3',
		};
		const bubble = mountBubble({
			message: message({ hasAttachments: true, attachments: [pdf, zip] }),
		});
		const chips = bubble.findAll('li button');
		expect(chips.map((chip) => chip.text())).toEqual([
			expect.stringContaining('menu.pdf'),
			expect.stringContaining('photos.zip'),
		]);
		await chips[0]!.trigger('click');
		await chips[1]!.trigger('click');
		expect(bubble.emitted('preview')).toEqual([[pdf, [pdf, zip]]]);
		expect(bubble.emitted('download')).toEqual([[zip]]);

		await bubble.get('[data-testid="chat-bubble-show-full"]').trigger('click');
		expect(bubble.emitted('show-full')).toHaveLength(1);
	});
});
