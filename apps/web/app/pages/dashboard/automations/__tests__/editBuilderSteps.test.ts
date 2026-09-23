// @vitest-environment happy-dom
/**
 * The automation builder has to show the steps it is building.
 *
 * `vue-draggable-plus` renders only its default slot. The builder used the old
 * `vuedraggable` `#item` slot, which the component silently ignores, so an
 * automation with eight steps opened as trigger, then "End of automation", and
 * nothing in between (#802). These cases mount the real page with the real
 * `VueDraggable` so a slot mismatch shows up as missing cards.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { queryResult, paginatedResult } from '~/__tests__/queryStubs';

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });

type Step = { _id: string; stepType: string; config: string };

const AUTOMATION = {
	_id: 'au_1',
	name: 'Welcome sequence',
	description: '',
	status: 'draft',
	triggerType: 'contact_created',
	triggerConfig: null,
	steps: [
		{ _id: 'st_1', stepType: 'email', config: '{}' },
		{ _id: 'st_2', stepType: 'delay', config: '{}' },
	] as Step[],
};

const DESCRIPTIONS: Record<string, string> = {
	st_1: 'Send the welcome email',
	st_2: 'Wait 2 days',
};

function stubPage(automation: typeof AUTOMATION) {
	const data = ref(automation);
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useRouter', () => ({ push: vi.fn(), replace: vi.fn() }));
	vi.stubGlobal('useRouteId', () => ref('au_1'));
	vi.stubGlobal('useConvexQuery', () => ({ ...queryResult(null), data }));
	vi.stubGlobal('usePaginatedQuery', () => paginatedResult([]));
	vi.stubGlobal('useOrganizationQuery', () => queryResult([]));
	vi.stubGlobal('useTopicsList', () => paginatedResult([]));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
	vi.stubGlobal('useUnsavedChanges', () => ({
		showDialog: ref(false),
		confirmDiscard: vi.fn(),
		confirmSave: vi.fn(),
		cancelNavigation: vi.fn(),
		setHasChanges: vi.fn(),
	}));
	vi.stubGlobal('useAutomationSteps', () => ({
		isSaving: ref(false),
		isAddStepDropdownOpen: ref(false),
		addStepDropdownIndex: ref<number | null>(null),
		selectedStepId: ref(null),
		selectedStep: ref(null),
		mutableSteps: computed(() => [...(data.value?.steps ?? [])]),
		stepTypes: computed(() => []),
		canActivate: computed(() => ({ valid: true, reasons: [] })),
		currentConfig: ref(null),
		isCurrentConfigDirty: ref(false),
		handleAddStep: vi.fn(),
		handleDeleteStep: vi.fn(),
		handleDragEnd: vi.fn(),
		handleUpdateStepConfig: vi.fn(),
		closeDropdowns: vi.fn(),
		getStepDescription: (step: Step) => DESCRIPTIONS[step._id] ?? '',
	}));
	return data;
}

async function mountBuilder() {
	const Page = (await import('../[id]/edit.vue')).default;
	return mount(Page as never, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				NuxtLink: { template: '<a><slot /></a>' },
				UiButton: { template: '<button><slot /></button>' },
				UnsavedChangesDialog: true,
				AutomationsStepEditorPanel: true,
				Teleport: true,
			},
		},
	});
}

describe('automation builder', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('renders a card for every step between the trigger and the end', async () => {
		stubPage(AUTOMATION);
		const wrapper = await mountBuilder();

		const cards = wrapper.findAll('[data-testid="automation-step"]');
		expect(cards).toHaveLength(2);
		expect(cards[0]!.text()).toContain('Send the welcome email');
		expect(cards[1]!.text()).toContain('Wait 2 days');
		wrapper.unmount();
	});

	it('follows the server when a step is added', async () => {
		const data = stubPage(AUTOMATION);
		const wrapper = await mountBuilder();

		data.value = {
			...AUTOMATION,
			steps: [...AUTOMATION.steps, { _id: 'st_3', stepType: 'email', config: '{}' }],
		};
		await wrapper.vm.$nextTick();

		expect(wrapper.findAll('[data-testid="automation-step"]')).toHaveLength(3);
		wrapper.unmount();
	});
});

describe('step settings panel with nothing selected', () => {
	it('explains what to do in words, not translation keys', async () => {
		const Panel = (await import('~/components/automations/StepEditorPanel.vue')).default;
		const wrapper = mount(Panel as never, {
			props: {
				selectedStep: null,
				isSaving: false,
				emailTemplates: [],
				currentConfig: null,
				mutableSteps: [],
			},
			global: { plugins: [createTestI18n()], stubs: { Icon: true, UiButton: true } },
		});

		expect(wrapper.text()).toContain('No step selected');
		expect(wrapper.text()).not.toContain('stepEditorPanel');
		wrapper.unmount();
	});
});
