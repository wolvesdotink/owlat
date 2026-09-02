// @vitest-environment happy-dom
/**
 * ACCESSIBILITY PASS ON THE ACCESS-REQUEST SCREEN.
 *
 * The screen a signed-in member lands on when they belong to no organization —
 * a dead end until they ask for access, so its one form has to be operable.
 *
 * It used to be `/setup/team` and was audited as a step of the first-run wizard
 * (`app/pages/setup/__tests__/setupWizardA11y.test.ts`). It is not a setup step
 * and it no longer lives there, so its audit moved with it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { auditA11y, installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import AccessRequestPage from '../access-request.vue';

beforeEach(() => {
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => ({
			path: '/access-request',
			fullPath: '/access-request',
			query: {},
			params: {},
			meta: {},
		}),
		// The page only renders its form for a signed-in user with NO organization;
		// with one, it pushes to the dashboard and renders nothing at all.
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

describe('access-request page — accessibility', () => {
	it('has no axe violations on the request form', async () => {
		const violations = await auditA11y(AccessRequestPage, {
			global: { plugins: [createTestI18n()] },
			prepare: (wrapper) => expect(wrapper.text()).toContain('Invitation required'),
		});
		expect(violations).toEqual([]);
	});
});
