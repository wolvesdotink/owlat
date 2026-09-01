// @vitest-environment happy-dom
/**
 * THE END OF THE FIRST-RUN WIZARD.
 *
 * Launching used to end in `window.location.href = '/auth/login?postSetup=1'`,
 * fired by the poller the moment the restarted container answered. The operator
 * had just configured and booted an instance and the acknowledgement was a page
 * reload into a bare sign-in form.
 *
 * The reload itself is NOT the defect and is not removed here — apply rewrites
 * `.env`, restarts the web container and seeds the admin server-side without
 * ever issuing this browser a session, so the operator has to sign in once,
 * against the restarted process (see `setupSignInHref`). What changed is that
 * the wizard now ENDS on a finale — "Setup complete", one title, three real next
 * steps — and the load happens when the operator clicks out of it. So the two
 * properties worth pinning are: nothing navigates on its own, and every exit is
 * a real link to the login target the SERVER chose, carrying the destination the
 * operator picked.
 *
 * Driven through the real page and the real wizard composable, because the
 * finale only exists after a successful apply followed by a cleared restart
 * probe — the state a stub would have to assert into existence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VueWrapper } from '@vue/test-utils';
import { nextTick, type Ref } from 'vue';
import { auditA11y, installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useSetupWizard } from '~/composables/useSetupWizard';
import { useWizard } from '~/composables/useWizard';
import SetupReviewPage from '../review.vue';

/** What `/api/setup/apply` answers with once the admin has been seeded. */
const REDIRECT_TO = '/auth/login?postSetup=1&email=admin%40acme.test';

/** `useState` keyed to ONE store, so the test and the page share the draft. */
let states: Map<string, Ref<unknown>>;
let applyCalls: number;
/** HTTP status the restart probe answers with; 403 means "setup mode is gone". */
let probeStatus: number;

beforeEach(() => {
	states = new Map();
	applyCalls = 0;
	probeStatus = 403;
	installNuxtStubs({
		...i18nStubs,
		useSetupWizard,
		useWizard,
		useRoute: () => ({
			path: '/setup/review',
			fullPath: '/setup/review',
			query: {},
			params: {},
			meta: {},
		}),
		useState: <T>(key: string, init?: () => T) => {
			const existing = states.get(key);
			if (existing) return existing as Ref<T>;
			const created = ref(init?.()) as Ref<T>;
			states.set(key, created);
			return created;
		},
		// The real clamp's contract: same-origin paths through, anything else falls
		// back. The page must not be able to be steered off-site by the response.
		safeRedirect: (value: unknown, fallback: string) =>
			typeof value === 'string' && value.startsWith('/') ? value : fallback,
		$fetch: vi.fn(async () => {
			applyCalls += 1;
			return { ok: true, message: 'Setup applied.', redirectTo: REDIRECT_TO };
		}),
		fetch: vi.fn(async () => ({ status: probeStatus })),
	});
});

/** Let the apply → probe → finale chain (several awaited hops) settle. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 12; turn += 1) {
		await Promise.resolve();
		await nextTick();
	}
}

/** Drive the review step from "filled in" to "launched and restarted". */
async function launch(wrapper: VueWrapper): Promise<void> {
	// A provider is what opens the launch gate; the admin is what apply seeds.
	states.get('setupEnv')!.value = { EMAIL_PROVIDER: 'resend' };
	states.get('setupAdmin')!.value = {
		email: 'admin@acme.test',
		name: 'Ada Lovelace',
		password: 'correct-horse-battery',
	};
	await nextTick();

	// The setup token is the only password field on the step.
	await wrapper.find('input[type="password"]').setValue('stk_token');

	const launchButton = wrapper.findAll('button').find((b) => b.text().includes('Launch'));
	expect(launchButton, 'the launch button should be on the review step').toBeDefined();
	await launchButton!.trigger('click');
	await settle();
}

describe('the first-run finale', () => {
	it('ends on an acknowledgement and navigates nowhere by itself', async () => {
		const before = window.location.href;
		const violations = await auditA11y(SetupReviewPage, {
			global: { plugins: [createTestI18n()] },
			prepare: async (wrapper) => {
				await launch(wrapper);

				expect(applyCalls).toBe(1);
				// The wizard's own last screen, not the login form.
				expect(wrapper.text()).toContain('Setup complete');
				expect(wrapper.text()).toContain('Your instance is');
				// The three next steps the operator can pick from.
				expect(wrapper.text()).toContain('Add a sending domain');
				expect(wrapper.text()).toContain('Invite your team');
				expect(wrapper.text()).toContain('Open your postbox');
				// Nothing left of the review form to be confused by.
				expect(wrapper.text()).not.toContain('Setup token');
				// THE REGRESSION: the poller no longer walks the operator out of the
				// app on its own.
				expect(window.location.href).toBe(before);
			},
		});
		// The finale is markup nobody had audited before — it only exists after a
		// successful launch, which is why the audit is driven rather than static.
		expect(violations).toEqual([]);
	});

	it('exits only through real links to the login target the server chose', async () => {
		await auditA11y(SetupReviewPage, {
			global: { plugins: [createTestI18n()] },
			prepare: async (wrapper) => {
				await launch(wrapper);

				const hrefs = wrapper.findAll('a').map((a) => a.attributes('href'));
				// The plain handoff: exactly what apply answered with, clamped.
				expect(hrefs).toContain(REDIRECT_TO);
				// And one per next step, each carrying its destination through the
				// login form's `redirect` so signing in lands there.
				expect(hrefs).toContain(
					`${REDIRECT_TO}&redirect=%2Fdashboard%2Fadmin%2Fdelivery%2Fdomains`
				);
				expect(hrefs).toContain(`${REDIRECT_TO}&redirect=%2Fdashboard%2Fadmin%2Fteam`);
				expect(hrefs).toContain(`${REDIRECT_TO}&redirect=%2Fdashboard%2Fpostbox`);
				// Every exit is an anchor — no button quietly assigning location.
				expect(hrefs.every((href) => href?.startsWith('/auth/login'))).toBe(true);
			},
		});
	});

	it('waits on the restart rather than declaring an instance live early', async () => {
		probeStatus = 400; // setup mode still live: the container has not come back
		await auditA11y(SetupReviewPage, {
			global: { plugins: [createTestI18n()] },
			prepare: async (wrapper) => {
				await launch(wrapper);
				expect(wrapper.text()).not.toContain('Setup complete');
				// The honest in-between state the restart poller already showed.
				expect(wrapper.text()).toContain('Setup applied');
			},
		});
	});
});
