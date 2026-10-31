/**
 * Content types of the basic email editor blocks: text, image, button,
 * divider, spacer and columns.
 *
 * Import from `blocks.ts`, which re-exports everything here.
 */

import type {
	BorderStyle,
	ConditionalOption,
	CssClassOption,
	DarkModeOverrides,
	FullWidthOption,
	GradientBackground,
	ResponsiveVisibility,
	TextBlockType,
} from './blockOptions';

/**
 * Text block content
 */
export interface TextBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	html: string;
	blockType: TextBlockType;
	fontSize: number;
	textColor: string;
	textAlign?: 'left' | 'center' | 'right' | 'justify';
	lineHeight?: number;
	/** Block-level font weight (e.g. 400, 700) */
	fontWeight?: number;
	/** Letter spacing in px */
	letterSpacing?: number;
	/** Text transform */
	textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
	/** Text decoration */
	textDecoration?: 'none' | 'underline' | 'line-through';
	/** Per-block font family override */
	fontFamily?: string;
	/** Font size on mobile (rendered via media query) */
	mobileFontSize?: number;
	paddingTop?: number;
	paddingRight?: number;
	paddingBottom?: number;
	paddingLeft?: number;
	paddingLinked?: boolean;
	marginTop?: number;
	marginRight?: number;
	marginBottom?: number;
	marginLeft?: number;
	backgroundColor?: string;
	borderRadius?: number;
	borderWidth?: number;
	borderColor?: string;
	borderStyle?: BorderStyle;
}

/**
 * Image block content
 */
export interface ImageBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	src: string;
	alt: string;
	width: number;
	align: 'left' | 'center' | 'right';
	/**
	 * Marks the image as purely decorative: the empty `alt` is intentional, so
	 * the renderer emits `role="presentation"` and the accessibility audit stops
	 * reporting the missing alt text.
	 */
	decorative?: boolean;
	/** Durable blob identity paired with src. */
	storageId?: string;
	/** Durable media-library provenance authorizing storageId. */
	mediaAssetId?: string;
	/** Durable blob identity paired with darkSrc. */
	darkStorageId?: string;
	/** Durable media-library provenance authorizing darkStorageId. */
	darkMediaAssetId?: string;
	linkUrl?: string;
	/** Optional fixed height in px */
	height?: number;
	/** Title attribute for accessibility */
	title?: string;
	/** Whether image should be 100% width on mobile */
	fluidOnMobile?: boolean;
	/** Responsive image srcset for retina/HiDPI displays */
	srcset?: string;
	/** Sizes attribute for responsive images */
	sizes?: string;
	/** Alternative image source for dark mode (toggled via prefers-color-scheme CSS) */
	darkSrc?: string;
	paddingTop?: number;
	paddingRight?: number;
	paddingBottom?: number;
	paddingLeft?: number;
	paddingLinked?: boolean;
	marginTop?: number;
	marginRight?: number;
	marginBottom?: number;
	marginLeft?: number;
	backgroundColor?: string;
	borderRadius?: number;
	borderWidth?: number;
	borderColor?: string;
	borderStyle?: BorderStyle;
}

/**
 * Button block content
 */
export interface ButtonBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	text: string;
	url: string;
	backgroundColor: string;
	textColor: string;
	align: 'left' | 'center' | 'right' | 'full';
	borderRadius: number;
	paddingX: number;
	paddingY: number;
	/** Independent font size for button text */
	fontSize?: number;
	/** Independent font family for button */
	fontFamily?: string;
	/** Font weight (e.g. 400, 700) */
	fontWeight?: number;
	/** Letter spacing in px */
	letterSpacing?: number;
	/** Text transform */
	textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
	/** Border width on the button element itself */
	buttonBorderWidth?: number;
	/** Border color on the button element */
	buttonBorderColor?: string;
	/** Border style on the button element */
	buttonBorderStyle?: BorderStyle;
	/** Explicit button width (px or %) */
	buttonWidth?: string;
	/** Link target attribute */
	target?: '_blank' | '_self';
	/** Gradient background (CSS linear-gradient with VML fallback) */
	backgroundGradient?: GradientBackground;
	paddingTop?: number;
	paddingRight?: number;
	paddingBottom?: number;
	paddingLeft?: number;
	paddingLinked?: boolean;
	marginTop?: number;
	marginRight?: number;
	marginBottom?: number;
	marginLeft?: number;
	blockBackgroundColor?: string;
	borderWidth?: number;
	borderColor?: string;
	borderStyle?: BorderStyle;
}

