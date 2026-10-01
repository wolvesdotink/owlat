import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import ThreadOutbound from '../ThreadOutbound.vue';
import AutoSendCountdown from '../AutoSendCountdown.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

let wrapper: VueWrapper | undefined;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-03-10T09:00:00Z'));
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = undefined;
	vi.useRealTimers();
});

/**
 * #807 — what the team sent shows in the thread: the reply that answered a
 * message, and follow-ups written after it, with an Undo while one waits out
 * its window.
 */
function mountOutbound(props: Record<string, unknown> = {}) {
	wrapper = mount(ThreadOutbound, {
		props: {
			authorLabel: 'Ada Marlow',
			body: 'The CSV includes both variants.',
			at: Date.now(),
			status: 'sent',
			...props,
		},
		global: {
			plugins: [createTestI18n()],
			components: { InboxAutoSendCountdown: AutoSendCountdown },
			stubs: {
				Icon: true,
				UiIconBox: true,
				UiButton: {
					emits: ['click'],
					template: '<button @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	});
	return wrapper;
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
		const wrapper = mountOutbound({ status: 'scheduled', sendAt: Date.now() + 12_000 });
		const bar = wrapper.get('[data-testid="thread-outbound-undo"]');
		expect(bar.text()).toContain('Sending in 12s');
		await bar.get('button').trigger('click');
		expect(wrapper.emitted('undo')).toHaveLength(1);
	});

	it('ticks on its own clock from sendAt, then drops the Undo when the window closes', async () => {
		const wrapper = mountOutbound({ status: 'scheduled', sendAt: Date.now() + 3_000 });
		expect(wrapper.get('[data-testid="thread-outbound-undo"]').text()).toContain('Sending in 3s');

		vi.advanceTimersByTime(1_250);
		await nextTick();
		expect(wrapper.get('[data-testid="thread-outbound-undo"]').text()).toContain('Sending in 2s');

		vi.advanceTimersByTime(2_000);
		await nextTick();
		expect(wrapper.find('[data-testid="thread-outbound-undo"]').exists()).toBe(false);
		expect(wrapper.get('[data-testid="thread-outbound-status"]').text()).toBe('Sending');
	});

	it('drops the Undo for a window that already closed', () => {
		const wrapper = mountOutbound({ status: 'scheduled', sendAt: Date.now() - 1 });
		expect(wrapper.find('[data-testid="thread-outbound-undo"]').exists()).toBe(false);
		expect(wrapper.get('[data-testid="thread-outbound-status"]').text()).toBe('Sending');
	});

	it('runs no clock once the follow-up is no longer pending', () => {
		mountOutbound({ status: 'sent', sendAt: Date.now() + 10_000 });
		expect(vi.getTimerCount()).toBe(0);
	});

	it('stops the countdown clock when the follow-up leaves the scheduled state', async () => {
		const wrapper = mountOutbound({ status: 'scheduled', sendAt: Date.now() + 10_000 });
		expect(vi.getTimerCount()).toBe(1);
		await wrapper.setProps({ status: 'sending' });
		expect(wrapper.find('[data-testid="thread-outbound-undo"]').exists()).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
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
