// @vitest-environment happy-dom
/**
 * The extracted surfaces, rendered.
 *
 * The catalog guard (localeCatalogs.test.ts) proves the MESSAGES are sound; it
 * cannot prove a page still shows them. Everything that goes wrong after
 * extraction goes wrong here: a keypath typo renders `auth.login.submit` as
 * body copy, an `<I18nT>` slot renamed on one side leaves a literal `{email}`
 * on screen, a control loses its accessible name because the label was bound to
 * a message that does not exist. So these suites mount each extracted surface
 * against the REAL `en` catalog and assert the copy a browser would paint —
 * plus, for every one of them, that no raw key path and no unfilled
 * `{placeholder}` survives into visible text, placeholders or accessible names.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';

import { createTestI18n, expectFullyLocalized, i18nStubs } from './i18n';
import UiInput from '../../../../packages/ui/components/ui/Input.vue';
import AuthShell from '../components/auth/AuthShell.vue';
import LoginPage from '../pages/auth/login.vue';
import RegisterPage from '../pages/auth/register.vue';
import ForgotPasswordPage from '../pages/auth/forgot-password.vue';
import ResetPasswordPage from '../pages/auth/reset-password.vue';
import WelcomePage from '../pages/welcome.vue';

// ── Nuxt auto-imports the pages reach for ──
let routeQuery: Record<string, string> = {};
let headOptions: { title?: () => string } = {};
const signInWithEmail = vi.fn(async () => ({}));
const signUpWithEmail = vi.fn(async () => ({ user: { id: 'user-1' } }));
const forgotPassword = vi.fn(async () => undefined);
const resetPassword = vi.fn(async () => undefined);
const organization = ref<{ name: string } | null>(null);
const user = ref<{ id: string; name?: string } | null>({ id: 'user-1' });
const workspaceSettings = ref<{ isMigrationMode: boolean } | undefined>({ isMigrationMode: false });
const settingsLoading = ref(false);

/** The real `useAuthForm`, small enough to reproduce: run the effect, hold errors. */
function fakeAuthForm() {
	const isLoading = ref(false);
	const errorMessage = ref('');
	return {
		isLoading,
		errorMessage,
		submit: async (fn: () => Promise<void>) => {
			isLoading.value = true;
			try {
				await fn();
			} finally {
				isLoading.value = false;
			}
		},
	};
}

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useHead: (options: { title?: () => string }) => {
			headOptions = options;
		},
		definePageMeta: () => {},
		navigateTo: vi.fn(),
		safeRedirect: (value: unknown, fallback: string) =>
			typeof value === 'string' ? value : fallback,
		useRoute: () => ({ query: routeQuery }),
		useRouter: () => ({ push: vi.fn() }),
		useAuth: () => ({
			user,
			signInWithEmail,
			signUpWithEmail,
			forgotPassword,
			resetPassword,
		}),
		useAuthForm: fakeAuthForm,
		useBackendOperation: () => ({ run: vi.fn(async () => null), isLoading: ref(false) }),
		useOrganizationContext: () => ({ organization }),
		useConvexQuery: () => ({ data: workspaceSettings, isLoading: settingsLoading }),
		useNuxtApp: () => ({ $convex: null }),
		useState: (_key: string, init: () => unknown) => ref(init()),
		useSlots: () => ({}),
	});
});

beforeEach(() => {
	routeQuery = {};
	headOptions = {};
	organization.value = null;
	user.value = { id: 'user-1' };
	workspaceSettings.value = { isMigrationMode: false };
	settingsLoading.value = false;
	vi.clearAllMocks();
});

/** Renders its default slot so link/button copy survives into `w.text()`. */
const NuxtLinkStub = defineComponent({
	name: 'NuxtLink',
	props: { to: { type: String, default: '' } },
	setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()),
});

/** The decorative background field carries no copy; everything else is real. */
const HeroFieldStub = { template: '<div />' };

function mountSurface(component: unknown) {
	return mount(component as never, {
		global: {
			plugins: [createTestI18n()],
			components: { NuxtLink: NuxtLinkStub, UiInput, AuthShell },
			stubs: {
				Icon: { template: '<span />' },
				UiHeroField: HeroFieldStub,
				UiSpinner: { template: '<span />' },
				UiIconBox: { template: '<span />' },
				OnboardingFreshStart: { template: '<div data-testid="fresh-start" />' },
			},
		},
	});
}

describe('auth/login', () => {
	it('renders the sign-in copy from the catalog', () => {
		const w = mountSurface(LoginPage);

		expect(w.text()).toContain('Welcome');
		expect(w.text()).toContain('back');
		expect(w.text()).toContain('Sign in to your Owlat account.');
		expect(w.text()).toContain('Email');
		expect(w.text()).toContain('Password');
		expect(w.text()).toContain('Forgot password?');
		expect(w.text()).toContain('Sign in');
		expect(w.text()).toContain("Don't have an account?");
		expect(w.text()).toContain('Create one');
		expect(w.get('#email').attributes('placeholder')).toBe('you@example.com');
		expect(w.get('#password').attributes('placeholder')).toBe('Enter your password');
		expectFullyLocalized(w);
	});

	it('titles the document through a getter, so it follows the locale', () => {
		mountSurface(LoginPage);
		expect(headOptions.title?.()).toBe('Login — Owlat');
	});

	it('shows the post-setup banner arriving from the first-run wizard', () => {
		routeQuery = { postSetup: '1', email: 'admin@example.com' };
		const w = mountSurface(LoginPage);

		expect(w.text()).toContain('Your Owlat instance is ready.');
		expectFullyLocalized(w);
	});

	it('renders validation copy, not a key path, for an empty submit', async () => {
		const w = mountSurface(LoginPage);
		await w.get('form').trigger('submit');

		expect(w.text()).toContain('Email is required');
		expect(w.text()).toContain('Password is required');
		expectFullyLocalized(w);
	});
});

