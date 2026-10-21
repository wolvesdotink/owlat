// @vitest-environment happy-dom
/**
 * One customer email in the Team Inbox stream. A body that fails to render
 * (the mail itself is untrusted) is contained to that email: its header, its
 * attachments and the rest of the conversation stay on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import InboxStreamEmail from '../InboxStreamEmail.vue';

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const FailingBody = defineComponent({
	name: 'InboxMessageBody',
	setup: () => () => {
		throw new Error('body could not render');
	},
});

const marker = (name: string) =>
	defineComponent({ name, setup: () => () => h('div', { 'data-testid': name }) });

describe('InboxStreamEmail', () => {
	it('keeps a failed body inside its email', async () => {
		const wrapper = mount(InboxStreamEmail, {
			props: {
				message: {
					_id: 'msg_1',
					_creationTime: Date.UTC(2026, 9, 1),
					from: 'ines@example.com',
					processingStatus: 'received',
				} as never,
				contact: null,
				isAdmin: false,
				hasWaitingDraft: false,
				retrying: false,
				undoingAutoSend: false,
			},
			global: {
				plugins: [createTestI18n()],
				stubs: {
					UiAvatar: true,
					InboxMessageBody: FailingBody,
					InboxCrossSurfaceStrip: marker('InboxCrossSurfaceStrip'),
					InboxMessageAttachments: marker('InboxMessageAttachments'),
					InboxAgentInsight: true,
					InboxAutoSendCountdown: true,
					InboxBudgetHoldNotice: true,
					InboxFailedNotice: true,
					InboxGuardNotRunNotice: true,
				},
			},
		});
		await nextTick();

		expect(wrapper.get('[role="alert"]').text()).toContain("This message couldn't be displayed.");
		expect(wrapper.text()).toContain('ines@example.com');
		expect(wrapper.find('[data-testid="InboxMessageAttachments"]').exists()).toBe(true);
	});
});
