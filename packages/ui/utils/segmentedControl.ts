/**
 * Keyboard roving for UiSegmentedControl. Pure index arithmetic over the
 * options, so the disabled-skipping rules are unit-testable without a DOM.
 */

export interface SegmentLike {
	value: string;
	disabled?: boolean;
}

/**
 * The first enabled option at or after `start`, stepping by `step` and
 * wrapping. Visits each option at most once, so an all-disabled or empty list
 * returns -1 instead of looping.
 */
export function segmentEnabledIndex(
	options: readonly SegmentLike[],
	start: number,
	step: 1 | -1
): number {
	const count = options.length;
	for (let offset = 0; offset < count; offset++) {
		const index = (((start + step * offset) % count) + count) % count;
		if (!options[index]?.disabled) return index;
	}
	return -1;
}

/**
 * The one segment that takes Tab focus: the selected option when it is
 * enabled, else the first enabled option (no or an unknown `modelValue`, or a
 * selection that has since been disabled). -1 when nothing can take focus.
 */
export function segmentTabStopIndex(
	options: readonly SegmentLike[],
	modelValue: string | undefined
): number {
	const selected = options.findIndex((option) => option.value === modelValue);
	if (selected >= 0 && !options[selected]?.disabled) return selected;
	return segmentEnabledIndex(options, 0, 1);
}
