import type { EmailTheme, UniversalMargin, UniversalPadding } from './types';

/**
 * Email design defaults: the one list.
 *
 * The renderer (the email that is sent), the builder canvas (what the editor
 * paints) and the web settings page ("Reset to defaults") all read these
 * values, so changing a brand default here changes all three together.
 *
 * Type-only imports on purpose: the renderer and builder load this module in
 * every bundle that renders an email.
 */

/** Base content width in px of a rendered email. */
export const DEFAULT_EMAIL_BASE_WIDTH = 600;

/**
 * The fully populated default email theme. The renderer fills in only the
 * keys it needs (see `DEFAULT_THEME` in `@owlat/email-renderer`'s renderer);
 * the builder and the web app read the whole object.
 */
export const DEFAULT_EMAIL_THEME: Required<EmailTheme> = {
	primaryColor: '#c4785a',
	fontFamily: 'Arial, sans-serif',
	backgroundColor: '#ffffff',
	headingFontFamily: 'Arial, sans-serif',
	bodyFontSize: 16,
	bodyTextColor: '#333333',
	linkColor: '#2563eb',
	borderRadius: 0,
	spacingUnit: 8,
	buttonDefaults: {},
	headingDefaults: {},
	blockDefaults: {},
	darkModeBackgroundColor: '#121212',
	darkModeTextColor: '#e4e4e7',
	darkModeLinkColor: '#93c5fd',
	baseWidth: DEFAULT_EMAIL_BASE_WIDTH,
};

/** Padding a block gets when its content does not set one. */
export const DEFAULT_BLOCK_PADDING: UniversalPadding = {
	paddingTop: 16,
	paddingRight: 24,
	paddingBottom: 16,
	paddingLeft: 24,
	paddingLinked: false,
};

/** Margin a block gets when its content does not set one. */
export const DEFAULT_BLOCK_MARGIN: UniversalMargin = {
	marginTop: 0,
	marginRight: 0,
	marginBottom: 0,
	marginLeft: 0,
};
