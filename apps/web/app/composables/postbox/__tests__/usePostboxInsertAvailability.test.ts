// @vitest-environment happy-dom
/**
 * "Insert availability" (composables/postbox/usePostboxInsertAvailability):
 *   - inserts the open times and the booking link after what was written,
 *     above the signature and the quoted original;
 *   - with no booking page, inserts nothing and offers the settings page;
 *   - a failed read inserts nothing and says so.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { usePostboxInsertAvailability } from '../usePostboxInsertAvailability';

vi.mock('@owlat/api', () => ({
	api: { booking: { hostBookings: { availabilitySnippet: 'booking.availabilitySnippet' } } },
}));

const QUOTE = '<br><br><div class="gmail_quote"><blockquote>When are you free?</blockquote></div>';
const query = vi.fn();
const showToast = vi.fn();
const navigateTo = vi.fn();
let flagOn = true;

beforeEach(() => {
	query.mockReset();
	showToast.mockReset();
	navigateTo.mockReset();
	flagOn = true;
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useFeatureFlag: () => ({ isEnabled: (flag: string) => flag === 'calendar.booking' && flagOn }),
		useToast: () => ({ showToast }),
		requireConvex: () => ({ query }),
		navigateTo,
	});
});

function setup(body: string) {
	const bodyHtml = ref(body);
	let api!: ReturnType<typeof usePostboxInsertAvailability>;
	mount(
		defineComponent({
			setup() {
				api = usePostboxInsertAvailability(bodyHtml);
				return () => h('div');
			},
		}),
		{ global: { plugins: [createTestI18n()] } }
	);
	return { bodyHtml, api };
}

describe('usePostboxInsertAvailability', () => {
	it('puts the times and the link after the text, above the quote', async () => {
		query.mockResolvedValue({
			title: 'Intro',
			durationMinutes: 30,
			timeZone: 'UTC',
			url: 'https://owlat.example.com/book/ada/intro',
			slots: [Date.UTC(2026, 2, 3, 10, 0), Date.UTC(2026, 2, 3, 10, 30)],
		});
		const { bodyHtml, api } = setup(`<p>Hi Grace,</p>${QUOTE}`);
		expect(api.isAvailable.value).toBe(true);
		await api.insertAvailability();
		expect(bodyHtml.value.startsWith('<p>Hi Grace,</p><p>Here are a few times')).toBe(true);
		expect(bodyHtml.value).toContain('(UTC)');
		expect(bodyHtml.value.match(/<li>/g)).toHaveLength(2);
		expect(bodyHtml.value).toContain('href="https://owlat.example.com/book/ada/intro"');
		expect(bodyHtml.value.endsWith(QUOTE)).toBe(true);
	});

	it('offers the settings page when there is no booking page yet', async () => {
		query.mockResolvedValue(null);
		const { bodyHtml, api } = setup('<p>Hi</p>');
		await api.insertAvailability();
		expect(bodyHtml.value).toBe('<p>Hi</p>');
		const [message, type, options] = showToast.mock.calls[0]!;
		expect(type).toBe('info');
		expect(message).toMatch(/booking page/i);
		options.action.onAction();
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/preferences/booking');
	});

	it('says so when the times cannot be read', async () => {
		query.mockRejectedValue(new Error('offline'));
		const { bodyHtml, api } = setup('<p>Hi</p>');
		await api.insertAvailability();
		expect(bodyHtml.value).toBe('<p>Hi</p>');
		expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/could not/i), 'error');
		expect(api.isInserting.value).toBe(false);
	});

	it('is hidden while the booking page flag is off', () => {
		flagOn = false;
		expect(setup('').api.isAvailable.value).toBe(false);
	});
});
