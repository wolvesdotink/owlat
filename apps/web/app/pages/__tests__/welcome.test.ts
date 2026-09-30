// @vitest-environment happy-dom
/**
 * /welcome stamps `welcomedAt` on mount. Once that has committed it also
 * remembers the member as welcomed on this device, through the same cache the
 * first-login middleware reads, so the next session skips the onboarding query
 * and the E2E setup has a deterministic "done" signal to wait for. A failed
 * stamp must not be cached: the cache would then claim something the server
 * does not know, and the member would never be offered the welcome again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { markConvexAuthPending, reportConvexAuth } from '~/lib/convexAuthReady';

import WelcomePage from '../welcome.vue';

const USER_ID = 'user-1';
const CACHE_KEY = `owlat:welcomed:${USER_ID}`;

const mutation = vi.fn<(fn: unknown, args: unknown) => Promise<unknown>>();
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

	it('does not cache when the stamp fails, and shows no error', async () => {
		mutation.mockRejectedValue(new Error('Server Error'));

		const wrapper = mountPage();
		await flushPromises();

		expect(mutation).toHaveBeenCalledTimes(1);
		expect(localStorage.getItem(CACHE_KEY)).toBeNull();
		expect(wrapper.text()).toContain('Acme');
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

	it('resolves the first-login check for the session before anything is stamped', () => {
		mutation.mockReturnValue(new Promise(() => {}));

		mountPage();

		expect(state.get('first-login-resolved')?.value).toBe(true);
	});
});
