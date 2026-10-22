/**
 * Recently deleted: one tab per kind the viewer may restore, each listing what
 * was deleted with when it goes for good, and Restore running the kind's own
 * restore once per press. A failed read shows the error, not "Nothing deleted".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { hasPermission, type Permission } from '@owlat/shared/organizationPermissions';
import PageHeader from '@owlat/ui/components/ui/PageHeader.vue';
import SegmentedControl from '@owlat/ui/components/ui/SegmentedControl.vue';

import RecentlyDeleted from '../deleted.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs, paginatedResult } from '~/__tests__/a11y';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 22, 9);

const ROWS: Record<string, Array<Record<string, unknown>>> = {
	'campaigns/deletion:listDeleted': [
		{
			_id: 'c1',
			name: 'Autumn sale',
			status: 'draft',
			deletedAt: NOW - 26 * DAY,
			purgeAt: NOW + 4 * DAY,
		},
	],
	'automations/deletion:listDeleted': [
		{
			_id: 'a1',
			name: 'Trial nurture',
			status: 'paused',
			deletedAt: NOW - DAY,
			purgeAt: NOW + 29 * DAY,
		},
	],
	'emailTemplates/deletion:listDeleted': [],
};

let query: Record<string, string>;
let replace: ReturnType<typeof vi.fn>;
let role: 'owner' | 'editor';
let flags: Record<string, boolean>;
let listError: Error | null;
let subscribed: Array<{ name: string; args: unknown }>;
let runs: Record<string, ReturnType<typeof vi.fn>>;
let showToast: ReturnType<typeof vi.fn>;
let pendingRestore: Promise<{ ok: boolean; result: null }> | null;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	query = {};
	replace = vi.fn();
	role = 'owner';
	flags = { campaigns: true, automations: true };
	listError = null;
	subscribed = [];
	runs = {};
	showToast = vi.fn();
	pendingRestore = null;
});

function render(): VueWrapper {
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => ({ path: '/dashboard/marketing/deleted', query, params: {} }),
		useRouter: () => ({ push: vi.fn(), replace }),
		useFeatureFlag: () => ({
			flags: ref(flags),
			isEnabled: (flag: string) => flags[flag] === true,
			isLoading: ref(false),
			error: ref(null),
		}),
		usePermissions: () => ({
			role: ref(role),
			isAdmin: ref(role === 'owner'),
			isRoleLoading: ref(false),
			can: (permission: Permission) => hasPermission(role, permission),
			showGateFor: () => false,
		}),
		useToast: () => ({ showToast }),
		useBackendOperation: (reference: FunctionReference<'mutation'>) => {
			const name = getFunctionName(reference);
			const run = vi.fn(async () => pendingRestore ?? { ok: true, result: null });
			runs[name] = run;
			return { run, isLoading: ref(false), error: ref(null) };
		},
		useOrganizationPaginatedQuery: (reference: FunctionReference<'query'>, args: () => unknown) => {
			const name = getFunctionName(reference);
			const active = args();
			if (active !== undefined) subscribed.push({ name, args: active });
			const result = paginatedResult(active === undefined ? [] : (ROWS[name] ?? []));
			if (active !== undefined) result.error.value = listError as never;
			return result;
		},
	});
	return mount(RecentlyDeleted, {
		global: {
			plugins: [createTestI18n()],
			components: {
				UiPageHeader: PageHeader,
				UiQueryBoundary: QueryBoundary,
				UiSegmentedControl: SegmentedControl,
			},
			stubs: {
				Icon: true,
				UiIconBox: true,
				UiErrorAlert: { template: '<div data-stub="error"><slot /></div>' },
				UiSpinner: true,
				UiEmptyState: {
					props: ['title'],
					template: '<p data-stub="empty">{{ title }}</p>',
				},
				UiCard: { template: '<div><slot /></div>' },
				UiButton: {
					props: ['disabled', 'loading'],
					emits: ['click'],
					template:
						'<button data-stub="button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	}) as VueWrapper;
}

const tabLabels = (wrapper: VueWrapper) =>
	wrapper.findAll('[role="tab"]').map((tab) => tab.text().trim());

describe('Recently deleted', () => {
	it('opens on campaigns, reads only that tab, and says when each item goes for good', () => {
		const wrapper = render();
		expect(tabLabels(wrapper)).toEqual(['Campaigns', 'Automations', 'Templates']);
		expect(subscribed.map((s) => s.name)).toEqual(['campaigns/deletion:listDeleted']);
		const rows = wrapper.findAll('[data-testid="recently-deleted-row"]');
		expect(rows).toHaveLength(1);
		expect(rows[0]!.text()).toContain('Autumn sale');
		expect(rows[0]!.text()).toContain('Deleted 3 weeks ago');
		expect(rows[0]!.text()).toContain('removed for good in 4 days');
		expect(wrapper.text()).toContain('comes back as a draft');
	});

	it('follows ?type= and switches tabs through the URL', async () => {
		query = { type: 'automations' };
		const wrapper = render();
		expect(subscribed.map((s) => s.name)).toEqual(['automations/deletion:listDeleted']);
		expect(wrapper.text()).toContain('Trial nurture');
		await wrapper.findAll('[role="tab"]')[2]!.trigger('click');
		expect(replace).toHaveBeenCalledWith({ query: { type: 'templates' } });
	});

	it('restores through the kind’s own mutation, and a second press waits for the first', async () => {
		let finish!: (value: { ok: boolean; result: null }) => void;
		pendingRestore = new Promise((resolve) => (finish = resolve));
		const wrapper = render();
		const restore = wrapper.get('[data-testid="recently-deleted-row"] [data-stub="button"]');
		await restore.trigger('click');
		await restore.trigger('click');
		expect(runs['campaigns/campaigns:restore']).toHaveBeenCalledTimes(1);
		expect(runs['campaigns/campaigns:restore']).toHaveBeenCalledWith({ campaignId: 'c1' });

		finish({ ok: true, result: null });
		await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith('Restored Autumn sale'));
	});

	it('shows only the tabs an editor may restore', () => {
		role = 'editor';
		const wrapper = render();
		// An editor manages campaigns, not automations or templates; one tab needs no strip.
		expect(tabLabels(wrapper)).toEqual([]);
		expect(subscribed.map((s) => s.name)).toEqual(['campaigns/deletion:listDeleted']);
	});

	it('keeps templates when the campaigns feature is off', () => {
		flags = {};
		const wrapper = render();
		expect(subscribed.map((s) => s.name)).toEqual(['emailTemplates/deletion:listDeleted']);
		expect(wrapper.text()).toContain('Nothing deleted');
	});

	it('shows the read error, not the empty state', () => {
		listError = new Error('[CONVEX Q(x:y)] Server Error');
		const wrapper = render();
		expect(wrapper.text()).not.toContain('Nothing deleted');
		expect(wrapper.find('[data-testid="recently-deleted-row"]').exists()).toBe(false);
	});
});
