/**
 * The reactive half of the quick-create registry: the verbs a member is offered
 * and what each one actually DOES.
 *
 * `lib/__tests__/quickCreate.test.ts` pins the gates; this pins the wiring, and
 * the wiring is where the old bugs lived — a "create" that navigates to a list
 * instead of creating anything. So every case here asserts the effect: a
 * composer opened, an Add dialog asked for by query, a wizard navigated to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';

let flags: readonly FeatureFlagKey[] | 'all';
let roleRef: ReturnType<typeof ref<string | null>>;
let navigations: unknown[];
let composed: number;
let newContacts: number;

beforeEach(() => {
	flags = 'all';
	roleRef = ref<string | null>('owner');
	navigations = [];
	composed = 0;
	newContacts = 0;

	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('useFeatureFlag', () => ({
		isEnabled: (flag: FeatureFlagKey) => flags === 'all' || flags.includes(flag),
	}));
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(false) }));
	vi.stubGlobal('usePermissions', () => ({ role: roleRef }));
	vi.stubGlobal('useQuickCreate', () => ({
		openCompose: () => {
			composed += 1;
			return Promise.resolve();
		},
		openNewContact: () => {
			newContacts += 1;
			return Promise.resolve();
		},
	}));
	vi.stubGlobal('navigateTo', (to: unknown) => {
		navigations.push(to);
		return Promise.resolve();
	});
});

async function menu() {
	vi.resetModules();
	const { useQuickCreateMenu } = await import('../useQuickCreateMenu');
	return useQuickCreateMenu();
}

describe('useQuickCreateMenu', () => {
	it('offers the gated verbs, translated and runnable', async () => {
		const { actions } = await menu();

		expect(actions.value.map((action) => action.id)).toEqual([
			'compose',
			'campaign',
			'contact',
			'automation',
		]);
		expect(actions.value[0]?.label).toBe('shared.quickCreate.compose');
	});

	it('opens a real composer rather than navigating to the mailbox', async () => {
		const { actions } = await menu();

		actions.value.find((action) => action.id === 'compose')?.run();

		expect(composed).toBe(1);
		expect(navigations).toEqual([]);
	});

	it('opens the Add contact dialog rather than the contacts list', async () => {
		const { actions } = await menu();

		actions.value.find((action) => action.id === 'contact')?.run();

		expect(newContacts).toBe(1);
		expect(navigations).toEqual([]);
	});

	it('navigates for the verbs that are a page', async () => {
		const { actions } = await menu();

		actions.value.find((action) => action.id === 'campaign')?.run();
		actions.value.find((action) => action.id === 'automation')?.run();

		expect(navigations).toEqual(['/dashboard/campaigns/new', '/dashboard/automations/new']);
	});

	it('re-resolves when the role arrives', async () => {
		// The role is null for the first frames after a reload; the menu must not
		// stay frozen on that fail-closed answer once membership resolves.
		roleRef.value = null;
		const { actions } = await menu();
		expect(actions.value.map((action) => action.id)).toEqual(['compose', 'campaign']);

		roleRef.value = 'admin';
		expect(actions.value.map((action) => action.id)).toContain('contact');
	});

	it('has no compose verb — and so no `c` chord — without mail', async () => {
		flags = ['campaigns'];
		const { composeAction, defaultAction } = await menu();

		expect(composeAction.value).toBeNull();
		expect(defaultAction.value?.id).toBe('campaign');
	});

	it('has nothing at all for a member with no create rights', async () => {
		flags = [];
		roleRef.value = 'editor';
		const { actions, defaultAction } = await menu();

		expect(actions.value).toEqual([]);
		expect(defaultAction.value).toBeNull();
	});
});
