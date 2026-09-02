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
import type { VueWrapper } from '@vue/test-utils';
import { auditA11y, installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useSetupWizard } from '~/composables/useSetupWizard';
import { useWizard } from '~/composables/useWizard';
import SetupIndexPage from '../index.vue';
import SetupModePage from '../mode.vue';
import SetupFeaturesPage from '../features.vue';
import SetupAdminPage from '../admin.vue';
import SetupEmailPage from '../email.vue';
import SetupReviewPage from '../review.vue';

beforeEach(() => {
	localStorage.clear();
	installNuxtStubs({
		...i18nStubs,
		useSetupWizard,
		useWizard,
		useRoute: () => ({ path: '/setup', fullPath: '/setup', query: {}, params: {}, meta: {} }),
	});
});

const pages = [
	{ name: 'welcome', component: SetupIndexPage, loaded: 'Welcome to Owlat', indicator: false },
	{ name: 'mode', component: SetupModePage, loaded: 'How will you run Owlat?', indicator: true },
	{
		name: 'features',
		component: SetupFeaturesPage,
		loaded: 'Pick what to enable',
		indicator: true,
	},
	{
		name: 'email delivery',
		component: SetupEmailPage,
		loaded: 'How should Owlat send mail?',
		indicator: true,
	},
	{ name: 'admin account', component: SetupAdminPage, loaded: 'Admin account', indicator: true },
	{ name: 'review', component: SetupReviewPage, loaded: 'Review & launch', indicator: true },
] as const;

// The access-request screen used to be audited here as a "team invites step".
// It is not a step and no longer lives under /setup — it is audited on its own
// route in `app/pages/__tests__/accessRequestA11y.test.ts`.

/** A step label that reached the screen as its message key instead of its word. */
const RAW_STEP_KEY = /shared\.useSetupWizard\./;

/** The `en` catalog's `shared.useSetupWizard.steps.*`, in wizard order. */
const STEP_LABELS = ['Mode', 'Features', 'Email', 'Account', 'Review'];

/**
 * REGRESSION — the step indicator is handed DISPLAY TEXT, never message keys.
 *
 * `SETUP_WIZARD_STEPS` is built at module scope, so its `label`s are
 * `shared.useSetupWizard.steps.*` keys, and each wizard page maps them through
 * its own `t()` before binding them (`UiStepIndicator` is a shared ui-layer
 * component that resolves nothing). A page that forgets paints those key paths
 * across the top of the very first screen an operator ever sees — and, once a
 * step is completed, names its back-link button that too, so the leak is read
 * aloud as well as shown. Checked on the visible labels AND on the accessible
 * names, because the two come from the same string by different routes.
 */
function expectStepIndicatorLocalized(wrapper: VueWrapper): void {
	const nav = wrapper.get('nav');
	for (const label of STEP_LABELS) expect(nav.text()).toContain(label);
	expect(nav.text()).not.toMatch(RAW_STEP_KEY);
	for (const el of nav.element.querySelectorAll('[aria-label]')) {
		expect(el.getAttribute('aria-label') ?? '').not.toMatch(RAW_STEP_KEY);
	}
}

describe.each(pages)(
	'setup wizard: $name step — accessibility',
	({ component, loaded, indicator }) => {
		it('has no axe violations', async () => {
			const violations = await auditA11y(component, {
				global: { plugins: [createTestI18n()] },
				prepare: (wrapper) => {
					expect(wrapper.text()).toContain(loaded);
					if (indicator) expectStepIndicatorLocalized(wrapper);
				},
			});
			expect(violations).toEqual([]);
		});
	}
);
