import type { BlockType, BlockTypeContentMap, ButtonBlockContent, TextBlockContent } from './blocks';

/**
 * Email theme configuration / design tokens
 */
export interface EmailTheme {
	/** Primary brand color (default: '#c4785a') */
	primaryColor?: string;
	/** Font family (default: 'Arial, sans-serif') */
	fontFamily?: string;
	/** Background color (default: '#ffffff') */
	backgroundColor?: string;
	/** Heading font family (falls back to fontFamily) */
	headingFontFamily?: string;
	/** Body font size in px (default: 16) */
	bodyFontSize?: number;
	/** Body text color (default: '#333333') */
	bodyTextColor?: string;
	/** Link color (default: '#2563eb') */
	linkColor?: string;
	/** Global default border radius in px */
	borderRadius?: number;
	/** Base spacing multiplier in px */
	spacingUnit?: number;
	/** Default button styles merged into all button blocks */
	buttonDefaults?: Partial<Pick<ButtonBlockContent, 'backgroundColor' | 'textColor' | 'borderRadius' | 'fontSize' | 'fontFamily' | 'fontWeight' | 'paddingX' | 'paddingY'>>;
	/** Default heading styles per level */
	headingDefaults?: Partial<Record<'h1' | 'h2' | 'h3', Partial<Pick<TextBlockContent, 'fontSize' | 'fontWeight' | 'textColor' | 'lineHeight' | 'letterSpacing'>>>>;
	/**
	 * Global defaults for any block type (mj-attributes equivalent).
	 * Properties are shallow-merged into block content before rendering.
	 * Block-level values always override these defaults.
	 */
	blockDefaults?: { [K in BlockType]?: Partial<BlockTypeContentMap[K]> };
	/** Dark mode background color (default: '#121212') */
	darkModeBackgroundColor?: string;
	/** Dark mode text color (default: '#e4e4e7') */
	darkModeTextColor?: string;
	/** Dark mode link color (default: '#93c5fd') */
	darkModeLinkColor?: string;
	/** Base content width in px (default: 600, min: 400, max: 800). Affects layout, columns, and VML. */
	baseWidth?: number;
}
