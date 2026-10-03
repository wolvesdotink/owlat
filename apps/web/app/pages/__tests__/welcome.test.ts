// @vitest-environment happy-dom
/**
 * /welcome stamps `welcomedAt` on mount. Once that has committed it also
 * remembers the member as welcomed on this device, through the same cache the
 * first-login middleware reads, so the next session skips the onboarding query
 * and the E2E setup has a deterministic "done" signal to wait for. A failed
 * stamp must not be cached: the cache would then claim something the server
 * does not know, and the member would never be offered the welcome again.
 *
 * A failed stamp is retried with backoff (#1203). Once the retries are spent the
 * page says so quietly and offers to try again; nothing is blocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { markConvexAuthPending, reportConvexAuth } from '~/lib/convexAuthReady';
import { TRANSIENT_RETRY_LIMIT } from '~/lib/queryRetry';

import WelcomePage from '../welcome.vue';

const USER_ID = 'user-1';
const CACHE_KEY = `owlat:welcomed:${USER_ID}`;

const mutation = vi.fn<(fn: unknown, args: unknown) => Promise<unknown>>();
/** Longer than any backoff step (8 s cap plus 20% spread). */
const PAST_ANY_BACKOFF = 20_000;

vi.mock('~/lib/runtimeLog', () => ({ logWarn: vi.fn(), logError: vi.fn() }));
const state = new Map<string, { value: unknown }>();

beforeEach(() => {
	localStorage.clear();
	state.clear();
	mutation.mockReset();
	reportConvexAuth(true);

	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useAuth', () => ({ user: ref({ id: USER_ID, name: 'Ada Lovelace' }) }));
	vi.stubGlobal('useOrganizationContext', () => ({ organization: ref({ name: 'Acme' }) }));
	vi.stubGlobal('useNuxtApp', () => ({ $convex: { mutation } }));
	vi.stubGlobal('useConvexQuery', () => ({
		data: ref({ isMigrationMode: false }),
		isLoading: ref(false),
	}));
	vi.stubGlobal('useState', (key: string, init: () => unknown) => {
		if (!state.has(key)) state.set(key, ref(init()));
		return state.get(key);
	});
});

afterEach(() => {
	vi.useRealTimers();
});

function mountPage() {
	return mount(WelcomePage, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				OnboardingFreshStart: true,
				UiIconBox: true,
				UiSpinner: true,
				Icon: true,
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot/></a>' },
			},
		},
	});
}

