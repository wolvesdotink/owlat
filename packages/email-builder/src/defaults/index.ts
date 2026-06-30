import type { UniversalPadding, UniversalMargin, UniversalBorder, EmailTheme } from '../types';

/**
 * Default padding values for blocks
 */
export const defaultPadding: UniversalPadding = {
	paddingTop: 16,
	paddingRight: 24,
	paddingBottom: 16,
	paddingLeft: 24,
	paddingLinked: false,
};

/**
 * Default margin values for blocks
 */
export const defaultMargin: UniversalMargin = {
	marginTop: 0,
	marginRight: 0,
	marginBottom: 0,
	marginLeft: 0,
};

/**
 * Default background color (transparent/none)
 */
export const defaultBackgroundColor = 'transparent';

/**
 * Default border radius (0 = no rounding)
 */
export const defaultBorderRadius = 0;

/**
 * Default border values for blocks (no border by default)
 */
export const defaultBorder: UniversalBorder = {
	borderWidth: 0,
	borderColor: '#000000',
	borderStyle: 'none',
};

/**
 * Default email theme — provides all Required<EmailTheme> fields so
 * downstream components receive a fully-populated theme object.
 */
export const defaultTheme: Required<EmailTheme> = {
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
	baseWidth: 600,
};

/**
 * All block types available in the editor
 */
export const allBlockTypes = [
	'text',
	'image',
	'button',
	'divider',
	'spacer',
	'columns',
	'social',
	'container',
	'hero',
	'table',
	'rawHtml',
	'video',
	'accordion',
	'menu',
	'carousel',
	'list',
	'progressBar',
] as const;
