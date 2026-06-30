/**
 * Wizard navigation composable
 * Provides step-based navigation for multi-step forms/wizards
 */

export interface WizardStep<T extends string = string> {
	id: T;
	label: string;
	number: number;
}

export type StepStatus = 'completed' | 'current' | 'upcoming';

export function useWizard<T extends string>(steps: WizardStep<T>[], initialStep?: T) {
	const defaultStep = initialStep ?? steps[0]?.id ?? ('' as T);
	const currentStep = ref<T>(defaultStep) as Ref<T>;

	const currentStepIndex = computed(() => steps.findIndex((s) => s.id === currentStep.value));

	const currentStepData = computed(() => steps[currentStepIndex.value]);

	const isFirstStep = computed(() => currentStepIndex.value === 0);

	const isLastStep = computed(() => currentStepIndex.value === steps.length - 1);

	const getStepStatus = (stepId: T): StepStatus => {
		const stepIndex = steps.findIndex((s) => s.id === stepId);

		if (stepIndex < currentStepIndex.value) {
			return 'completed';
		} else if (stepIndex === currentStepIndex.value) {
			return 'current';
		}
		return 'upcoming';
	};

	const isConnectorHighlighted = (index: number): boolean => {
		const nextStep = steps[index + 1];
		if (!nextStep) return false;
		const status = getStepStatus(nextStep.id);
		return status === 'completed' || status === 'current';
	};

	const goToStep = (stepId: T) => {
		if (steps.some((s) => s.id === stepId)) {
			currentStep.value = stepId;
		}
	};

	const goToNext = () => {
		const nextStep = steps[currentStepIndex.value + 1];
		if (nextStep) {
			currentStep.value = nextStep.id;
		}
	};

	const goToPrevious = () => {
		const previousStep = steps[currentStepIndex.value - 1];
		if (previousStep) {
			currentStep.value = previousStep.id;
		}
	};

	const canGoNext = computed(() => currentStepIndex.value < steps.length - 1);

	const canGoPrevious = computed(() => currentStepIndex.value > 0);

	return {
		steps,
		currentStep,
		currentStepIndex,
		currentStepData,
		isFirstStep,
		isLastStep,
		getStepStatus,
		isConnectorHighlighted,
		goToStep,
		goToNext,
		goToPrevious,
		canGoNext,
		canGoPrevious,
	};
}
