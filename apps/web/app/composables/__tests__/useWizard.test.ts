import { describe, it, expect } from 'vitest';
import { useWizard, type WizardStep } from '../useWizard';

type TestStep = 'details' | 'audience' | 'review';

const testSteps: WizardStep<TestStep>[] = [
	{ id: 'details', label: 'Details', number: 1 },
	{ id: 'audience', label: 'Audience', number: 2 },
	{ id: 'review', label: 'Review', number: 3 },
];

describe('useWizard', () => {
	describe('initialization', () => {
		it('starts at the first step by default', () => {
			const { currentStep, currentStepIndex } = useWizard(testSteps);
			expect(currentStep.value).toBe('details');
			expect(currentStepIndex.value).toBe(0);
		});

		it('starts at a specified initial step', () => {
			const { currentStep, currentStepIndex } = useWizard(testSteps, 'audience');
			expect(currentStep.value).toBe('audience');
			expect(currentStepIndex.value).toBe(1);
		});

		it('returns the steps array', () => {
			const { steps } = useWizard(testSteps);
			expect(steps).toBe(testSteps);
		});
	});

	describe('currentStepData', () => {
		it('returns the current step object', () => {
			const { currentStepData } = useWizard(testSteps);
			expect(currentStepData.value).toEqual({ id: 'details', label: 'Details', number: 1 });
		});

		it('updates when step changes', () => {
			const { currentStepData, goToNext } = useWizard(testSteps);
			goToNext();
			expect(currentStepData.value).toEqual({ id: 'audience', label: 'Audience', number: 2 });
		});
	});

	describe('navigation', () => {
		it('goToNext advances to the next step', () => {
			const { currentStep, goToNext } = useWizard(testSteps);
			goToNext();
			expect(currentStep.value).toBe('audience');
		});

		it('goToNext does nothing on the last step', () => {
			const { currentStep, goToNext } = useWizard(testSteps, 'review');
			goToNext();
			expect(currentStep.value).toBe('review');
		});

		it('goToPrevious goes back one step', () => {
			const { currentStep, goToPrevious } = useWizard(testSteps, 'audience');
			goToPrevious();
			expect(currentStep.value).toBe('details');
		});

		it('goToPrevious does nothing on the first step', () => {
			const { currentStep, goToPrevious } = useWizard(testSteps);
			goToPrevious();
			expect(currentStep.value).toBe('details');
		});

		it('goToStep navigates to a specific step', () => {
			const { currentStep, goToStep } = useWizard(testSteps);
			goToStep('review');
			expect(currentStep.value).toBe('review');
		});

		it('goToStep ignores invalid step id', () => {
			const { currentStep, goToStep } = useWizard(testSteps);
			goToStep('invalid' as TestStep);
			expect(currentStep.value).toBe('details');
		});
	});

	describe('isFirstStep / isLastStep', () => {
		it('isFirstStep is true on the first step', () => {
			const { isFirstStep } = useWizard(testSteps);
			expect(isFirstStep.value).toBe(true);
		});

		it('isFirstStep is false on other steps', () => {
			const { isFirstStep } = useWizard(testSteps, 'audience');
			expect(isFirstStep.value).toBe(false);
		});

		it('isLastStep is true on the last step', () => {
			const { isLastStep } = useWizard(testSteps, 'review');
			expect(isLastStep.value).toBe(true);
		});

		it('isLastStep is false on other steps', () => {
			const { isLastStep } = useWizard(testSteps);
			expect(isLastStep.value).toBe(false);
		});
	});

	describe('canGoNext / canGoPrevious', () => {
		it('canGoNext is true when not on last step', () => {
			const { canGoNext } = useWizard(testSteps);
			expect(canGoNext.value).toBe(true);
		});

		it('canGoNext is false on last step', () => {
			const { canGoNext } = useWizard(testSteps, 'review');
			expect(canGoNext.value).toBe(false);
		});

		it('canGoPrevious is false on first step', () => {
			const { canGoPrevious } = useWizard(testSteps);
			expect(canGoPrevious.value).toBe(false);
		});

		it('canGoPrevious is true when not on first step', () => {
			const { canGoPrevious } = useWizard(testSteps, 'audience');
			expect(canGoPrevious.value).toBe(true);
		});
	});

	describe('getStepStatus', () => {
		it('returns current for active step', () => {
			const { getStepStatus } = useWizard(testSteps, 'audience');
			expect(getStepStatus('audience')).toBe('current');
		});

		it('returns completed for steps before current', () => {
			const { getStepStatus } = useWizard(testSteps, 'audience');
			expect(getStepStatus('details')).toBe('completed');
		});

		it('returns upcoming for steps after current', () => {
			const { getStepStatus } = useWizard(testSteps, 'audience');
			expect(getStepStatus('review')).toBe('upcoming');
		});
	});

	describe('isConnectorHighlighted', () => {
		it('returns true when the next step is current or completed', () => {
			const { isConnectorHighlighted } = useWizard(testSteps, 'audience');
			// Connector at index 0 points to step at index 1 (audience = current)
			expect(isConnectorHighlighted(0)).toBe(true);
		});

		it('returns false when the next step is upcoming', () => {
			const { isConnectorHighlighted } = useWizard(testSteps);
			// Connector at index 0 points to step at index 1 (audience = upcoming)
			expect(isConnectorHighlighted(0)).toBe(false);
		});

		it('returns false for the last connector (no next step)', () => {
			const { isConnectorHighlighted } = useWizard(testSteps, 'review');
			expect(isConnectorHighlighted(2)).toBe(false);
		});
	});
});