/**
 * Divider block content
 */
export interface DividerBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	color: string;
	thickness: number;
	width: number;
	style: 'solid' | 'dashed' | 'dotted';
	/** Divider alignment */
	align?: 'left' | 'center' | 'right';
	paddingTop?: number;
	paddingRight?: number;
	paddingBottom?: number;
	paddingLeft?: number;
	paddingLinked?: boolean;
	marginTop?: number;
	marginRight?: number;
	marginBottom?: number;
	marginLeft?: number;
	backgroundColor?: string;
	borderWidth?: number;
	borderColor?: string;
	borderStyle?: BorderStyle;
}

/**
 * Spacer block content
 */
export interface SpacerBlockContent
	extends DarkModeOverrides, ResponsiveVisibility, CssClassOption, ConditionalOption {
	height: number;
	paddingTop?: number;
	paddingRight?: number;
	paddingBottom?: number;
	paddingLeft?: number;
	paddingLinked?: boolean;
	marginTop?: number;
	marginRight?: number;
	marginBottom?: number;
	marginLeft?: number;
	backgroundColor?: string;
	borderWidth?: number;
	borderColor?: string;
	borderStyle?: BorderStyle;
}

/**
 * A column item is a simplified block that can be nested inside columns
 */
export interface ColumnItem {
	id: string;
	type: 'text' | 'image' | 'button' | 'divider' | 'spacer';
	content:
		| TextBlockContent
		| ImageBlockContent
		| ButtonBlockContent
		| DividerBlockContent
		| SpacerBlockContent;
}

/**
 * Column ratio presets
 */
export type ColumnRatio = 'equal' | 'left-wide' | 'right-wide' | 'left-narrow' | 'right-narrow';

/**
 * Per-column styling options
 */
export interface ColumnStyle {
	backgroundColor?: string;
	paddingTop?: number;
	paddingRight?: number;
	paddingBottom?: number;
	paddingLeft?: number;
	verticalAlign?: 'top' | 'middle' | 'bottom';
	/** Column border width */
	borderWidth?: number;
	/** Column border color */
	borderColor?: string;
	/** Column border style */
	borderStyle?: BorderStyle;
	/** Column border radius */
	borderRadius?: number;
	/** Background image URL (CSS-only, Outlook falls back to backgroundColor) */
	backgroundImage?: string;
	/** Background image position */
	backgroundPosition?: 'top' | 'center' | 'bottom' | 'left' | 'right';
	/** Background image size */
	backgroundSize?: 'cover' | 'contain' | 'auto';
	/** Per-column opt-out from mobile stacking (default: true, follows parent mobileStacking) */
	stackOnMobile?: boolean;
}

/**
 * Columns block content
 */
export interface ColumnsBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	columnCount: 1 | 2 | 3 | 4;
	ratio: ColumnRatio;
	mobileStacking: boolean;
	columns: ColumnItem[][];
	/** Vertical alignment for all columns */
	verticalAlign?: 'top' | 'middle' | 'bottom';
	/** Gap between columns in px */
	columnGap?: number;
	/** Per-column styling overrides */
	columnStyles?: ColumnStyle[];
	/** Text direction for column ordering */
	direction?: 'ltr' | 'rtl';
	/** Mobile stacking order: 'normal' preserves desktop order, 'reverse' flips it */
	mobileStackOrder?: 'normal' | 'reverse';
	paddingTop?: number;
	paddingRight?: number;
	paddingBottom?: number;
	paddingLeft?: number;
	paddingLinked?: boolean;
	marginTop?: number;
	marginRight?: number;
	marginBottom?: number;
	marginLeft?: number;
	backgroundColor?: string;
	borderRadius?: number;
	borderWidth?: number;
	borderColor?: string;
	borderStyle?: BorderStyle;
}
