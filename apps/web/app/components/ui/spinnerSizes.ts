/**
 * Size tokens for <UiSpinner /> mapped to their Tailwind width/height utilities.
 *
 * Kept in a standalone module (rather than inline in the SFC) so the mapping can
 * be unit-tested without compiling the Vue single-file component.
 */
export type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export const SPINNER_SIZE_CLASSES: Record<SpinnerSize, string> = {
	xs: 'w-4 h-4',
	sm: 'w-5 h-5',
	md: 'w-6 h-6',
	lg: 'w-8 h-8',
	xl: 'w-12 h-12',
};

export const DEFAULT_SPINNER_SIZE: SpinnerSize = 'lg';
