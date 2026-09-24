import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';
import ThreadOutbound from '../ThreadOutbound.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

/**
 * #807 — what the team sent shows in the thread: the reply that answered a
 * message, and follow-ups written after it, with an Undo while one waits out
 * its window.
 */
function mountOutbound(props: Record<string, unknown> = {}) {
	return mount(ThreadOutbound, {
		props: {
			authorLabel: 'Ada Marlow',
			body: 'The CSV includes both variants.',
			at: Date.now(),
			status: 'sent',
			...props,
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				UiIconBox: true,
				UiButton: { template: '<button><slot /></button>' },
			},
		},
	});
}

describe('InboxThreadOutbound', () => {
	it('shows who sent it and what they wrote', () => {
		const wrapper = mountOutbound();
		expect(wrapper.text()).toContain('Ada Marlow');
		expect(wrapper.text()).toContain('The CSV includes both variants.');
		expect(wrapper.get('[data-testid="thread-outbound-status"]').text()).toBe('Sent');
		expect(wrapper.find('[data-testid="thread-outbound-undo"]').exists()).toBe(false);
	});

	it('counts down with an Undo while the follow-up waits out its window', async () => {
		const wrapper = mountOutbound({ status: 'scheduled', secondsLeft: 12 });
		const bar = wrapper.get('[data-testid="thread-outbound-undo"]');
		expect(bar.text()).toContain('Sending in 12s');
		await bar.get('button').trigger('click');
		expect(wrapper.emitted('undo')).toHaveLength(1);
	});

	it('drops the Undo once the window has closed', () => {
		const wrapper = mountOutbound({ status: 'scheduled', secondsLeft: 0 });
		expect(wrapper.find('[data-testid="thread-outbound-undo"]').exists()).toBe(false);
		expect(wrapper.get('[data-testid="thread-outbound-status"]').text()).toBe('Sending');
	});

	it('says why a follow-up did not go out', () => {
		const wrapper = mountOutbound({
			status: 'failed',
			errorMessage: 'The recipient is on the blocklist',
		});
		expect(wrapper.get('[data-testid="thread-outbound-status"]').text()).toBe('Not sent');
		expect(wrapper.text()).toContain('The recipient is on the blocklist');
	});
});
