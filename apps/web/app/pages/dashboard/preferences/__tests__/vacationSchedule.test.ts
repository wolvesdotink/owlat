/**
 * The auto-reply schedule round trip. A `datetime-local` input has no zone and
 * the page saves it as local time, so it must show the stored instant in local
 * time as well: opening the page and saving unchanged keeps the window where it
 * was, in any zone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import VacationPage from '../vacation.vue';

const START = Date.UTC(2026, 6, 1, 8, 0);
const END = Date.UTC(2026, 6, 14, 17, 30);

const upsert = vi.fn(async () => ({ ok: true, result: null }));
let previousTz: string | undefined;

beforeAll(() => {
	previousTz = process.env.TZ;
	process.env.TZ = 'Europe/Berlin';
});

afterAll(() => {
	process.env.TZ = previousTz;
});

beforeEach(() => {
	upsert.mockClear();
	installNuxtStubs({
		...i18nStubs,
		usePostboxMailbox: () => ({
			currentMailbox: ref({ _id: 'mb_1' }),
			isLoading: ref(false),
			error: ref(null),
			refetch: vi.fn(),
		}),
		useConvexQuery: () => ({
			data: ref({
				isEnabled: true,
				subject: 'Away',
				bodyText: 'Back soon',
				startAt: START,
				endAt: END,
				replyIntervalDays: 7,
			}),
			isLoading: ref(false),
			error: ref(null),
			refetch: vi.fn(),
		}),
		useBackendOperation: () => ({ run: upsert, isLoading: ref(false) }),
	});
});

function mountPage() {
	return mount(VacationPage, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiQueryBoundary: { template: '<div><slot /></div>' },
				UiSwitch: true,
				UiSkeleton: true,
				UiConfirmationDialog: true,
				UiButton: {
					inheritAttrs: false,
					template: '<button v-bind="$attrs"><slot /></button>',
				},
			},
		},
	});
}

describe('vacation schedule', () => {
	it('shows the stored window in local time and saves it back unchanged', async () => {
		const wrapper = mountPage();
		await flushPromises();
		// 08:00 UTC is 10:00 in Berlin summer time.
		expect((wrapper.get('#draft-startat').element as HTMLInputElement).value).toBe(
			'2026-07-01T10:00'
		);
		expect((wrapper.get('#draft-endat').element as HTMLInputElement).value).toBe(
			'2026-07-14T19:30'
		);

		const save = wrapper.findAll('button').find((b) => b.text() === 'Save');
		await save!.trigger('click');
		await flushPromises();
		expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ startAt: START, endAt: END }));
	});
});