describe('auth/register', () => {
	it('renders the invite-only wall when the visit is not an invite redirect', () => {
		const w = mountSurface(RegisterPage);

		expect(w.text()).toContain('Welcome to');
		expect(w.text()).toContain('Owlat is invite only.');
		expect(w.text()).toContain('Registration is disabled.');
		expect(w.text()).toContain('Already have an account?');
		expect(w.find('form').exists()).toBe(false);
		expectFullyLocalized(w);
	});

	it('renders the form and the interpolated terms sentence for an invited visitor', () => {
		routeQuery = { redirect: '/invite/accept?token=abc' };
		const w = mountSurface(RegisterPage);

		expect(w.text()).toContain('Create your');
		expect(w.text()).toContain("You've been invited to an Owlat workspace.");
		expect(w.text()).toContain('Name');
		expect(w.text()).toContain('Must be at least 10 characters');
		// `terms` is one sentence with a link slot — never two concatenated halves.
		expect(w.text()).toContain('I agree to the');
		expect(w.text()).toContain('Terms of Service');
		expect(w.text()).toContain('Create account');
		expectFullyLocalized(w);
	});

	it('renders every field-level validation message for an empty submit', async () => {
		routeQuery = { redirect: '/invite/accept?token=abc' };
		const w = mountSurface(RegisterPage);
		await w.get('form').trigger('submit');

		expect(w.text()).toContain('Name is required');
		expect(w.text()).toContain('Email is required');
		expect(w.text()).toContain('Password is required');
		expect(w.text()).toContain('You must agree to the Terms of Service');
		expectFullyLocalized(w);
	});
});

describe('auth/forgot-password', () => {
	it('renders the request form', () => {
		const w = mountSurface(ForgotPasswordPage);

		expect(w.text()).toContain('Reset your');
		expect(w.text()).toContain("Enter your email address and we'll send you a link");
		expect(w.text()).toContain('Send reset link');
		expect(w.text()).toContain('Back to login');
		expectFullyLocalized(w);
	});

	it('interpolates the address into the confirmation instead of leaking {email}', async () => {
		const w = mountSurface(ForgotPasswordPage);
		await w.get('#email').setValue('marcel@hinterland.camp');
		await w.get('form').trigger('submit');
		await flushPromises();

		expect(forgotPassword).toHaveBeenCalledWith('marcel@hinterland.camp');
		expect(w.text()).toContain('Check your email');
		expect(w.text()).toContain('If an account exists for marcel@hinterland.camp');
		expectFullyLocalized(w);
	});
});

describe('auth/reset-password', () => {
	it('renders the dead-link state when the URL carries no token', () => {
		const w = mountSurface(ResetPasswordPage);

		expect(w.text()).toContain('Invalid or missing reset link');
		expect(w.text()).toContain('Request new reset link');
		expect(w.find('form').exists()).toBe(false);
		expectFullyLocalized(w);
	});

	it('renders the form for a tokenised link', () => {
		routeQuery = { token: 'reset-token' };
		const w = mountSurface(ResetPasswordPage);

		expect(w.text()).toContain('Set a new');
		expect(w.text()).toContain('New password');
		expect(w.text()).toContain('Confirm password');
		expect(w.get('#confirm-password').attributes('placeholder')).toBe(
			'Re-enter your new password'
		);
		expect(w.text()).toContain('Reset password');
		expectFullyLocalized(w);
	});

	it('renders the mismatch message rather than a key path', async () => {
		routeQuery = { token: 'reset-token' };
		const w = mountSurface(ResetPasswordPage);
		await w.get('#new-password').setValue('correct-horse-battery');
		await w.get('#confirm-password').setValue('something-else');
		await w.get('form').trigger('submit');

		expect(w.text()).toContain('Passwords do not match');
		expectFullyLocalized(w);
	});
});

describe('welcome', () => {
	it('holds the loading line while the instance mode resolves', () => {
		settingsLoading.value = true;
		const w = mountSurface(WelcomePage);

		expect(w.text()).toContain('Getting things ready…');
		expectFullyLocalized(w);
	});

	it('names the instance and the member in one interpolated heading', () => {
		organization.value = { name: 'Hinterland' };
		user.value = { id: 'user-1', name: 'Marcel Pfeifer' };
		const w = mountSurface(WelcomePage);

		expect(w.text()).toContain('Welcome to Hinterland, Marcel');
		expect(w.text()).toContain("This is your team's home for email.");
		expectFullyLocalized(w);
	});

	it('falls back to the nameless heading when the member has no name', () => {
		organization.value = { name: 'Hinterland' };
		user.value = { id: 'user-1' };
		const w = mountSurface(WelcomePage);

		expect(w.text()).toContain('Welcome to Hinterland');
		expectFullyLocalized(w);
	});

	it('renders both migration choices when the instance is in migration mode', () => {
		workspaceSettings.value = { isMigrationMode: true };
		const w = mountSurface(WelcomePage);

		expect(w.text()).toContain('Bring my email with me');
		expect(w.text()).toContain('Import your existing inbox so nothing is left behind.');
		expect(w.text()).toContain('Start fresh');
		expect(w.text()).toContain("I'll do this later");
		expect(w.find('[data-testid="fresh-start"]').exists()).toBe(false);
		expectFullyLocalized(w);
	});

	it('drops straight into the fresh-start setup otherwise', () => {
		const w = mountSurface(WelcomePage);

		expect(w.find('[data-testid="fresh-start"]').exists()).toBe(true);
		expect(headOptions.title?.()).toBe('Welcome — Owlat');
		expectFullyLocalized(w);
	});
});
