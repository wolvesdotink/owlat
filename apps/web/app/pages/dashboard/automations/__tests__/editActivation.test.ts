// @vitest-environment happy-dom
/**
 * Activation, Resume and Save draft act on what the inspector shows (#1043).
 *
 * Step edits save themselves, so each of these first waits for the open
 * step's save (`flushStepSave`). When that fails, nothing is activated or
 * resumed and Save draft does not claim the draft was saved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { queryResult, paginatedResult } from '~/__tests__/queryStubs';

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });

const AUTOMATION = {
	_id: 'au_1',
	name: 'Welcome sequence',
	description: '',
	status: 'draft',
	triggerType: 'contact_created',
	triggerConfig: null,
	steps: [{ _id: 'st_1', stepType: 'delay', config: '{}' }],
};

// The page creates its operations in this order.
const OPERATIONS = ['activate', 'pause', 'resume', 'update'] as const;

let runs: Record<(typeof OPERATIONS)[number], ReturnType<typeof vi.fn>>;
let flushStepSave: ReturnType<typeof vi.fn>;
let showToast: ReturnType<typeof vi.fn>;
const canActivate = ref<{ valid: boolean; reasons: string[] }>({ valid: true, reasons: [] });

function stubPage(status = 'draft') {
	const data = ref({ ...AUTOMATION, status });
	let created = 0;
	runs = {
		activate: vi.fn(() => Promise.resolve({ ok: true, result: null })),
		pause: vi.fn(() => Promise.resolve({ ok: true, result: null })),
		resume: vi.fn(() => Promise.resolve({ ok: true, result: null })),
		update: vi.fn(() => Promise.resolve({ ok: true, result: null })),
	};
	flushStepSave = vi.fn(() => Promise.resolve(true));
	showToast = vi.fn();
	canActivate.value = { valid: true, reasons: [] };
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useRouter', () => ({ push: vi.fn(), replace: vi.fn() }));
	vi.stubGlobal('useRouteId', () => ref('au_1'));
	vi.stubGlobal('useConvexQuery', () => ({ ...queryResult(null), data }));
	vi.stubGlobal('usePaginatedQuery', () => paginatedResult([]));
	vi.stubGlobal('useOrganizationQuery', () => queryResult([]));
	vi.stubGlobal('useTopicsList', () => paginatedResult([]));
	vi.stubGlobal('useToast', () => ({ showToast }));
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
	vi.stubGlobal('useAutomationSteps', () => ({
		stepSaveStatus: ref('saved'),
		isAddStepDropdownOpen: ref(false),
		addStepDropdownIndex: ref<number | null>(null),
		selectedStepId: ref(null),
		selectedStep: ref(null),
		mutableSteps: computed(() => [...data.value.steps]),
		stepTypes: computed(() => []),
		canActivate: computed(() => canActivate.value),
		currentConfig: ref(null),
		isCurrentConfigDirty: ref(false),
		handleAddStep: vi.fn(),
		handleDeleteStep: vi.fn(),
		handleDragEnd: vi.fn(),
		requestStepSave: vi.fn(),
		flushStepSave: (...args: unknown[]) => flushStepSave(...args),
		discardStepChanges: vi.fn(),
		closeDropdowns: vi.fn(),
		getStepDescription: () => '',
	}));
}

async function mountBuilder() {
	const Page = (await import('../[id]/edit.vue')).default;
	return mount(Page as never, {
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
				Teleport: true,
			},
		},
	});
}

const button = (wrapper: Awaited<ReturnType<typeof mountBuilder>>, label: string) => {
	const found = wrapper.findAll('button').filter((b) => b.text().trim() === label);
	if (!found.length) throw new Error(`no "${label}" button`);
	return found[found.length - 1]!;
};

describe('activation waits for the open step to be saved', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('activates after the save lands', async () => {
		stubPage();
		const wrapper = await mountBuilder();
		await button(wrapper, 'Activate').trigger('click');
		await flushPromises();
		expect(flushStepSave).toHaveBeenCalledTimes(1);

		await button(wrapper, 'Activate').trigger('click');
		await flushPromises();
		expect(flushStepSave).toHaveBeenCalledTimes(2);
		expect(runs.activate).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});

	it('shows the save error in the modal and does not activate', async () => {
		stubPage();
		const wrapper = await mountBuilder();
		flushStepSave.mockResolvedValue(false);
		await button(wrapper, 'Activate').trigger('click');
		await flushPromises();

		expect(wrapper.get('[role="alert"]').text()).toContain("couldn't be saved");
		await button(wrapper, 'Activate').trigger('click');
		await flushPromises();
		expect(runs.activate).not.toHaveBeenCalled();
		expect(wrapper.find('[role="alert"]').exists()).toBe(true);
		wrapper.unmount();
	});

	it('checks readiness against the saved steps after the save', async () => {
		stubPage();
		const wrapper = await mountBuilder();
		// The save that just landed is what made the step invalid.
		flushStepSave.mockImplementation(() => {
			canActivate.value = { valid: false, reasons: ['Step 1: choose an email'] };
			return Promise.resolve(true);
		});
		await button(wrapper, 'Activate').trigger('click');
		await flushPromises();

		expect(showToast).toHaveBeenCalledWith('Step 1: choose an email', 'error');
		expect(runs.activate).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	it('does not resume when the save fails', async () => {
		stubPage('paused');
		const wrapper = await mountBuilder();
		flushStepSave.mockResolvedValue(false);
		await button(wrapper, 'Resume').trigger('click');
		await flushPromises();

		expect(runs.resume).not.toHaveBeenCalled();
		expect(showToast).toHaveBeenCalledWith(expect.stringContaining("wasn't resumed"), 'error');
		wrapper.unmount();
	});

	it('resumes after the save lands', async () => {
		stubPage('paused');
		const wrapper = await mountBuilder();
		await button(wrapper, 'Resume').trigger('click');
		await flushPromises();

		expect(flushStepSave).toHaveBeenCalled();
		expect(runs.resume).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});
});

describe('Save draft', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('does not report a saved draft when the step save failed', async () => {
		stubPage();
		const wrapper = await mountBuilder();
		flushStepSave.mockResolvedValue(false);
		await button(wrapper, 'Save draft').trigger('click');
		await flushPromises();

		expect(showToast).not.toHaveBeenCalledWith('Draft saved');
		expect(showToast).toHaveBeenCalledWith(expect.stringContaining("couldn't be saved"), 'error');
		wrapper.unmount();
	});

	it('reports a saved draft once both parts landed', async () => {
		stubPage();
		const wrapper = await mountBuilder();
		await button(wrapper, 'Save draft').trigger('click');
		await flushPromises();

		expect(runs.update).toHaveBeenCalledTimes(1);
		expect(showToast).toHaveBeenCalledWith('Draft saved');
		wrapper.unmount();
	});
});
