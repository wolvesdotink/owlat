import { describe, it, expect } from 'vitest';
import {
	SPINNER_SIZE_CLASSES,
	DEFAULT_SPINNER_SIZE,
	type SpinnerSize,
} from '../spinnerSizes';

describe('UiSpinner size mapping', () => {
	it('maps each size token to the expected Tailwind width/height classes', () => {
		expect(SPINNER_SIZE_CLASSES).toEqual({
			xs: 'w-4 h-4',
			sm: 'w-5 h-5',
			md: 'w-6 h-6',
			lg: 'w-8 h-8',
			xl: 'w-12 h-12',
		});
	});

	it('defaults to lg (w-8 h-8), matching the pre-refactor brand spinner', () => {
		expect(DEFAULT_SPINNER_SIZE).toBe('lg');
		expect(SPINNER_SIZE_CLASSES[DEFAULT_SPINNER_SIZE]).toBe('w-8 h-8');
	});

	it('covers exactly the five documented sizes', () => {
		const sizes: SpinnerSize[] = ['xs', 'sm', 'md', 'lg', 'xl'];
		expect(Object.keys(SPINNER_SIZE_CLASSES).sort()).toEqual(
			[...sizes].sort(),
		);
	});
});
