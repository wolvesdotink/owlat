// @vitest-environment happy-dom
/**
 * The auto-send banner on a team-inbox message: it counts the held reply down
 * on its own clock, hides once the window has run out, and hands Undo to the
 * page.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import AutoSendCountdown from '../AutoSendCountdown.vue';

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

function mountCountdown(props: { sendAt: number; busy?: boolean }) {
	wrapper = mount(AutoSendCountdown, {
		props,
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				UiButton: {
					props: ['loading'],
					emits: ['click'],
					template: '<button :data-loading="loading" @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	});
	return wrapper;
}

const banner = () => wrapper!.find('[data-testid="auto-send-countdown"]');

describe('InboxAutoSendCountdown', () => {
	it('counts down while the reply is held and hides when the window runs out', async () => {
		mountCountdown({ sendAt: Date.now() + 3_000 });
		expect(banner().text()).toContain('Sending automatically in 3s');

		vi.advanceTimersByTime(1_250);
		await nextTick();
		expect(banner().text()).toContain('Sending automatically in 2s');

		vi.advanceTimersByTime(2_000);
		await nextTick();
		expect(banner().exists()).toBe(false);
	});

	it('renders nothing for a window that already closed', () => {
		mountCountdown({ sendAt: Date.now() - 1 });
		expect(banner().exists()).toBe(false);
	});

	it('emits cancel on Undo and shows the busy state', async () => {
		mountCountdown({ sendAt: Date.now() + 10_000, busy: true });
		const undo = banner().get('button');
		expect(undo.attributes('data-loading')).toBe('true');
		await undo.trigger('click');
		expect(wrapper!.emitted('cancel')).toHaveLength(1);
	});

	it('stops its clock on unmount', () => {
		mountCountdown({ sendAt: Date.now() + 10_000 });
		expect(vi.getTimerCount()).toBe(1);
		wrapper!.unmount();
		wrapper = undefined;
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('InboxAutoSendCountdown label', () => {
	it('reads the line from labelKey when the parent names one', () => {
		wrapper = mount(AutoSendCountdown, {
			props: { sendAt: Date.now() + 5_000, labelKey: 'dashboard.inbox.detail.outbound.sendsIn' },
			global: { plugins: [createTestI18n()], stubs: { Icon: true, UiButton: true } },
		});
		expect(banner().text()).toContain('Sending in 5s');
		expect(banner().text()).not.toContain('automatically');
	});
});
