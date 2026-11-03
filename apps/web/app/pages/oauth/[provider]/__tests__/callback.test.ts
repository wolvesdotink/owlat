/**
 * The page Google or Microsoft redirects back to after the consent screen.
 *
 * Everything that can go wrong here goes wrong in the user's face, on a page
 * they cannot retry by reloading: the authorization code is single-use, so a
 * second exchange fails and would paint an error over a mailbox that connected
 * fine. The cases below pin the three outcomes — exchanged and redirected,
 * declined at Google, and refused by the backend — plus the double-run guard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs } from '~/__tests__/a11y';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, { get: () => anyPath, apply: () => anyPath });
	return { api: anyPath };
});

import CallbackPage from '../callback.vue';

let run: ReturnType<typeof vi.fn>;
let navigateTo: ReturnType<typeof vi.fn>;
/** The label the page gave its operation: which provider's exchange it runs. */
let operationLabel: string | undefined;

function mountPage(query: Record<string, string>, provider = 'google') {
	const path = `/oauth/${provider}/callback`;
	installNuxtStubs({
		...i18nStubs,
		navigateTo,
		useRoute: () => ({ path, fullPath: path, params: { provider }, query }),
		useBackendOperation: (_fn: unknown, opts?: { label?: () => string }) => {
			operationLabel = opts?.label?.();
			return { run, isLoading: ref(false), inlineError: ref(null) };
		},
	});
	return mount(CallbackPage, {
		global: {
			plugins: [createTestI18n()],
			stubs: { UiCard: { template: '<div><slot /></div>' }, UiIconBox: true },
		},
	});
}

beforeEach(() => {
	run = vi.fn(async () => ({ ok: true, result: { mailboxId: 'mbx-1', returnTo: '/dashboard' } }));
	navigateTo = vi.fn();
});

describe('Google OAuth callback page', () => {
	it('exchanges the code and returns the user where the flow started', async () => {
		const wrapper = mountPage({ code: 'auth-code', state: 'state-1' });
		await flushPromises();

		expect(run).toHaveBeenCalledWith({ code: 'auth-code', state: 'state-1' });
		// `replace`, so Back does not re-enter a callback whose code is spent.
		expect(navigateTo).toHaveBeenCalledWith('/dashboard', { replace: true });
		expect(wrapper.text()).toContain('Connecting your Google mailbox');
	});

	it('does not spend the single-use code again on a re-render', async () => {
		const wrapper = mountPage({ code: 'auth-code', state: 'state-1' });
		await flushPromises();
		// A re-mount of the same page instance must not spend the code again.
		wrapper.vm.$forceUpdate();
		await flushPromises();

		expect(run).toHaveBeenCalledTimes(1);
	});

	it('explains a declined consent instead of reporting a fault', async () => {
		const wrapper = mountPage({ error: 'access_denied', state: 'state-1' });
		await flushPromises();

		expect(run).not.toHaveBeenCalled();
		expect(wrapper.text()).toContain('sign-in was cancelled');
		expect(wrapper.text()).toContain('Back to mail import');
	});

	it('shows a way back when the exchange is refused', async () => {
		run.mockResolvedValueOnce({ ok: false });
		const wrapper = mountPage({ code: 'auth-code', state: 'stale' });
		await flushPromises();

		expect(navigateTo).not.toHaveBeenCalled();
		expect(wrapper.text()).toContain('could not be completed');
		expect(wrapper.text()).toContain('Back to mail import');
	});

	it('refuses a link that arrived without a code', async () => {
		const wrapper = mountPage({ state: 'state-1' });
		await flushPromises();

		expect(run).not.toHaveBeenCalled();
		expect(wrapper.text()).toContain('This link is incomplete');
	});
});

describe('Microsoft OAuth callback page', () => {
	it('exchanges the code through the Microsoft action', async () => {
		const wrapper = mountPage({ code: 'auth-code', state: 'state-1' }, 'microsoft');
		await flushPromises();

		expect(operationLabel).toBe('Finish Microsoft sign-in');
		expect(run).toHaveBeenCalledWith({ code: 'auth-code', state: 'state-1' });
		expect(navigateTo).toHaveBeenCalledWith('/dashboard', { replace: true });
		expect(wrapper.text()).toContain('Connecting your Microsoft mailbox');
	});

	it('points a declined work account at its admin', async () => {
		const wrapper = mountPage({ error: 'access_denied', state: 'state-1' }, 'microsoft');
		await flushPromises();

		expect(run).not.toHaveBeenCalled();
		expect(wrapper.text()).toContain('Microsoft sign-in not completed');
		expect(wrapper.text()).toContain('admin may have to approve Owlat');
	});

	it('exchanges nothing on a provider path nobody was sent to', async () => {
		const wrapper = mountPage({ code: 'auth-code', state: 'state-1' }, 'yahoo');
		await flushPromises();

		expect(run).not.toHaveBeenCalled();
		expect(wrapper.text()).toContain('This link is incomplete');
	});
});
