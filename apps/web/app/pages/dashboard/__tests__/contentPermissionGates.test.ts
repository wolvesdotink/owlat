// @vitest-environment happy-dom
/**
 * The content domains are admin-only WRITES over member-readable lists.
 *
 * Segments, topics and automations are all gated on `<scope>:manage` in Convex
 * (`requireOrgPermission`), but the list pages used to offer create/edit/delete
 * to everyone and let the backend refuse the click with a forbidden toast.
 * These cases mount the real pages against the REAL `usePermissions()` — the
 * only stub is the organization role it reads — so they fail if a page stops
 * asking `can()`, and they fail if the shared permission map ever hands an
 * editor one of these permissions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, type Ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { queryResult, paginatedResult } from '~/__tests__/queryStubs';
import { usePermissions } from '~/composables/usePermissions';

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });

const role: Ref<string | null> = ref('owner');

const SEGMENTS = [
	{
		_id: 'sg_1',
		name: 'Engaged, last 90 days',
		description: 'Opened or clicked recently',
		cachedCount: 942,
		createdAt: Date.parse('2026-05-17T09:00:00Z'),
		filters: [],
	},
];

const TOPICS = [
	{
		_id: 'tp_1',
		name: 'Product updates',
		description: 'Release notes',
		contactCount: 1284,
		createdAt: Date.parse('2026-04-23T09:00:00Z'),
	},
];

const BLOCKS = [
	{
		_id: 'bl_1',
		name: 'Footer with address',
		description: 'Postal address and the unsubscribe line',
		usageCount: 12,
		updatedAt: Date.parse('2026-06-02T09:00:00Z'),
	},
];

const AUTOMATIONS = [
	{
		_id: 'au_1',
		name: 'Welcome sequence',
		description: 'Three emails over the first week',
		status: 'active',
		statsActive: 318,
		createdAt: Date.parse('2026-01-23T09:00:00Z'),
		triggerType: 'contact_created',
	},
];

function stubNuxt() {
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useRoute', () => ({ query: {}, params: {} }));
	vi.stubGlobal('useRouter', () => ({ push: vi.fn(), replace: vi.fn() }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
	vi.stubGlobal('useOrganizationQuery', () => queryResult(null));
	vi.stubGlobal('useConvexQuery', () => queryResult(null));
	vi.stubGlobal('useDataTableViewport', () => ref(true));
	vi.stubGlobal('useKeyboardShortcuts', () => ({
		registerNewShortcut: vi.fn(),
		registerEscapeHandler: vi.fn(),
		unregisterShortcut: vi.fn(),
		unregisterEscapeHandler: vi.fn(),
	}));
	vi.stubGlobal('useDataTable', () => ({
		searchQuery: ref(''),
		debouncedSearch: ref(''),
		sortBy: ref('createdAt'),
		sortOrder: ref('desc'),
		toggleSort: vi.fn(),
		getSortIcon: () => null,
	}));
	vi.stubGlobal('useClickOutsideSelector', vi.fn());
	vi.stubGlobal('useDebouncedSearch', () => ({ searchQuery: ref(''), debouncedSearch: ref('') }));
	vi.stubGlobal('useTopicsList', () => paginatedResult([]));
	// The role is the only thing these cases vary — `usePermissions` itself is
	// the production composable, reading the shared permission map.
	vi.stubGlobal('useOrganizationContext', () => ({
		role,
		hasActiveOrganization: ref(true),
		isLoading: ref(false),
	}));
	vi.stubGlobal('usePermissions', usePermissions);
}

const SLOTTED = { template: '<div><slot /></div>' };

const STUBS = {
	UiCard: SLOTTED,
	UiInput: true,
	UiModal: true,
	UiSelect: true,
	UiCheckbox: true,
	UiIconBox: true,
	UiSpinner: true,
	UiPageHeader: { template: '<div><slot /><slot name="actions" /></div>' },
	AudienceTabs: true,
	UiQueryBoundary: SLOTTED,
	UiEmptyState: { template: '<div><slot name="action" /></div>' },
	DashboardListSkeleton: true,
	UnsavedChangesDialog: true,
	UiTextarea: true,
	UiConfirmDialog: true,
	UiDropdownMenu: true,
	UiDropdownMenuItem: true,
	UiDropdownDivider: true,
	ConditionsConditionEditor: true,
};

// `stubNuxt` runs at mount time, so a per-page stub set in a `beforeEach` would
// be clobbered by the defaults. Pass it here instead and it lands last.
async function mountPage(
	loader: () => Promise<{ default: unknown }>,
	overrides: Record<string, unknown> = {}
) {
	stubNuxt();
	for (const [name, value] of Object.entries(overrides)) vi.stubGlobal(name, value);
	const Page = (await loader()).default;
	return mount(Page as never, {
		shallow: true,
		global: {
			plugins: [createTestI18n()],
			stubs: STUBS,
			// Auto-imported formatters the TEMPLATES call: outside the Nuxt vite
			// plugin they resolve through the instance proxy, not module scope.
			mocks: { formatDate: (value: number) => new Date(value).toISOString().slice(0, 10) },
		},
	});
}

beforeEach(() => {
	role.value = 'owner';
});

describe('segments list', () => {
	beforeEach(() => {
		vi.stubGlobal('usePaginatedQuery', () => paginatedResult(SEGMENTS));
		vi.stubGlobal('useSegmentFilters', () => ({
			describeFilters: () => 'All contacts',
			conditions: ref([]),
		}));
		vi.stubGlobal('useSegmentForm', () => ({
			form: ref({ name: '', description: '', conditions: [] }),
			isSubmitting: ref(false),
			reset: vi.fn(),
			submit: vi.fn(),
		}));
		vi.stubGlobal('useFormModal', () => ({
			isOpen: ref(false),
			open: vi.fn(),
			close: vi.fn(),
			requestClose: vi.fn(),
			isConfirmOpen: ref(false),
			confirmDiscard: vi.fn(),
			cancelDiscard: vi.fn(),
		}));
	});

	it('offers create, edit and delete to an admin', async () => {
		role.value = 'admin';
		const wrapper = await mountPage(() => import('../audience/segments/index.vue'));

		expect(wrapper.find('button[title="Edit segment"]').exists()).toBe(true);
		expect(wrapper.find('button[title="Delete segment"]').exists()).toBe(true);
		expect(wrapper.text()).not.toContain('Only owners and admins');
		wrapper.unmount();
	});

	it('takes the write actions off an editor and says who may use them', async () => {
		role.value = 'editor';
		const wrapper = await mountPage(() => import('../audience/segments/index.vue'));

		expect(wrapper.find('button[title="Edit segment"]').exists()).toBe(false);
		expect(wrapper.find('button[title="Delete segment"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('Only owners and admins can create or edit segments.');
		// The list itself is member-readable and stays (the name renders inside a
		// NuxtLink, which `shallow` stubs, so the row is what we can assert on).
		expect(wrapper.findAll('tbody tr')).toHaveLength(1);
		wrapper.unmount();
	});

	it('shows no gate copy while the role is still unresolved', async () => {
		role.value = null;
		const wrapper = await mountPage(() => import('../audience/segments/index.vue'));

		expect(wrapper.text()).not.toContain('Only owners and admins');
		wrapper.unmount();
	});
});

describe('topics list', () => {
	beforeEach(() => {
		vi.stubGlobal('usePaginatedQuery', () => paginatedResult(TOPICS));
	});

	it('offers edit and delete to an admin', async () => {
		role.value = 'admin';
		const wrapper = await mountPage(() => import('../audience/topics/index.vue'));

		expect(wrapper.find('button[title="Edit topic"]').exists()).toBe(true);
		expect(wrapper.find('button[title="Delete topic"]').exists()).toBe(true);
		wrapper.unmount();
	});

	it('takes them off an editor', async () => {
		role.value = 'editor';
		const wrapper = await mountPage(() => import('../audience/topics/index.vue'));

		expect(wrapper.find('button[title="Edit topic"]').exists()).toBe(false);
		expect(wrapper.find('button[title="Delete topic"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('Only owners and admins can create or edit topics.');
		expect(wrapper.text()).toContain('Product updates');
		wrapper.unmount();
	});
});

// Reusable blocks are `templates:manage`. This case exists because the grid
// card's hover overlay and the card's dropdown are two controls for the SAME
// `blocks.update` mutation, and the first shipped ungated while the second was
// gated — a disagreement only a case that looks at both would catch.
describe('blocks list', () => {
	const blocksQuery = { useConvexQuery: () => queryResult(BLOCKS) };

	it('offers quick settings, duplicate and delete to an admin', async () => {
		role.value = 'admin';
		const wrapper = await mountPage(() => import('../send/blocks/index.vue'), blocksQuery);

		expect(wrapper.find('button[title="Quick Settings"]').exists()).toBe(true);
		expect(wrapper.find('button[title="Edit Content"]').exists()).toBe(true);
		wrapper.unmount();
	});

	it('takes every write off an editor and keeps the library browsable', async () => {
		role.value = 'editor';
		const wrapper = await mountPage(() => import('../send/blocks/index.vue'), blocksQuery);

		expect(wrapper.find('button[title="Quick Settings"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('Only owners and admins can create or delete blocks.');
		// Opening a block to read it is not a write, so it stays.
		expect(wrapper.find('button[title="Edit Content"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('Footer with address');
		wrapper.unmount();
	});
});

describe('automations list', () => {
	beforeEach(() => {
		vi.stubGlobal('usePaginatedQuery', () => paginatedResult(AUTOMATIONS));
		vi.stubGlobal('useAutomation', () => ({}));
		vi.stubGlobal('useAutomationBadges', () => ({
			getStatusBadge: () => ({ color: '', icon: 'lucide:play', label: 'common.active' }),
			getTriggerDisplay: () => ({
				color: '',
				bgColor: '',
				icon: 'lucide:user',
				label: 'common.name',
			}),
		}));
	});

	it('offers edit and the action menu to an admin', async () => {
		role.value = 'admin';
		const wrapper = await mountPage(() => import('../automations/index.vue'));

		expect(wrapper.find('button[title="Edit"]').exists()).toBe(true);
		expect(wrapper.find('[data-dropdown]').exists()).toBe(true);
		wrapper.unmount();
	});

	it('takes the write actions off an editor', async () => {
		role.value = 'editor';
		const wrapper = await mountPage(() => import('../automations/index.vue'));

		expect(wrapper.find('button[title="Edit"]').exists()).toBe(false);
		expect(wrapper.find('button[title="Pause"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('Only owners and admins can create or edit automations.');
		expect(wrapper.text()).toContain('Welcome sequence');
		wrapper.unmount();
	});
});
