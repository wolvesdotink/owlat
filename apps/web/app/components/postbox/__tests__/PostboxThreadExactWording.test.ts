// @vitest-environment happy-dom
/**
 * "Read the exact wording" (SPEC §7 legal mail): the originals the brief asked
 * to keep open are rendered beside it, open by default; a signed or encrypted
 * message is not rendered bare (only its full card binds it to its verdict).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxThreadExactWording from '../PostboxThreadExactWording.vue';

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

const Body = defineComponent({
	name: 'PostboxMessageBody',
	props: ['message'],
	setup: (p) => () => h('div', { 'data-testid': 'body' }, (p['message'] as { _id: string })._id),
});

const msg = (id: string, over: Record<string, unknown> = {}) => ({
	_id: id,
	mailboxId: 'mb1',
	fromAddress: 'legal@example.com',
	fromName: 'Legal',
	toAddresses: [],
	ccAddresses: [],
	subject: 'Changed terms',
	receivedAt: Date.UTC(2026, 9, 7),
	hasAttachments: false,
	attachments: [],
	...over,
});

function mountPanel(messages: unknown[]) {
	return mount(PostboxThreadExactWording, {
		props: { messages: messages as never, secureClass: () => 'none' },
		global: { plugins: [createTestI18n()], components: { PostboxMessageBody: Body } },
	});
}

describe('PostboxThreadExactWording', () => {
	it('renders the originals, open by default', () => {
		const w = mountPanel([msg('m1')]);
		expect(w.get('details').attributes('open')).toBeDefined();
		expect(w.text()).toContain('Read the exact wording');
		expect(w.get('[data-testid="body"]').text()).toBe('m1');
	});

	it('does not render a signed message bare', async () => {
		const w = mountPanel([
			msg('m2', { inboundSignatureInfo: { isSigned: true, isSignatureValid: true } }),
		]);
		expect(w.find('[data-testid="body"]').exists()).toBe(false);
		await w.get('button').trigger('click');
		expect(w.emitted('open-conversation')).toHaveLength(1);
	});

	it('says when the brief lists fewer than there are', () => {
		const w = mount(PostboxThreadExactWording, {
			props: { messages: [msg('m1')] as never, secureClass: () => 'none', isTruncated: true },
			global: { plugins: [createTestI18n()], components: { PostboxMessageBody: Body } },
		});
		expect(w.get('[data-testid="exact-wording-truncated"]').text()).toContain(
			'More messages here need their exact wording than this list shows.'
		);
	});

	it('renders nothing without such messages', () => {
		expect(mountPanel([]).find('details').exists()).toBe(false);
	});
});
