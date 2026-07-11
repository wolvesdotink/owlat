import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, nextTick } from 'vue';
import { useAutomationSteps } from '../useAutomationSteps';

/**
 * Regression test for the drag-reorder wiring (FRONTEND_WIRING_REVIEW H3):
 * handleDragEnd must persist the order produced by the drag (from the
 * SortableJS event indices), not re-send the unchanged server order.
 */
describe('useAutomationSteps.handleDragEnd', () => {
	let runCalls: unknown[];

	beforeEach(() => {
		runCalls = [];
		vi.stubGlobal('useBackendOperation', () => ({
			run: (args: unknown) => {
				runCalls.push(args);
				return Promise.resolve('ok');
			},
			isLoading: ref(false),
			inlineError: ref(null),
		}));
		vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	});

	const makeSteps = () =>
		useAutomationSteps(
			ref('auto1') as never,
			ref({
				_id: 'auto1',
				name: 'A',
				status: 'draft',
				triggerType: 'contact_created',
				steps: [{ _id: 's1' }, { _id: 's2' }, { _id: 's3' }],
			}) as never,
			ref([]) as never
		);

	it('persists the reordered id list when an item is dragged down', async () => {
		const { handleDragEnd } = makeSteps();
		await handleDragEnd({ oldIndex: 0, newIndex: 2 });
		expect(runCalls).toHaveLength(1);
		expect(runCalls[0]).toEqual({ automationId: 'auto1', stepOrder: ['s2', 's3', 's1'] });
	});

	it('persists the reordered id list when an item is dragged up', async () => {
		const { handleDragEnd } = makeSteps();
		await handleDragEnd({ oldIndex: 2, newIndex: 0 });
		expect(runCalls[0]).toEqual({ automationId: 'auto1', stepOrder: ['s3', 's1', 's2'] });
	});

	it('does not call the mutation for a no-op drag (same index)', async () => {
		const { handleDragEnd } = makeSteps();
		await handleDragEnd({ oldIndex: 1, newIndex: 1 });
		expect(runCalls).toHaveLength(0);
	});

	it('does not call the mutation when indices are missing', async () => {
		const { handleDragEnd } = makeSteps();
		await handleDragEnd({});
		await handleDragEnd(undefined);
		expect(runCalls).toHaveLength(0);
	});
});

/**
 * The step panel's unsaved-changes guard hangs off `isCurrentConfigDirty`.
 * Selecting a step must NOT report dirty (it merely loads the persisted config),
 * and only a real edit to the open config may flip it — so a step-switch prompt
 * fires only when there is genuine work to lose.
 */
describe('useAutomationSteps step-config dirty tracking', () => {
	let updateArgs: unknown[];

	beforeEach(() => {
		updateArgs = [];
		vi.stubGlobal('useBackendOperation', () => ({
			run: (args: unknown) => {
				updateArgs.push(args);
				return Promise.resolve('ok');
			},
			isLoading: ref(false),
			inlineError: ref(null),
		}));
		vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	});

	const makeDelayEditor = () =>
		useAutomationSteps(
			ref('auto1') as never,
			ref({
				_id: 'auto1',
				name: 'A',
				status: 'draft',
				triggerType: 'contact_created',
				steps: [{ _id: 's1', stepType: 'delay', config: { duration: 1, unit: 'days' } }],
			}) as never,
			ref([]) as never
		);

	it('is clean immediately after a step is selected (ignores load)', async () => {
		const { selectedStepId, currentConfig, isCurrentConfigDirty } = makeDelayEditor();
		selectedStepId.value = 's1' as never;
		await nextTick();

		expect(currentConfig.value).not.toBeNull();
		expect(isCurrentConfigDirty.value).toBe(false);
	});

	it('flips dirty on a real edit and clears again after the step is saved', async () => {
		const { selectedStepId, currentConfig, isCurrentConfigDirty, handleUpdateStepConfig } =
			makeDelayEditor();
		selectedStepId.value = 's1' as never;
		await nextTick();

		// Edit the open config (mirrors the panel's `update:current-config`).
		currentConfig.value = { kind: 'delay', config: { duration: 5, unit: 'days' } };
		expect(isCurrentConfigDirty.value).toBe(true);

		await handleUpdateStepConfig();
		expect(updateArgs).toHaveLength(1);
		// Persisting adopts the edited config as the clean baseline.
		expect(isCurrentConfigDirty.value).toBe(false);
	});
});
