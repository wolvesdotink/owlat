// @vitest-environment happy-dom
/**
 * The guest's time picker (components/booking/BookingSlotPicker): only days
 * with open times can be picked, the first such day opens on its own, its times
 * show in the chosen zone, and picking a time or paging the month reports back
 * to the page.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import BookingSlotPicker from '../BookingSlotPicker.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

// Tue 2026-03-03 and Thu 2026-03-05, 09:00 and 09:30 UTC.
const SLOTS = [Date.UTC(2026, 2, 3, 9, 0), Date.UTC(2026, 2, 3, 9, 30), Date.UTC(2026, 2, 5, 9, 0)];

function mountPicker(timeZone = 'UTC') {
	return mount(BookingSlotPicker, {
		props: {
			slots: SLOTS,
			timeZone,
			month: { year: 2026, month: 3 },
			selected: null,
			earliest: Date.UTC(2026, 2, 1),
			latest: Date.UTC(2026, 4, 30),
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiButton: { template: '<button type="button" v-bind="$attrs"><slot /></button>' },
				UiSkeleton: true,
				Icon: true,
			},
		},
	});
}

const dayButton = (wrapper: ReturnType<typeof mountPicker>, day: number) =>
	wrapper.findAll('button[aria-pressed]').find((button) => button.text() === String(day))!;

describe('BookingSlotPicker', () => {
	it('enables only the days with open times and opens the first one', () => {
		const wrapper = mountPicker();
		expect(dayButton(wrapper, 3).attributes('disabled')).toBeUndefined();
		expect(dayButton(wrapper, 5).attributes('disabled')).toBeUndefined();
		expect(dayButton(wrapper, 4).attributes('disabled')).toBeDefined();
		expect(dayButton(wrapper, 3).attributes('aria-pressed')).toBe('true');
		const times = wrapper.findAll('[data-testid="booking-slot"]').map((button) => button.text());
		expect(times).toEqual(['9:00 AM', '9:30 AM']);
	});

	it('shows the times in the chosen zone', () => {
		const wrapper = mountPicker('Europe/Berlin');
		const times = wrapper.findAll('[data-testid="booking-slot"]').map((button) => button.text());
		expect(times).toEqual(['10:00 AM', '10:30 AM']);
	});

	it('reports the picked time and the next month', async () => {
		const wrapper = mountPicker();
		await dayButton(wrapper, 5).trigger('click');
		await wrapper.get('[data-testid="booking-slot"]').trigger('click');
		expect(wrapper.emitted('update:selected')?.at(-1)).toEqual([SLOTS[2]]);

		await wrapper.get('[aria-label="Next month"]').trigger('click');
		expect(wrapper.emitted('update:month')?.at(-1)).toEqual([{ year: 2026, month: 4 }]);
	});
});
