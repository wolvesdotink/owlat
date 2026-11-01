import { ref } from 'vue';
import type { useAutomationSteps } from '~/composables/useAutomationSteps';

type AutomationSteps = ReturnType<typeof useAutomationSteps>;

/** Where leaving the open step goes once its save lands, and what Stay restores. */
type StepExit = { proceed: () => unknown; stay?: () => void };

/**
 * Leaving the open step (Close, Add step, another step, a reorder) waits for
 * its save and then goes ahead. Only when the save fails, or the step changed
 * elsewhere under unsaved edits, does the member get asked: Retry, Discard or
 * Stay. Stay keeps the selection and every value as they were.
 */
export function useStepExit(
	steps: Pick<
		AutomationSteps,
		| 'flushStepSave'
		| 'hasRemoteStepChange'
		| 'keepLocalStepConfig'
		| 'takeRemoteStepConfig'
		| 'discardStepChanges'
	>
) {
	const {
		flushStepSave,
		hasRemoteStepChange,
		keepLocalStepConfig,
		takeRemoteStepConfig,
		discardStepChanges,
	} = steps;

	const pendingStepExit = ref<StepExit | null>(null);
	const isRetryingStepExit = ref(false);
	async function afterStepSaved(proceed: () => unknown, stay?: () => void) {
		if (await flushStepSave()) {
			await proceed();
			return;
		}
		pendingStepExit.value = { proceed, stay };
	}
	const continueStepExit = async () => {
		const exit = pendingStepExit.value;
		pendingStepExit.value = null;
		await exit?.proceed();
	};
	const retryStepExit = async () => {
		isRetryingStepExit.value = true;
		let saved: boolean;
		try {
			saved = hasRemoteStepChange.value ? await keepLocalStepConfig() : await flushStepSave();
		} finally {
			isRetryingStepExit.value = false;
		}
		if (saved) await continueStepExit();
	};
	const discardStepExit = async () => {
		if (hasRemoteStepChange.value) takeRemoteStepConfig();
		else discardStepChanges();
		await continueStepExit();
	};
	const stayOnStep = () => {
		const exit = pendingStepExit.value;
		pendingStepExit.value = null;
		exit?.stay?.();
	};

	return {
		pendingStepExit,
		isRetryingStepExit,
		afterStepSaved,
		retryStepExit,
		discardStepExit,
		stayOnStep,
	};
}