describe('/welcome — the welcomed cache', () => {
	it('stamps welcomedAt and caches it once the mutation has committed', async () => {
		let commit!: () => void;
		mutation.mockReturnValue(new Promise<void>((resolve) => (commit = resolve)).then(() => null));

		mountPage();
		await flushPromises();

		expect(mutation).toHaveBeenCalledTimes(1);
		const [fn, args] = mutation.mock.calls[0]!;
		expect(getFunctionName(fn as never)).toBe(
			getFunctionName(api.auth.userOnboarding.markWelcomed)
		);
		expect(args).toEqual({ userId: USER_ID });
		// Not before the server has it.
		expect(localStorage.getItem(CACHE_KEY)).toBeNull();

		commit();
		await flushPromises();
		expect(localStorage.getItem(CACHE_KEY)).toBe('1');
	});

	it('retries a failed stamp and caches once a retry commits', async () => {
		vi.useFakeTimers();
		mutation.mockRejectedValueOnce(new Error('Function execution timed out'));
		mutation.mockResolvedValueOnce(null);

		const wrapper = mountPage();
		await vi.advanceTimersByTimeAsync(0);
		expect(mutation).toHaveBeenCalledTimes(1);
		expect(localStorage.getItem(CACHE_KEY)).toBeNull();

		await vi.advanceTimersByTimeAsync(PAST_ANY_BACKOFF);
		expect(mutation).toHaveBeenCalledTimes(2);
		expect(localStorage.getItem(CACHE_KEY)).toBe('1');
		expect(wrapper.find('[data-testid="welcome-stamp-failed"]').exists()).toBe(false);
	});

	it('keeps the welcome usable while retrying: no note before the retries are spent', async () => {
		vi.useFakeTimers();
		mutation.mockRejectedValue(new Error('Server Error'));

		const wrapper = mountPage();
		// Past the first backoff step (1 s ±20%), short of the second (2 s ±20%).
		await vi.advanceTimersByTimeAsync(1_500);

		expect(mutation).toHaveBeenCalledTimes(2);
		expect(wrapper.find('[data-testid="welcome-stamp-failed"]').exists()).toBe(false);
	});

	it('does not cache when every attempt fails, and offers a quiet retry', async () => {
		vi.useFakeTimers();
		mutation.mockRejectedValue(new Error('Server Error'));

		const wrapper = mountPage();
		await vi.advanceTimersByTimeAsync(PAST_ANY_BACKOFF * (TRANSIENT_RETRY_LIMIT + 1));

		expect(mutation).toHaveBeenCalledTimes(TRANSIENT_RETRY_LIMIT + 1);
		expect(localStorage.getItem(CACHE_KEY)).toBeNull();
		// The welcome itself still renders; the note sits below it.
		expect(wrapper.text()).toContain('Acme');
		const note = wrapper.find('[data-testid="welcome-stamp-failed"]');
		expect(note.exists()).toBe(true);
		expect(note.attributes('role')).toBe('status');
		expect(note.text()).toContain('you may see this screen again next time');
		expect(note.find('button').text()).toBe('Try again');
	});

	it('stamps again from the retry note and clears it once that commits', async () => {
		vi.useFakeTimers();
		mutation.mockRejectedValue(new Error('Server Error'));
		const wrapper = mountPage();
		await vi.advanceTimersByTimeAsync(PAST_ANY_BACKOFF * (TRANSIENT_RETRY_LIMIT + 1));
		expect(mutation).toHaveBeenCalledTimes(TRANSIENT_RETRY_LIMIT + 1);

		let commit!: () => void;
		mutation.mockReturnValueOnce(
			new Promise<void>((resolve) => (commit = resolve)).then(() => null)
		);
		await wrapper.find('[data-testid="welcome-stamp-failed"] button').trigger('click');
		await vi.advanceTimersByTimeAsync(0);

		expect(mutation).toHaveBeenCalledTimes(TRANSIENT_RETRY_LIMIT + 2);
		const button = wrapper.find('[data-testid="welcome-stamp-failed"] button');
		expect(button.attributes('disabled')).toBeDefined();
		expect(button.text()).toBe('Trying again…');

		commit();
		await vi.advanceTimersByTimeAsync(0);
		expect(localStorage.getItem(CACHE_KEY)).toBe('1');
		expect(wrapper.find('[data-testid="welcome-stamp-failed"]').exists()).toBe(false);
	});

	it('waits for Convex auth before stamping', async () => {
		markConvexAuthPending();
		mutation.mockResolvedValue(null);

		mountPage();
		await flushPromises();
		expect(mutation).not.toHaveBeenCalled();

		reportConvexAuth(true);
		await flushPromises();
		expect(mutation).toHaveBeenCalledTimes(1);
		expect(localStorage.getItem(CACHE_KEY)).toBe('1');
	});

	it('does not stamp while the client is anonymous, and stamps once a new token is accepted', async () => {
		vi.useFakeTimers();
		// A token fetch failed during one of the re-auths that follow sign-in.
		reportConvexAuth(false);
		mutation.mockResolvedValue(null);

		mountPage();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(mutation).not.toHaveBeenCalled();

		markConvexAuthPending();
		reportConvexAuth(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(mutation).toHaveBeenCalledTimes(1);
		expect(localStorage.getItem(CACHE_KEY)).toBe('1');
	});

	it('resolves the first-login check for the session before anything is stamped', () => {
		mutation.mockReturnValue(new Promise(() => {}));

		mountPage();

		expect(state.get('first-login-resolved')?.value).toBe(true);
	});
});
