/**
 * The one look for a selectable card in the setup wizard (#770, #772).
 *
 * The wizard used to mark its selected card with the +10% grey surface tint,
 * which reads as disabled rather than chosen. Selected cards now use the same
 * brand-tinted border and wash as the Sealed Mail policy picker, so "selected"
 * looks selected on every step that offers a choice.
 */

const BASE =
	'rounded-xl border text-left transition-[border-color,background-color,box-shadow] duration-(--motion-fast) ease-spring';

export const SETUP_CHOICE_SELECTED = 'border-brand bg-brand/5';

export const SETUP_CHOICE_IDLE =
	'border-transparent bg-surface-1 shadow-surface-1 hover:shadow-surface-2';

/** Classes for a wizard choice card in its current state. */
export function setupChoiceClass(selected: boolean): string {
	return `${BASE} ${selected ? SETUP_CHOICE_SELECTED : SETUP_CHOICE_IDLE}`;
}
