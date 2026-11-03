/**
 * How an unread Postbox list row stands out from a read one.
 *
 * Weight alone is a weak cue: the UI font's semibold is 550, so in a list of
 * mostly unread mail the one opened row is hard to spot, and harder still on a
 * dim screen or for someone with low vision. The other styles add a cue that
 * does not depend on telling two weights apart:
 *
 *   - 'weight'     → heavier sender and subject only.
 *   - 'dot'        → an accent dot before the sender, no weight change. A shape
 *                    cue, so it also works without colour perception.
 *   - 'dot-weight' → both (the default).
 *   - 'tint'       → a light accent wash on the row, plus the weight.
 *
 * Like density, the style is applied as one `data-unread-style` attribute on
 * the Postbox root and every visual difference lives in CSS keyed off it
 * (postbox-unread.css). Rows only mark themselves unread; they never branch on
 * the style.
 */

export type PostboxUnreadStyle = 'weight' | 'dot' | 'dot-weight' | 'tint';

export const POSTBOX_UNREAD_STYLE_DEFAULT: PostboxUnreadStyle = 'dot-weight';

/**
 * The picker options. Module scope never calls `useI18n`, so `label` is the
 * catalog key the rendering surface resolves through `t()`.
 */
export const POSTBOX_UNREAD_STYLE_OPTIONS: Array<{
	value: PostboxUnreadStyle;
	label: string;
}> = [
	{ value: 'dot-weight', label: 'shared.postboxUnreadStyle.dotWeight' },
	{ value: 'dot', label: 'shared.postboxUnreadStyle.dot' },
	{ value: 'weight', label: 'shared.postboxUnreadStyle.weight' },
	{ value: 'tint', label: 'shared.postboxUnreadStyle.tint' },
];

/** Normalise a stored/unknown value to a valid style, defaulting safely. */
export function resolvePostboxUnreadStyle(value: string | undefined | null): PostboxUnreadStyle {
	return value === 'weight' || value === 'dot' || value === 'tint'
		? value
		: POSTBOX_UNREAD_STYLE_DEFAULT;
}
