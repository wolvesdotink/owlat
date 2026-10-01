// @vitest-environment happy-dom
/**
 * The recipient pages' failure and "already done" states (#865).
 *
 * Every page reads the endpoint's machine-readable reason and shows its own
 * localized copy. The backend's English `message` never reaches the recipient,
 * and the one-click unsubscribe reads `alreadyUnsubscribed` instead of
 * searching that sentence for "already".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import UnsubscribePage from '../unsubscribe.vue';
import PreferencesPage from '../preferences.vue';
import ConfirmPage from '../confirm.vue';
import ArchivePage from '../archive.vue';
import SharePage from '../share.vue';

type Answer = { status: number; body: unknown };

/** Answers by path prefix; the POST answer is picked by method. */
let answers: Record<string, Answer>;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
	const path = url.replace('https://api.test', '');
	const key = Object.keys(answers)
		.filter((prefix) => `${init?.method ?? 'GET'} ${path}`.startsWith(prefix))
		.sort((a, b) => b.length - a.length)[0];
	if (!key) throw new Error(`unstubbed fetch: ${init?.method ?? 'GET'} ${path}`);
	const { status, body } = answers[key]!;
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => {
			if (body === undefined) throw new SyntaxError('Unexpected token <');
			return body;
		},
	};
});

const convex = { query: vi.fn(), mutation: vi.fn() };

const contact = {
	email: 'ada@example.com',
	firstName: 'Ada',
	subscribed: true,
	organizationName: 'Analytical Engines',
	teamName: 'Analytical Engines',
	topics: [{ _id: 'topic1', name: 'Product news', subscribed: true }],
};

beforeEach(() => {
	window.sessionStorage.clear();
	answers = {};
	fetchMock.mockClear();
	convex.query.mockReset();
	convex.mutation.mockReset();
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('fetch', fetchMock);
	vi.stubGlobal('useSeoMeta', vi.fn());
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useRoute', () => ({ path: '/', query: { token: 'tok' }, hash: '' }));
	vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }));
	vi.stubGlobal('useRuntimeConfig', () => ({ public: { convexSiteUrl: 'https://api.test' } }));
	vi.stubGlobal('useConvex', () => convex);
	vi.stubGlobal('useRecipientSender', () => ({
		senderName: ref('Analytical Engines'),
		contactEmail: ref(null),
		logo: ref(null),
	}));
});

const ButtonStub = {
	emits: ['click'],
	template: '<button type="button" @click="$emit(\'click\')"><slot /></button>',
};

async function mountPage(page: object) {
	const wrapper = mount(page, {
		global: {
			plugins: [createTestI18n()],
			components: { UiButton: ButtonStub },
			stubs: {
				UiSpinner: true,
				UiSwitch: true,
				RecipientHeader: true,
				RecipientFooter: true,
				RecipientContactHint: true,
			},
		},
	});
	await flushPromises();
	return wrapper;
}

async function click(wrapper: Awaited<ReturnType<typeof mountPage>>, label: string) {
	const button = wrapper.findAll('button').find((b) => b.text().includes(label));
	if (!button) throw new Error(`no button "${label}"`);
	await button.trigger('click');
	await flushPromises();
}

describe('unsubscribe', () => {
	beforeEach(() => {
		answers['GET /unsub/verify/'] = { status: 200, body: { ok: true, data: contact } };
	});

	it('reads alreadyUnsubscribed, not the English message', async () => {
		answers['POST /unsub/'] = {
			status: 200,
			body: {
				ok: true,
				data: { message: 'Nothing left to do', listsRemoved: 0, alreadyUnsubscribed: true },
			},
		};
		const w = await mountPage(UnsubscribePage);
		await click(w, 'Yes, unsubscribe me');

		expect(fetchMock).toHaveBeenLastCalledWith('https://api.test/unsub/tok', { method: 'POST' });
		expect(w.find('h2').text()).toBe('Already unsubscribed');
	});

	it('shows the success heading when the flag is false, whatever the message says', async () => {
		answers['POST /unsub/'] = {
			status: 200,
			body: {
				ok: true,
				data: {
					message: 'You were already unsubscribed from all topics',
					listsRemoved: 1,
					alreadyUnsubscribed: false,
				},
			},
		};
		const w = await mountPage(UnsubscribePage);
		await click(w, 'Yes, unsubscribe me');
		expect(w.find('h2').text()).toBe('You are unsubscribed');
	});

	it('shows localized copy for a failed POST, never the backend message', async () => {
		answers['POST /unsub/'] = {
			status: 400,
			body: {
				error: {
					category: 'invalid_input',
					message: 'Invalid or expired unsubscribe link',
					data: { reason: 'invalid_signature' },
				},
			},
		};
		const w = await mountPage(UnsubscribePage);
		await click(w, 'Yes, unsubscribe me');

		expect(w.text()).toContain('Unable to unsubscribe');
		expect(w.text()).toContain('Failed to process unsubscribe request. Please try again.');
		expect(w.text()).not.toContain('Invalid or expired unsubscribe link');
	});

	it('maps an expired verify link to the expired copy', async () => {
		answers['GET /unsub/verify/'] = { status: 200, body: { ok: false, reason: 'expired' } };
		const w = await mountPage(UnsubscribePage);
		expect(w.text()).toContain('This unsubscribe link has expired.');
	});
});

