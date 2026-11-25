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
 * A paragraph or heading of rich text.
 */
export interface TextBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	/** The text as HTML. Tags, attributes and styles outside the text policy are removed on write. */
	html: string;
	/** Whether the text is a paragraph or a heading level. */
	blockType: TextBlockType;
	/** Font size in px. */
	fontSize: number;
	/** Text color (CSS color). */
	textColor: string;
	textAlign?: 'left' | 'center' | 'right' | 'justify';
	/** Line height as a multiple of the font size, such as 1.5. */
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
	/**
	 * Marks the block that prints the sender's postal address, as the brand
	 * kit footer does.
	 *
	 * The renderer marks the element with `POSTAL_ADDRESS_BLOCK_ATTRIBUTE`
	 * (`brandKitBlocks.ts`).
	 */
	postalAddress?: boolean;
}

/**
 * An image, optionally linked.
 */
export interface ImageBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	/** Image URL (https). */
	src: string;
	/** Alternative text. Leave empty only for a decorative image. */
	alt: string;
	/** Width in percent of the space the image sits in, 1 to 100. */
	width: number;
	align: 'left' | 'center' | 'right';
	/**
	 * Marks the image as purely decorative: the empty `alt` is intentional, so
	 * the renderer emits `role="presentation"` and the accessibility audit stops
	 * reporting the missing alt text.
	 */
	decorative?: boolean;
	/** Set by the media library for an uploaded `src`. Leave it out for an external URL. */
	storageId?: string;
	/** Set by the media library for an uploaded `src`. Leave it out for an external URL. */
	mediaAssetId?: string;
	/** Set by the media library for an uploaded `darkSrc`. Leave it out for an external URL. */
	darkStorageId?: string;
	/** Set by the media library for an uploaded `darkSrc`. Leave it out for an external URL. */
	darkMediaAssetId?: string;
	/** Where a click on the image leads. */
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
 * A call-to-action button that links to a URL.
 */
export interface ButtonBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	/** The button label. */
	text: string;
	/** Where the button leads. The validator reports an empty URL or `#` as an error. */
	url: string;
	/** The button's fill color. The section around it takes `blockBackgroundColor`. */
	backgroundColor: string;
	/** Label color (CSS color). */
	textColor: string;
	/** `full` stretches the button across the available width. */
	align: 'left' | 'center' | 'right' | 'full';
	/** Corner radius of the button in px. */
	borderRadius: number;
	/** Horizontal padding inside the button in px. */
	paddingX: number;
	/** Vertical padding inside the button in px. */
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
 * A horizontal rule.
 */
export interface DividerBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	/** Line color (CSS color). */
	color: string;
	/** Line thickness in px. */
	thickness: number;
	/** Line length in percent of the available width, 1 to 100. */
	width: number;
	style: 'solid' | 'dashed' | 'dotted';
	/** Divider alignment */
	align?: 'left' | 'center' | 'right';
	borderRadius?: number;
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
 * Empty vertical space.
 */
export interface SpacerBlockContent
	extends DarkModeOverrides, ResponsiveVisibility, CssClassOption, ConditionalOption {
	/** Height in px. */
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
 * A block inside a column: text, image, button, divider or spacer.
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
 * Column width presets; `getColumnWidths` (`utils/columnWidths.ts`) maps each
 * to percentages.
 */
export type ColumnRatio = 'equal' | 'left-wide' | 'right-wide' | 'left-narrow' | 'right-narrow';

/** How many columns a columns Block holds. */
export type ColumnCount = 1 | 2 | 3 | 4 | 5;

/**
 * Styling of one column, by position.
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
 * Up to four columns side by side, each holding text, image, button, divider and spacer blocks.
 */
export interface ColumnsBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	/** How many columns render. Extra entries in `columns` are ignored. */
	columnCount: ColumnCount;
	/** Width preset for the columns. One column always takes the full width. */
	ratio: ColumnRatio;
	/**
	 * Custom column widths in whole percent, one per column, summing to 100.
	 * When valid they win over `ratio`; see `getColumnWidths`.
	 */
	columnWidths?: number[];
	/** Stack the columns on top of each other on mobile. */
	mobileStacking: boolean;
	/** The blocks of each column, one array per column, left to right. */
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
