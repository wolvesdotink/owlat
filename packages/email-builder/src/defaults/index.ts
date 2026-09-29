/**
 * Block padding, block margin and the email theme come from the shared leaf
 * `@owlat/shared/emailDefaults`, which the renderer and the web settings page
 * read too, so the canvas, the sent email and "Reset to defaults" agree.
 */
export {
	DEFAULT_BLOCK_PADDING as defaultPadding,
	DEFAULT_BLOCK_MARGIN as defaultMargin,
	DEFAULT_EMAIL_THEME as defaultTheme,
} from '@owlat/shared/emailDefaults';

/**
 * Default background color (transparent/none)
 */
export const defaultBackgroundColor = 'transparent';

/**
 * Default border radius (0 = no rounding)
 */
export const defaultBorderRadius = 0;
