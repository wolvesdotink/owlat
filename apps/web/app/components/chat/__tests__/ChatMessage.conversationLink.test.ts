/**
 * A conversation link shared into chat ("Share in chat…") opens in the app;
 * any other URL stays text, and mentions still render as mentions.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import ChatMessage from '../ChatMessage.vue';

beforeEach(() => {
	installNuxtStubs({
		...i18nStubs,
		useChatAttachmentDetails: () => ({ attachments: ref([]) }),
	});
});

function mountMessage(text: string) {
	return mount(ChatMessage, {
		props: {
			message: {
				_id: 'cm1',
				roomId: 'r1',
				authorId: 'u2',
				author: { name: 'Inés Okafor', email: 'ines@example.com' },
				text,
				createdAt: 0,
				mentions: [],
				isAssistant: false,
			} as never,
			isOwnMessage: false,
			currentUserId: 'u1',
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiAvatar: true,
				UiButton: true,
				AssistantToolCalls: true,
				AssistantMarkdown: true,
				AiBudgetRefusal: true,
				ChatAttachmentChip: true,
				NuxtLink: { props: ['to'], template: '<a :href="to" data-testid="in-app"><slot /></a>' },
			},
		},
	});
}

describe('ChatMessage conversation links', () => {
	it('opens a link to a conversation on this instance in the app', () => {
		const url = `${window.location.origin}/dashboard/postbox/inbox/m1?mailbox=mb1`;
		const wrapper = mountMessage(`@ines can you look?\n\n${url}`);
		const link = wrapper.get('[data-testid="in-app"]');
		expect(link.attributes('href')).toBe('/dashboard/postbox/inbox/m1?mailbox=mb1');
		expect(link.text()).toBe(url);
		expect(wrapper.text()).toContain('can you look?');
	});

	it('leaves a link to anywhere else as text', () => {
		const wrapper = mountMessage('see https://evil.example/dashboard/inbox/th1');
		expect(wrapper.find('[data-testid="in-app"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('https://evil.example/dashboard/inbox/th1');
	});
});
