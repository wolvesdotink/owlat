import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, nextTick } from 'vue';
import { useAutomationSteps } from '../useAutomationSteps';
import { createTestI18n } from '~/__tests__/i18n';

/** The real catalog behind the `useI18n` auto-import the composable calls. */
const i18n = createTestI18n();

/**
 * The builder hands over the full order it shows; the composable sends that
 * order as is. It must not re-derive one from the server snapshot, which
 * lags behind the screen while a reorder is in flight.
 */
describe('useAutomationSteps.persistStepOrder', () => {
	let runCalls: unknown[];
	let runOk: boolean;

	beforeEach(() => {
		runCalls = [];
		runOk = true;
		vi.stubGlobal('useI18n', () => i18n.global);
		vi.stubGlobal('useBackendOperation', () => ({
			run: (args: unknown) => {
				runCalls.push(args);
				return Promise.resolve(runOk ? { ok: true, result: 'ok' } : { ok: false });
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

	it('sends the given id order as the new step order', async () => {
		const { persistStepOrder } = makeSteps();
		await persistStepOrder(['s2', 's3', 's1'] as never);
		expect(runCalls).toEqual([{ automationId: 'auto1', stepOrder: ['s2', 's3', 's1'] }]);
	});

	it('reports whether the new order was saved', async () => {
		const { persistStepOrder } = makeSteps();
		expect(await persistStepOrder(['s2', 's1', 's3'] as never)).toBe(true);
		runOk = false;
		expect(await persistStepOrder(['s2', 's1', 's3'] as never)).toBe(false);
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
				return Promise.resolve({ ok: true, result: 'ok' });
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
		const { selectedStepId, currentConfig, isCurrentConfigDirty, requestStepSave } =
			makeDelayEditor();
		selectedStepId.value = 's1' as never;
		await nextTick();

		// Edit the open config (mirrors the panel's `update:current-config`).
		currentConfig.value = { kind: 'delay', config: { duration: 5, unit: 'days' } };
		expect(isCurrentConfigDirty.value).toBe(true);

		await requestStepSave();
		expect(updateArgs).toHaveLength(1);
		// Persisting adopts the edited config as the clean baseline.
		expect(isCurrentConfigDirty.value).toBe(false);
	});
});
