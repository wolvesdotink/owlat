/**
 * Preset colours for mailbox labels, derived from the Fluid Functionalism
 * semantic tokens (packages/ui/assets/css/tokens.css) rather than the generic
 * Tailwind swatch palette that used to live inline in PostboxLabelManager.
 *
 * A label's colour is persisted as a concrete hex string (it is applied via an
 * inline `background-color` and can be rendered outside a themed context), so
 * these mirror the *dark-theme source values* of the FF tokens they name. Keep
 * each `hex` in sync with the matching `--color-*` token — the unit test in
 * `__tests__/labelPalette.test.ts` reads tokens.css and fails if a preset drifts
 * away from its token.
 */
export interface LabelPresetColor {
	/** The FF token this swatch is drawn from (without the `--color-` prefix). */
	readonly token: string;
	/** The concrete hex persisted as the label colour. */
	readonly hex: string;
}

export const LABEL_PRESET_COLORS = [
	{ token: 'brand', hex: '#c4785a' },
	{ token: 'accent', hex: '#d4a574' },
	{ token: 'success', hex: '#7a9b6e' },
	{ token: 'info', hex: '#6b8fa8' },
	{ token: 'warning', hex: '#c9a55a' },
	{ token: 'error', hex: '#c46b5a' },
	{ token: 'brand-dim', hex: '#8c5640' },
] as const satisfies readonly LabelPresetColor[];

/** Just the hex values, in preset order — the shape the picker iterates over. */
export const LABEL_PRESET_HEXES: readonly string[] = LABEL_PRESET_COLORS.map((c) => c.hex);

/** The default colour offered for a new label (the terracotta brand accent). */
export const DEFAULT_LABEL_COLOR: string = LABEL_PRESET_COLORS[0].hex;
