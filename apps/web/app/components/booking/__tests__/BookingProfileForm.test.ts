// @vitest-environment happy-dom
/**
 * The booking page settings form (components/booking/BookingProfileForm): it
 * keeps what the member is typing when the settings query re-runs with the
 * same stored page (a meeting type saved or toggled further up the page), and
 * picks up a stored page that really changed.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.stubGlobal('useBackendOperation', () => ({
	run: vi.fn(async () => ({ ok: true })),
	isLoading: ref(false),
}));

import BookingProfileForm, { type StoredBookingProfile } from '../BookingProfileForm.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function stored(overrides: Partial<StoredBookingProfile> = {}): StoredBookingProfile {
	return {
		slug: 'ada',
		displayName: 'Ada',
		timeZone: 'UTC',
		weeklyHours: [{ weekday: 1, startMinute: 9 * 60, endMinute: 17 * 60 }],
		dateOverrides: [],
		minimumNoticeMinutes: 240,
		horizonDays: 30,
		bufferMinutes: 0,
		...overrides,
	};
}

function mountForm(profile: StoredBookingProfile) {
	return mount(BookingProfileForm, {
		props: { profile, suggestedSlug: 'ada', siteOrigin: 'https://owlat.example.com' },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiButton: { template: '<button type="button" v-bind="$attrs"><slot /></button>' },
				BookingRangesEditor: true,
				Icon: true,
			},
		},
	});
}

describe('BookingProfileForm', () => {
	it('keeps unsaved edits when the query re-runs with the same stored page', async () => {
		const wrapper = mountForm(stored());
		const name = wrapper.get<HTMLInputElement>('#booking-display-name');
		await name.setValue('Ada Lovelace');

		// A fresh object with the same content: what Convex hands back after an
		// unrelated write re-ran the settings query.
		await wrapper.setProps({ profile: stored() });
		expect(name.element.value).toBe('Ada Lovelace');
	});

	it('reseeds when the stored page changed', async () => {
		const wrapper = mountForm(stored());
		const name = wrapper.get<HTMLInputElement>('#booking-display-name');
		await name.setValue('Ada Lovelace');

		await wrapper.setProps({ profile: stored({ displayName: 'Countess' }) });
		expect(name.element.value).toBe('Countess');
	});
});
