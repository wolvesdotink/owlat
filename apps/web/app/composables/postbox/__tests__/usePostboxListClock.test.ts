// @vitest-environment happy-dom
/**
 * The Postbox list clock: one minute timer per list, injected by every row, so
 * row timestamps move while the list sits still and the list pays for a single
 * interval rather than one per row.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import {
	POSTBOX_LIST_CLOCK_INTERVAL_MS,
	usePostboxListNow,
	usePostboxThreadTimestamp,
} from '../usePostboxListClock';

const START = new Date(2026, 8, 29, 12, 0, 0).getTime();

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(START);
});

afterEach(() => {
	vi.useRealTimers();
});

const Row = defineComponent({
	props: { at: { type: Number, required: true } },
	setup(props) {
		const format = usePostboxThreadTimestamp();
		return () => h('span', { class: 'row' }, format(props.at));
	},
});

const List = defineComponent({
	props: { stamps: { type: Array as () => number[], required: true } },
	setup(props, { slots }) {
		usePostboxListNow();
		return () =>
			h('div', [...props.stamps.map((at) => h(Row, { key: at, at })), slots.default?.()]);
	},
});

function rowTexts(wrapper: ReturnType<typeof mount>): string[] {
	return wrapper.findAll('.row').map((row) => row.text());
}

describe('usePostboxListClock', () => {
	it('moves every row forward as time passes, off one interval', async () => {
		const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
		const i18n = createTestI18n();
		const wrapper = mount(List, {
			props: { stamps: [START, START - 5 * 60_000, START - 59 * 60_000] },
			global: { plugins: [i18n] },
		});
		expect(rowTexts(wrapper)).toEqual(['just now', '5m', '59m']);
		// One timer for the whole list: the rows inject it.
		expect(
			setIntervalSpy.mock.calls.filter(([, ms]) => ms === POSTBOX_LIST_CLOCK_INTERVAL_MS)
		).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(POSTBOX_LIST_CLOCK_INTERVAL_MS);
		expect(rowTexts(wrapper)).toEqual(['1m', '6m', '1h']);

		wrapper.unmount();
		setIntervalSpy.mockRestore();
	});

	it('lets a nested list reuse the outer clock instead of starting its own', () => {
		const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
		mount(List, {
			props: { stamps: [START] },
			slots: { default: () => h(List, { stamps: [START - 60_000] }) },
			global: { plugins: [createTestI18n()] },
		}).unmount();
		expect(
			setIntervalSpy.mock.calls.filter(([, ms]) => ms === POSTBOX_LIST_CLOCK_INTERVAL_MS)
		).toHaveLength(1);
		setIntervalSpy.mockRestore();
	});

	it('follows the active locale', async () => {
		const i18n = createTestI18n();
		i18n.global.setLocaleMessage('de', {
			components: { postbox: { postboxThreadRow: { justNow: 'gerade eben' } } },
		});
		const wrapper = mount(List, {
			props: { stamps: [START, START - 3 * 86_400_000] },
			global: { plugins: [i18n] },
		});
		expect(rowTexts(wrapper)).toEqual(['just now', '3d']);

		i18n.global.locale.value = 'de';
		await wrapper.vm.$nextTick();
		expect(rowTexts(wrapper)).toEqual([
			'gerade eben',
			new Intl.NumberFormat('de', { style: 'unit', unit: 'day', unitDisplay: 'narrow' }).format(3),
		]);
		wrapper.unmount();
	});

	it('gives a row outside any list the time it mounted at, with no timer', () => {
		const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
		const wrapper = mount(Row, {
			props: { at: START - 2 * 60_000 },
			global: { plugins: [createTestI18n()] },
		});
		expect(wrapper.text()).toBe('2m');
		expect(setIntervalSpy).not.toHaveBeenCalled();
		wrapper.unmount();
		setIntervalSpy.mockRestore();
	});
});
