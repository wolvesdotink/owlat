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
 * A data table, such as an invoice or a price list.
 */
export interface TableBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	/** Header cell texts, one per column. */
	headers: string[];
	/** Body rows, each an array of cell texts in column order. */
	rows: string[][];
	headerBackgroundColor: string;
	headerTextColor: string;
	/** Color of the cell borders (CSS color). */
	borderColor: string;
	/** Alternate the background of body rows. */
	striped: boolean;
	/** Background of every other body row when `striped`. */
	stripeColor: string;
	/** Cell padding in px. */
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
 * HTML written by hand, sanitized when the email renders.
 */
export interface RawHtmlBlockContent
	extends ResponsiveVisibility, CssClassOption, ConditionalOption {
	/** The HTML. Tags, attributes and styles outside the raw HTML policy are removed at render. */
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
 * A video thumbnail with a play button that links to the video.
 */
export interface VideoBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	/** Thumbnail image URL (https). */
	thumbnailUrl: string;
	/** Where a click leads, such as the video's page. */
	videoUrl: string;
	/** Alternative text of the thumbnail. */
	alt: string;
	/** Width in percent of the available width, 1 to 100. */
	width: number;
	align: 'left' | 'center' | 'right';
	playButtonColor?: string;
	/** Play button size in px. */
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
 * One section of an accordion: a title and the blocks it reveals.
 */
export interface AccordionSection {
	/** Unique within the email. */
	id: string;
	title: string;
	/** The blocks shown when the section is open. */
	items: ContainerItem[];
}

/**
 * Sections that open and close. Clients without support, Gmail among them, show every section open.
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
 * One link of a menu.
 */
export interface MenuLink {
	label: string;
	url: string;
}

/**
 * A row of navigation links.
 */
export interface MenuBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	/** The links, left to right. */
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
 * One slide of a carousel.
 */
export interface CarouselImage {
	/** Image URL (https). */
	src: string;
	alt: string;
	/** Where a click on the slide leads. */
	linkUrl?: string;
	/** Smaller image for the thumbnail strip. */
	thumbnailSrc?: string;
}

/**
 * An image slideshow. Clients without support, Gmail among them, show the first image.
 */
export interface CarouselBlockContent
	extends
		DarkModeOverrides,
		ResponsiveVisibility,
		FullWidthOption,
		CssClassOption,
		ConditionalOption {
	/** The slides, in order. At least one. */
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
 * A bulleted, numbered, checkmark or icon list.
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
 * A horizontal bar filled to a value.
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
