/**
 * Content types of the extended email editor blocks: table, raw HTML, video,
 * accordion, menu, carousel, list and progress bar.
 *
 * Import from `blocks.ts`, which re-exports everything here.
 */

import type {
	BorderStyle,
	ConditionalOption,
	CssClassOption,
	DarkModeOverrides,
	FullWidthOption,
	ResponsiveVisibility,
} from './blockOptions';
import type { ContainerItem } from './blockContentNested';

/**
 * Rich table cell with styling options
 */
export interface TableCell {
	/** Cell content (can contain HTML) */
	content: string;
	/** Merge columns */
	colSpan?: number;
	/** Merge rows */
	rowSpan?: number;
	/** Per-cell text alignment */
	textAlign?: 'left' | 'center' | 'right';
	/** Per-cell background color */
	backgroundColor?: string;
	/** Per-cell font weight */
	fontWeight?: number;
}

/**
 * Per-column table definition
 */
export interface TableColumn {
	/** Column width (e.g. "25%" or "100px") */
	width?: string;
	/** Column text alignment */
	textAlign?: 'left' | 'center' | 'right';
}

/**
 * Responsive table mode for mobile viewports
 * - 'default': No responsive behavior (table clips on mobile)
 * - 'stack': Each row becomes a card with header labels repeated via data-label
 * - 'scroll': Horizontal scroll wrapper (overflow-x: auto)
 * - 'hide-columns': Columns marked in hideOnMobileColumns are hidden on mobile
 */
export type TableResponsiveMode = 'default' | 'stack' | 'scroll' | 'hide-columns';

/**
 * Table block content - for data tables, invoices, pricing
 */
export interface TableBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	headers: string[];
	rows: string[][];
	headerBackgroundColor: string;
	headerTextColor: string;
	borderColor: string;
	striped: boolean;
	stripeColor: string;
	cellPadding: number;
	textAlign: 'left' | 'center' | 'right';
	/** Per-column width and alignment definitions */
	columns?: TableColumn[];
	/** Rich cell data (alternative to rows[][] for advanced layouts) */
	cells?: TableCell[][];
	/** Optional footer row */
	footerRow?: string[];
	/** Table caption for accessibility */
	captionText?: string;
	/** Responsive table mode for mobile viewports (default: 'default') */
	responsiveMode?: TableResponsiveMode;
	/** Column indices to hide on mobile (only used when responsiveMode is 'hide-columns') */
	hideOnMobileColumns?: number[];
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
	borderStyle?: BorderStyle;
}

/**
 * Raw HTML block content - escape hatch for power users
 */
export interface RawHtmlBlockContent
	extends ResponsiveVisibility, CssClassOption, ConditionalOption {
	html: string;
	paddingTop?: number;
	paddingRight?: number;
	paddingBottom?: number;
	paddingLeft?: number;
	paddingLinked?: boolean;
	marginTop?: number;
	marginRight?: number;
	marginBottom?: number;
	marginLeft?: number;
}

/**
 * Video thumbnail block content - thumbnail with play button overlay
 */
export interface VideoBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	thumbnailUrl: string;
	videoUrl: string;
	alt: string;
	width: number;
	align: 'left' | 'center' | 'right';
	playButtonColor?: string;
	playButtonSize?: number;
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
 * Accordion section item
 */
export interface AccordionSection {
	id: string;
	title: string;
	items: ContainerItem[];
}

/**
 * Accordion block content - CSS-only expandable sections
 * Works in Apple Mail, iOS Mail (~60% of clients), falls back to all sections expanded.
 */
export interface AccordionBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	sections: AccordionSection[];
	/** Whether multiple sections can be open simultaneously */
	allowMultiple?: boolean;
	/** Index of initially expanded section (-1 = all collapsed) */
	initialExpanded?: number;
	/** Header background color */
	headerBackgroundColor?: string;
	/** Header text color */
	headerTextColor?: string;
	/** Header font size */
	headerFontSize?: number;
	/** Content background color */
	contentBackgroundColor?: string;
	/** Icon color for expand/collapse indicator */
	iconColor?: string;
	/** Border color between sections */
	sectionBorderColor?: string;
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
 * Menu/navbar link item
 */
export interface MenuLink {
	label: string;
	url: string;
}

/**
 * Menu/navbar block content - horizontal navigation links
 */
export interface MenuBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	items: MenuLink[];
	align: 'left' | 'center' | 'right';
	/** Font size for menu links */
	fontSize?: number;
	/** Font family for menu links */
	fontFamily?: string;
	/** Font weight for menu links */
	fontWeight?: number;
	/** Text color for menu links */
	textColor?: string;
	/** Text transform */
	textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
	/** Spacing between items in px */
	itemSpacing?: number;
	/** Separator character between items (e.g. '|', '·') */
	separator?: string;
	/** Separator color */
	separatorColor?: string;
	/** Enable hamburger toggle on mobile */
	hamburgerOnMobile?: boolean;
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
 * Carousel image item
 */
export interface CarouselImage {
	src: string;
	alt: string;
	linkUrl?: string;
	thumbnailSrc?: string;
}

/**
 * Carousel block content - CSS-only image slideshow
 * Interactive in Apple Mail, iOS (~40% of clients). Falls back to first/stacked images.
 */
export interface CarouselBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	images: CarouselImage[];
	/** Navigation dot size in px */
	iconWidth?: number;
	/** Active dot/nav color */
	iconColor?: string;
	/** Inactive dot color */
	iconInactiveColor?: string;
	/** Thumbnail strip width in px (0 = hidden) */
	thumbnailWidth?: number;
	/** Border radius on images */
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
 * List block content - table-based list rendering for cross-client consistency
 */
export interface ListBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	/** List item text (can contain HTML) */
	items: string[];
	/** List style type */
	listType: 'bullet' | 'numbered' | 'check' | 'icon';
	/** Bullet/number color */
	bulletColor?: string;
	/** Bullet/number font size */
	bulletSize?: number;
	/** Custom icon URL for 'icon' list type */
	iconUrl?: string;
	/** Text font size */
	fontSize?: number;
	/** Text color */
	textColor?: string;
	/** Spacing between items in px */
	itemSpacing?: number;
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
 * Progress bar block content - table-based progress indicator
 */
export interface ProgressBarBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	/** Current value (0-100) */
	value: number;
	/** Maximum value (default 100) */
	maxValue?: number;
	/** Filled bar color */
	barColor: string;
	/** Track background color */
	trackColor: string;
	/** Bar height in px */
	height: number;
	/** Border radius on bar ends */
	borderRadius?: number;
	/** Show percentage label */
	showLabel?: boolean;
	/** Label position */
	labelPosition?: 'inside' | 'right';
	/** Label text color */
	labelColor?: string;
	/** Label font size */
	labelFontSize?: number;
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
