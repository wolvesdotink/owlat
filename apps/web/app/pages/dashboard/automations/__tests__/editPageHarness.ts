/**
 * Mounts the automation builder page with its data and the steps composable
 * stubbed, so a suite drives the page's own wiring: which flow waits for the
 * open step's save, what it does when that save fails, and what it renders.
 */
import { vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { queryResult, paginatedResult } from '~/__tests__/queryStubs';

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });

export type HarnessStep = { _id: string; stepType: string; config: string };

export const AUTOMATION = {
	_id: 'au_1',
	name: 'Welcome sequence',
	description: '',
	status: 'draft',
	triggerType: 'contact_created',
	triggerConfig: null,
	steps: [
		{ _id: 'st_1', stepType: 'email', config: '{}' },
		{ _id: 'st_2', stepType: 'delay', config: '{}' },
		{ _id: 'st_3', stepType: 'delay', config: '{}' },
	] as HarnessStep[],
};

// The page creates its operations in this order.
const OPERATIONS = ['activate', 'pause', 'resume', 'update'] as const;
type Operation = (typeof OPERATIONS)[number];

const okRun = () => vi.fn((_args?: unknown) => Promise.resolve({ ok: true, result: null }));

export function stubEditPage(overrides: Partial<typeof AUTOMATION> = {}) {
	const data = ref({ ...AUTOMATION, ...overrides });
	let created = 0;
	const runs: Record<Operation, ReturnType<typeof okRun>> = {
		activate: okRun(),
		pause: okRun(),
		resume: okRun(),
		update: okRun(),
	};
	const showToast = vi.fn();
	const announce = vi.fn();
	const push = vi.fn();
	const canActivate = ref<{ valid: boolean; reasons: string[] }>({ valid: true, reasons: [] });
	const selectedStepId = ref<string | null>(null);
	const steps = {
		stepSaveStatus: ref('saved'),
		isAddStepDropdownOpen: ref(false),
		addStepDropdownIndex: ref<number | null>(null),
		selectedStepId,
		selectedStep: computed(
			() => data.value.steps.find((step) => step._id === selectedStepId.value) ?? null
		),
		mutableSteps: computed(() => [...data.value.steps]),
		stepTypes: computed(() => [
			{ id: 'email', label: 'Send email', description: '', color: 'lime', icon: '' },
		]),
		canActivate: computed(() => canActivate.value),
		currentConfig: ref(null),
		isCurrentConfigDirty: ref(false),
		hasRemoteStepChange: ref(false),
		handleAddStep: vi.fn(),
		handleDeleteStep: vi.fn(),
		handleDragEnd: vi.fn((_event?: unknown) => Promise.resolve(true)),
		requestStepSave: vi.fn(),
		flushStepSave: vi.fn(() => Promise.resolve(true)),
		discardStepChanges: vi.fn(),
		takeRemoteStepConfig: vi.fn(),
		keepLocalStepConfig: vi.fn(() => Promise.resolve(true)),
		closeDropdowns: vi.fn(),
		getStepDescription: (step: HarnessStep) => `About ${step._id}`,
	};
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useRouter', () => ({ push, replace: vi.fn() }));
	vi.stubGlobal('useRouteId', () => ref('au_1'));
	vi.stubGlobal('useConvexQuery', () => ({ ...queryResult(null), data }));
	vi.stubGlobal('usePaginatedQuery', () => paginatedResult([]));
	vi.stubGlobal('useOrganizationQuery', () => queryResult([]));
	vi.stubGlobal('useTopicsList', () => paginatedResult([]));
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useAnnounce', () => ({ announce }));
	vi.stubGlobal('useBackendOperation', () => ({
		run: runs[OPERATIONS[created++ % OPERATIONS.length]!],
		isLoading: ref(false),
	}));
	vi.stubGlobal('useUnsavedChanges', () => ({
		showDialog: ref(false),
		confirmDiscard: vi.fn(),
		confirmSave: vi.fn(),
		cancelNavigation: vi.fn(),
		setHasChanges: vi.fn(),
	}));
	vi.stubGlobal('useAutomationSteps', () => steps);
	return { data, runs, showToast, announce, push, canActivate, steps };
}

/** The step actions menu, always rendered open so its items can be clicked. */
export const dropdownStubs = {
	UiDropdownMenu: { template: '<div><slot name="trigger" /><slot /></div>' },
	UiDropdownMenuItem: {
		props: ['disabled', 'icon', 'danger'],
		emits: ['click'],
		template:
			'<button role="menuitem" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
	},
	UiDropdownDivider: true,
};

export async function mountEditPage(stubs: Record<string, unknown> = {}) {
	const Page = (await import('../[id]/edit.vue')).default;
	return mount(Page as never, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				UiSpinner: true,
				NuxtLink: { template: '<a><slot /></a>' },
				UiButton: {
					props: ['disabled'],
					template: '<button :disabled="disabled"><slot /></button>',
				},
				UnsavedChangesDialog: true,
				AutomationsStepEditorPanel: true,
				AutomationsStepSaveStatus: true,
				AutomationsStepSaveFailedDialog: {
					name: 'AutomationsStepSaveFailedDialog',
					props: ['open', 'conflict', 'retrying'],
					emits: ['retry', 'discard', 'stay'],
					template: '<div v-if="open" data-testid="step-save-failed" />',
				},
				...dropdownStubs,
				Teleport: true,
				...stubs,
			},
		},
	});
}

export type EditPageWrapper = Awaited<ReturnType<typeof mountEditPage>>;

export const buttonByText = (wrapper: EditPageWrapper, label: string) => {
	const found = wrapper.findAll('button').filter((b) => b.text().trim() === label);
	if (!found.length) throw new Error(`no "${label}" button`);
	return found[found.length - 1]!;
};
