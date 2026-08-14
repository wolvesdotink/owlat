// @vitest-environment happy-dom
/**
 * ACCESSIBILITY PASS ON THE FIRST-RUN SETUP WIZARD.
 *
 * This is the very first screen an operator sees, before any account exists, and
 * it is a chain of forms and radio-style choice cards — the shape most prone to
 * clickable `<div>`s with no role, choice groups with no fieldset/legend, and a
 * step indicator that conveys progress only by colour.
 *
 * THE WIZARD COMPOSABLES ARE THE REAL ONES. `useSetupWizard`/`useWizard` are
 * pure state over `useState` and localStorage, and the step markup branches on
 * them (which cards render, which "next" is enabled); stubbing them would audit
 * a page that never occurs.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { auditA11y, installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useSetupWizard } from '~/composables/useSetupWizard';
import { useWizard } from '~/composables/useWizard';
import SetupIndexPage from '../index.vue';
import SetupModePage from '../mode.vue';
import SetupFeaturesPage from '../features.vue';
import SetupAdminPage from '../admin.vue';
import SetupEmailPage from '../email.vue';
import SetupTeamPage from '../team.vue';
import SetupReviewPage from '../review.vue';

beforeEach(() => {
	localStorage.clear();
	installNuxtStubs({
		...i18nStubs,
		useSetupWizard,
		useWizard,
		useRoute: () => ({ path: '/setup', fullPath: '/setup', query: {}, params: {}, meta: {} }),
		// The team step only renders for a signed-in user who has no organization
		// yet; with one, it redirects to the dashboard and renders nothing.
		useOrganizationContext: () => ({
			organization: ref(null),
			organizationId: ref(null),
			organizations: ref([]),
			settings: ref(null),
			role: ref(null),
			user: ref({ id: 'user1', name: 'Ada Lovelace', email: 'ada@example.com' }),
			isLoading: ref(false),
			isSettingsLoading: ref(false),
			error: ref(null),
			setActive: () => {},
			hasActiveOrganization: ref(false),
		}),
	});
});

const pages = [
	{ name: 'welcome', component: SetupIndexPage, loaded: 'Welcome to Owlat' },
	{ name: 'mode', component: SetupModePage, loaded: 'How will you run Owlat?' },
	{ name: 'features', component: SetupFeaturesPage, loaded: 'Pick what to enable' },
	{ name: 'email delivery', component: SetupEmailPage, loaded: 'How should Owlat send mail?' },
	{ name: 'admin account', component: SetupAdminPage, loaded: 'Admin account' },
	{ name: 'team invites', component: SetupTeamPage, loaded: 'Invitation required' },
	{ name: 'review', component: SetupReviewPage, loaded: 'Review & launch' },
] as const;

describe.each(pages)('setup wizard: $name step — accessibility', ({ component, loaded }) => {
	it('has no axe violations', async () => {
		const violations = await auditA11y(component, {
			global: { plugins: [createTestI18n()] },
			prepare: (wrapper) => expect(wrapper.text()).toContain(loaded),
		});
		expect(violations).toEqual([]);
	});
});