describe('preferences', () => {
	it('keeps the form and shows localized copy when a save fails', async () => {
		answers['GET /prefs/verify/'] = { status: 200, body: { ok: true, data: contact } };
		answers['POST /prefs/update/'] = {
			status: 404,
			body: {
				error: {
					category: 'not_found',
					message: 'Failed to update preferences',
					data: { reason: 'not_found' },
				},
			},
		};
		const w = await mountPage(PreferencesPage);
		// Flip the one topic through the switch's own event.
		w.findAllComponents({ name: 'UiSwitch' }).at(1)!.vm.$emit('update:modelValue', false);
		await flushPromises();
		await click(w, 'Save preferences');

		expect(w.text()).toContain('Manage your email preferences');
		expect(w.text()).toContain('Failed to save preferences. Please try again.');
		expect(w.text()).not.toContain('Failed to update preferences');
		expect(w.find('[role="alert"]').text()).toContain('Failed to save preferences.');
	});

	it('announces a save and drops the banner timer on unmount', async () => {
		answers['GET /prefs/verify/'] = { status: 200, body: { ok: true, data: contact } };
		answers['POST /prefs/update/'] = { status: 200, body: { ok: true, data: {} } };
		const w = await mountPage(PreferencesPage);
		w.findAllComponents({ name: 'UiSwitch' }).at(1)!.vm.$emit('update:modelValue', false);
		await flushPromises();
		const clear = vi.spyOn(globalThis, 'clearTimeout');
		try {
			await click(w, 'Save preferences');
			expect(w.find('[role="status"]').text()).toContain(
				'Your preferences have been saved successfully.'
			);
			clear.mockClear();
			w.unmount();
			expect(clear).toHaveBeenCalledTimes(1);
		} finally {
			clear.mockRestore();
		}
	});
});

describe('confirm', () => {
	it('shows localized copy when the confirmation throws', async () => {
		convex.query.mockResolvedValue({
			email: contact.email,
			organizationName: contact.organizationName,
			status: 'pending_confirmation',
		});
		convex.mutation.mockRejectedValue(new Error('[CONVEX M(forms:confirm)] Server Error'));
		const w = await mountPage(ConfirmPage);
		await click(w, 'Confirm subscription');

		expect(w.text()).toContain('Failed to confirm subscription. Please try again.');
		expect(w.text()).not.toContain('Server Error');
	});

	it('maps the mutation error code to its copy', async () => {
		convex.query.mockResolvedValue({
			email: contact.email,
			organizationName: contact.organizationName,
			status: 'pending_confirmation',
		});
		convex.mutation.mockResolvedValue({ success: false, error: 'token_expired' });
		const w = await mountPage(ConfirmPage);
		await click(w, 'Confirm subscription');
		expect(w.text()).toContain('This confirmation link has expired.');
	});
});

describe('archive', () => {
	it('reads archive_not_found from the body, not the status', async () => {
		answers['GET /archive/'] = {
			status: 404,
			body: {
				error: {
					category: 'not_found',
					message: 'Archive not found',
					data: { reason: 'archive_not_found' },
				},
			},
		};
		const w = await mountPage(ArchivePage);
		expect(w.text()).toContain('This archive link is invalid');
	});

	it('shows the load failure for an answer that is not JSON', async () => {
		answers['GET /archive/'] = { status: 502, body: undefined };
		const w = await mountPage(ArchivePage);
		expect(w.text()).toContain('Unable to load the campaign archive.');
	});

	it('frames the email with the one public sandbox policy', async () => {
		answers['GET /archive/'] = {
			status: 200,
			body: {
				ok: true,
				data: {
					html: '<p>Hello</p>',
					subject: 'January news',
					sentAt: Date.UTC(2026, 0, 14),
					organizationName: 'Analytical Engines',
				},
			},
		};
		const w = await mountPage(ArchivePage);
		const frame = w.find('iframe');
		expect(w.find('h1').text()).toBe('January news');
		expect(frame.attributes('sandbox')).toBe('allow-same-origin');
		expect(frame.attributes('title')).toBe('Archived email');
	});
});

describe('share', () => {
	it('shows the expired state for a 404 carrying reason expired', async () => {
		answers['GET /share/'] = {
			status: 404,
			body: {
				error: {
					category: 'not_found',
					message: 'This share link has expired',
					data: { reason: 'expired' },
				},
			},
		};
		const w = await mountPage(SharePage);
		expect(w.find('h2').text()).toBe('Preview link expired');
	});

	it('shows the revoked copy for any other reason', async () => {
		answers['GET /share/'] = {
			status: 404,
			body: { error: { data: { reason: 'share_link_not_found' } } },
		};
		const w = await mountPage(SharePage);
		expect(w.text()).toContain('This share link is invalid or has been revoked.');
	});

	it('shows the load failure when the request never completes', async () => {
		fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
		const w = await mountPage(SharePage);
		expect(w.text()).toContain('Unable to load the preview.');
	});
});
