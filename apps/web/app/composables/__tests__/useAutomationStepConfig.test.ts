import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, nextTick } from 'vue';
import { useAutomationStepConfig } from '../useAutomationStepConfig';
import { createTestI18n } from '~/__tests__/i18n';

const i18n = createTestI18n();

type Outcome = { ok: true; result: null } | { ok: false };

/**
 * Autosave for the open step (#1043). The update mutation is held open by the
 * test, so a save can be observed while it is pending, made to fail, and
 * overlapped by later edits.
 */
describe('useAutomationStepConfig autosave', () => {
	let calls: { args: { stepId: string; config: unknown }; settle: (o: Outcome) => void }[];

	beforeEach(() => {
		calls = [];
		vi.stubGlobal('useI18n', () => i18n.global);
		vi.stubGlobal('useBackendOperation', () => ({
			run: (args: { stepId: string; config: unknown }) =>
				new Promise<Outcome>((resolve) => calls.push({ args, settle: resolve })),
			isLoading: ref(false),
			inlineError: ref(null),
		}));
	});

	const settle = async (index: number, outcome: Outcome) => {
		calls[index]!.settle(outcome);
		// Let the save loop observe the result and decide on a follow-up.
		for (let i = 0; i < 10; i++) await Promise.resolve();
		await nextTick();
	};
	const ok: Outcome = { ok: true, result: null };
	const failed: Outcome = { ok: false };

	const setup = () => {
		const automation = ref({
			steps: [
				{ _id: 's1', stepType: 'delay', config: { duration: 1, unit: 'days' } },
				{ _id: 's2', stepType: 'delay', config: { duration: 2, unit: 'days' } },
			],
		});
		const selectedStepId = ref<string | null>('s1');
		const config = useAutomationStepConfig(selectedStepId as never, automation as never);
		const edit = (duration: number) => {
			config.currentConfig.value = { kind: 'delay', config: { duration, unit: 'days' } };
		};
		return { automation, selectedStepId, edit, ...config };
	};

	it('sends the config as it was when the save started', async () => {
		const { edit, requestSave, saveStatus } = setup();
		edit(5);
		void requestSave();
		edit(6);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.args).toEqual({ stepId: 's1', config: { duration: 5, unit: 'days' } });
		expect(saveStatus.value).toBe('saving');
	});

	it('keeps an edit made while a save is pending dirty, then saves it once', async () => {
		const { edit, requestSave, isCurrentConfigDirty, saveStatus } = setup();
		edit(5);
		const done = requestSave();
		edit(6);
		void requestSave();
		edit(7);
		void requestSave();

		await settle(0, ok);
		// The request for 5 landed, but 7 is on screen: still dirty, and the
		// queued edits went out as one request carrying the latest value.
		expect(isCurrentConfigDirty.value).toBe(true);
		expect(calls).toHaveLength(2);
		expect(calls[1]!.args.config).toEqual({ duration: 7, unit: 'days' });

		await settle(1, ok);
		expect(await done).toBe(true);
		expect(isCurrentConfigDirty.value).toBe(false);
		expect(saveStatus.value).toBe('saved');
	});

	it('never runs two saves for the step at once', async () => {
		const { edit, requestSave } = setup();
		edit(5);
		void requestSave();
		edit(6);
		void requestSave();
		void requestSave();
		expect(calls).toHaveLength(1);
	});

	it('keeps the inputs and reports the failure when a save fails', async () => {
		const { edit, requestSave, currentConfig, isCurrentConfigDirty, saveStatus } = setup();
		edit(5);
		const done = requestSave();
		await settle(0, failed);

		expect(await done).toBe(false);
		expect(currentConfig.value?.config).toEqual({ duration: 5, unit: 'days' });
		expect(isCurrentConfigDirty.value).toBe(true);
		expect(saveStatus.value).toBe('error');
	});

	it('retries with the config on screen and recovers', async () => {
		const { edit, requestSave, isCurrentConfigDirty, saveStatus } = setup();
		edit(5);
		void requestSave();
		await settle(0, failed);
		edit(8);

		const retried = requestSave();
		expect(saveStatus.value).toBe('saving');
		expect(calls[1]!.args.config).toEqual({ duration: 8, unit: 'days' });
		await settle(1, ok);

		expect(await retried).toBe(true);
		expect(isCurrentConfigDirty.value).toBe(false);
		expect(saveStatus.value).toBe('saved');
	});

	it('flush waits for the pending save and reports its outcome', async () => {
		const { edit, requestSave, flush } = setup();
		edit(5);
		void requestSave();

		let flushed: boolean | undefined;
		void flush().then((value) => (flushed = value));
		await Promise.resolve();
		expect(flushed).toBeUndefined();

		await settle(0, failed);
		expect(flushed).toBe(false);
	});

	it('flush saves edits that no save was requested for', async () => {
		const { edit, flush } = setup();
		edit(5);
		const flushed = flush();
		await Promise.resolve();
		expect(calls).toHaveLength(1);
		await settle(0, ok);
		expect(await flushed).toBe(true);
	});

	it('flush is immediate when nothing is unsaved', async () => {
		const { flush } = setup();
		expect(await flush()).toBe(true);
		expect(calls).toHaveLength(0);
	});

	it('does not let the echo of a pending save overwrite a newer edit', async () => {
		const { automation, edit, requestSave, currentConfig } = setup();
		edit(5);
		void requestSave();
		edit(6);
		// The live query reflects the request for 5 before its promise settles.
		automation.value = {
			steps: [
				{ _id: 's1', stepType: 'delay', config: { duration: 5, unit: 'days' } },
				automation.value.steps[1]!,
			],
		};
		await nextTick();

		expect(currentConfig.value?.config).toEqual({ duration: 6, unit: 'days' });
	});

	it('discarding puts the saved config back', async () => {
		const { edit, requestSave, discardChanges, currentConfig, saveStatus } = setup();
		edit(5);
		void requestSave();
		await settle(0, failed);
		discardChanges();

		expect(currentConfig.value?.config).toEqual({ duration: 1, unit: 'days' });
		expect(saveStatus.value).toBe('saved');
	});

	const withServerConfig = (
		automation: ReturnType<typeof setup>['automation'],
		id: string,
		config: { duration: number; unit: string }
	) => {
		automation.value = {
			steps: automation.value.steps.map((step) => (step._id === id ? { ...step, config } : step)),
		};
	};

	it('leaves a dirty draft alone when another step changes', async () => {
		const { automation, edit, currentConfig, isCurrentConfigDirty } = setup();
		edit(5);
		withServerConfig(automation, 's2', { duration: 9, unit: 'days' });
		await nextTick();

		expect(currentConfig.value?.config).toEqual({ duration: 5, unit: 'days' });
		expect(isCurrentConfigDirty.value).toBe(true);
	});

	it('leaves a dirty draft alone when the steps are reordered', async () => {
		const { automation, edit, currentConfig } = setup();
		edit(5);
		automation.value = { steps: [...automation.value.steps].reverse() };
		await nextTick();

		expect(currentConfig.value?.config).toEqual({ duration: 5, unit: 'days' });
	});

	it('adopts a change made elsewhere while the draft is clean', async () => {
		const { automation, currentConfig, saveStatus } = setup();
		withServerConfig(automation, 's1', { duration: 4, unit: 'hours' });
		await nextTick();

		expect(currentConfig.value?.config).toEqual({ duration: 4, unit: 'hours' });
		expect(saveStatus.value).toBe('saved');
	});

	it('holds a same-step change made elsewhere as a conflict while dirty', async () => {
		const { automation, edit, currentConfig, saveStatus, hasRemoteChange, requestSave } = setup();
		edit(5);
		void requestSave();
		await settle(0, failed);
		withServerConfig(automation, 's1', { duration: 4, unit: 'hours' });
		await nextTick();

		expect(currentConfig.value?.config).toEqual({ duration: 5, unit: 'days' });
		expect(hasRemoteChange.value).toBe(true);
		expect(saveStatus.value).toBe('conflict');
		// Autosave does not write over the other copy until the member chooses.
		expect(await requestSave()).toBe(false);
		expect(calls).toHaveLength(1);
	});

	it('Use theirs takes the copy saved elsewhere', async () => {
		const { automation, edit, currentConfig, takeRemoteConfig, isCurrentConfigDirty } = setup();
		edit(5);
		withServerConfig(automation, 's1', { duration: 4, unit: 'hours' });
		await nextTick();
		takeRemoteConfig();

		expect(currentConfig.value?.config).toEqual({ duration: 4, unit: 'hours' });
		expect(isCurrentConfigDirty.value).toBe(false);
	});

	it('Keep mine saves the draft over the copy saved elsewhere', async () => {
		const { automation, edit, keepLocalConfig, hasRemoteChange, saveStatus } = setup();
		edit(5);
		withServerConfig(automation, 's1', { duration: 4, unit: 'hours' });
		await nextTick();
		const kept = keepLocalConfig();

		expect(hasRemoteChange.value).toBe(false);
		expect(calls[0]!.args.config).toEqual({ duration: 5, unit: 'days' });
		await settle(0, ok);
		expect(await kept).toBe(true);
		expect(saveStatus.value).toBe('saved');
	});

	it('re-seeds from the server when the selection changes', async () => {
		const { selectedStepId, edit, currentConfig, isCurrentConfigDirty } = setup();
		edit(5);
		selectedStepId.value = 's2';
		await nextTick();

		expect(currentConfig.value?.config).toEqual({ duration: 2, unit: 'days' });
		expect(isCurrentConfigDirty.value).toBe(false);
	});

	it('treats a server copy with the same values in another key order as unchanged', async () => {
		const { automation, edit, requestSave, currentConfig, hasRemoteChange } = setup();
		edit(5);
		void requestSave();
		edit(6);
		automation.value = {
			steps: [
				{ _id: 's1', stepType: 'delay', config: { unit: 'days', duration: 5 } as never },
				automation.value.steps[1]!,
			],
		};
		await nextTick();

		expect(hasRemoteChange.value).toBe(false);
		expect(currentConfig.value?.config).toEqual({ duration: 6, unit: 'days' });
	});
});
