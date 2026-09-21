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

export interface UseWizardOptions<T extends string> {
	/** Step to open on when the URL says nothing. Defaults to the first step. */
	initialStep?: T;
	/**
	 * Mirror the current step in the URL so Back means "previous step", a
	 * refresh resumes where the user was, and the link is shareable. `true`
	 * uses `?step=`; pass a string to name the query parameter.
	 */
	syncQuery?: boolean | string;
	/**
	 * Whether a step's work is done. Deep links are validated against it: an
	 * unknown or not-yet-reachable step redirects to the first incomplete one.
	 * Without it every declared step is reachable.
	 */
	isStepComplete?: (stepId: T) => boolean;
	/**
	 * Hold that validation until the state `isStepComplete` reads has loaded.
	 * A draft that arrives one tick after mount would otherwise look incomplete
	 * and rewrite a perfectly good deep link back to step one.
	 */
	isReady?: () => boolean;
}

export function useWizard<T extends string>(
	steps: WizardStep<T>[],
	initialStepOrOptions?: T | UseWizardOptions<T>
) {
	const options: UseWizardOptions<T> =
		typeof initialStepOrOptions === 'string'
			? { initialStep: initialStepOrOptions }
			: (initialStepOrOptions ?? {});

	const defaultStep = options.initialStep ?? steps[0]?.id ?? ('' as T);
	const indexOf = (stepId: T | undefined) => steps.findIndex((s) => s.id === stepId);

	const syncQuery = Boolean(options.syncQuery);
	const queryKey = typeof options.syncQuery === 'string' ? options.syncQuery : 'step';

	const route = syncQuery ? useRoute() : null;
	const router = syncQuery ? useRouter() : null;

	// Fallback holder for the un-synced case; unused once the URL owns the step.
	const localStep = ref<T>(defaultStep) as Ref<T>;

	// The furthest step the user has actually been sent to in this session.
	// A "Next" unlocks its target before the URL changes, so a step whose
	// completion has not round-tripped through the server yet is never bounced
	// back the instant the user reaches it.
	const reachedIndex = ref(Math.max(indexOf(defaultStep), 0));

	const firstIncompleteIndex = computed(() => {
		const isComplete = options.isStepComplete;
		if (!isComplete) return steps.length - 1;
		const index = steps.findIndex((step) => !isComplete(step.id));
		return index === -1 ? steps.length - 1 : index;
	});

	const furthestAllowedIndex = computed(() =>
		Math.max(firstIncompleteIndex.value, reachedIndex.value)
	);

	/** The step the URL asks for, clamped to one the user may actually be on. */
	const resolveStep = (raw: unknown): T => {
		const candidate = steps.find((step) => step.id === raw)?.id;
		if (!options.isStepComplete || options.isReady?.() === false) {
			return candidate ?? defaultStep;
		}
		const allowed = steps[furthestAllowedIndex.value]?.id ?? defaultStep;
		if (candidate === undefined) return allowed;
		return indexOf(candidate) > furthestAllowedIndex.value ? allowed : candidate;
	};

	const navigate = async (stepId: T, mode: 'push' | 'replace' = 'push') => {
		const index = indexOf(stepId);
		if (index === -1) return;
		reachedIndex.value = Math.max(reachedIndex.value, index);

		if (!route || !router) {
			localStep.value = stepId;
			return;
		}
		if (route.query[queryKey] === stepId) return;
		await router[mode]({ query: { ...route.query, [queryKey]: stepId } });
	};

	const currentStep = computed<T>({
		get: () => (route ? resolveStep(route.query[queryKey]) : localStep.value),
		set: (stepId: T) => {
			void navigate(stepId);
		},
	});

	// Keep the URL honest: an unknown, premature or absent step is rewritten
	// (in place — a correction is not a history entry) to the step actually
	// being rendered. Re-runs when the completion state settles.
	if (route && router) {
		watch(
			() => [route.query[queryKey], resolveStep(route.query[queryKey])] as const,
			([raw, resolved]) => {
				if (raw === resolved) return;
				void navigate(resolved, 'replace');
			},
			{ immediate: true }
		);
	}

	const currentStepIndex = computed(() => indexOf(currentStep.value));

	const currentStepData = computed(() => steps[currentStepIndex.value]);

	const isFirstStep = computed(() => currentStepIndex.value === 0);

	const isLastStep = computed(() => currentStepIndex.value === steps.length - 1);

	const getStepStatus = (stepId: T): StepStatus => {
		const stepIndex = indexOf(stepId);

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
		void navigate(stepId);
	};

	const goToNext = () => {
		const nextStep = steps[currentStepIndex.value + 1];
		if (nextStep) void navigate(nextStep.id);
	};

	const goToPrevious = () => {
		const previousStep = steps[currentStepIndex.value - 1];
		if (previousStep) void navigate(previousStep.id);
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
