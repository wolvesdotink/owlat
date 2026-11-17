/**
 * The Terms and Imprint pages are public: an anonymous visit makes no auth
 * request. Building the session store is what starts `/get-session`, so the
 * pages may read a store an app route already built and never build one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import ImprintPage from '../imprint.vue';
import TermsPage from '../terms.vue';

const session = ref<{ data: unknown; isPending: boolean; error: unknown }>({
	data: null,
	isPending: false,
	error: null,
});
const useSession = vi.fn(() => session);

vi.mock('~/lib/auth-client', () => ({ authClient: { useSession: () => useSession() } }));
vi.mock('~/lib/convex-auth', () => ({ resetConvexAuthTokenCache: vi.fn() }));

const pages = [
	{ name: 'terms', component: TermsPage },
	{ name: 'imprint', component: ImprintPage },
] as const;

/** A fresh document: the auth composable with no session store built yet. */
async function freshDocument() {
	vi.resetModules();
	const auth = await import('~/composables/useAuth');
	installNuxtStubs({
		...i18nStubs,
		useRuntimeConfig: () => ({ public: { deploymentMode: 'selfhost', companyName: '' } }),
		useAuth: auth.useAuth,
		useKnownSignedIn: auth.useKnownSignedIn,
	});
	return auth;
}

function mountPage(component: object) {
	return mount(component, { global: { plugins: [createTestI18n()] } });
}

/** Where the header's one action leads. */
function headerAction(wrapper: ReturnType<typeof mountPage>) {
	const action = wrapper.find('nav a.btn');
	return { to: action.attributes('href'), label: action.text() };
}

beforeEach(() => {
	useSession.mockClear();
	session.value = { data: null, isPending: false, error: null };
});

describe.each(pages)('$name page session', ({ component }) => {
	it('builds no session store on a first visit, and offers sign-in', async () => {
		await freshDocument();
		const wrapper = mountPage(component);

		expect(useSession).not.toHaveBeenCalled();
		expect(headerAction(wrapper)).toEqual({ to: '/auth/login', label: 'Sign in' });
	});

	it('offers the app when an app route already found a session', async () => {
		const auth = await freshDocument();
		session.value = { data: { user: { id: 'user1' } }, isPending: false, error: null };
		auth.warmAuthSession();
		const wrapper = mountPage(component);

		expect(headerAction(wrapper)).toEqual({ to: '/dashboard', label: 'Open app' });

		session.value = { data: null, isPending: false, error: null };
		await nextTick();
		expect(headerAction(wrapper)).toEqual({ to: '/auth/login', label: 'Sign in' });
	});

	it('offers sign-in while an existing store is still loading', async () => {
		const auth = await freshDocument();
		session.value = { data: null, isPending: true, error: null };
		auth.warmAuthSession();

		expect(headerAction(mountPage(component))).toEqual({ to: '/auth/login', label: 'Sign in' });
	});
});
