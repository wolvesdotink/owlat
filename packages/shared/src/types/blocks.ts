/**
 * Block types for the email editor
 */

export type BlockType =
	| 'text'
	| 'image'
	| 'button'
	| 'divider'
	| 'spacer'
	| 'columns'
	| 'social'
	| 'container'
	| 'hero'
	| 'table'
	| 'rawHtml'
	| 'video'
	| 'accordion'
	| 'menu'
	| 'carousel'
	| 'list'
	| 'progressBar';

/**
 * Universal padding interface for all blocks
 */
export interface UniversalPadding {
	paddingTop: number;
	paddingRight: number;
	paddingBottom: number;
	paddingLeft: number;
	paddingLinked: boolean;
}

/**
 * Universal margin interface for all blocks
 */
export interface UniversalMargin {
	marginTop: number;
	marginRight: number;
	marginBottom: number;
	marginLeft: number;
}

/**
 * Border style options
 */
export type BorderStyle = 'solid' | 'dashed' | 'dotted' | 'none';

/**
 * Universal border interface for all blocks
 */
export interface UniversalBorder {
	borderWidth: number;
	borderColor: string;
	borderStyle: BorderStyle;
}

/**
 * Text block type - either paragraph or heading
 */
export type TextBlockType = 'paragraph' | 'h1' | 'h2' | 'h3';

/**
 * Gradient background definition for buttons, containers, and hero blocks.
 * Renders as CSS linear-gradient with solid backgroundColor fallback.
 * Uses VML gradient fill (<v:fill type="gradient">) for Outlook.
 */
export interface GradientBackground {
	/** CSS gradient direction (e.g. 'to right', '135deg', 'to bottom right') */
	direction: string;
	/** Color stops */
	stops: Array<{ color: string; position: number }>;
}

/**
 * Common properties shared by all block content types for dark mode overrides
 */
export interface DarkModeOverrides {
	/** Background color override in dark mode */
	darkBackgroundColor?: string;
	/** Text color override in dark mode */
	darkTextColor?: string;
}

/**
 * Common properties for responsive visibility
 */
export interface ResponsiveVisibility {
	/** Hide this block on mobile viewports */
	hideOnMobile?: boolean;
	/** Hide this block on desktop viewports */
	hideOnDesktop?: boolean;
}

/**
 * Common properties for full-width sections
 */
export interface FullWidthOption {
	/** When true, section spans full viewport width with inner content at baseWidth */
	fullWidth?: boolean;
}

/**
 * Common properties for CSS class injection
 */
export interface CssClassOption {
	/** Custom CSS class name(s) to apply to the block wrapper */
	cssClass?: string;
}

/**
 * Condition for showing/hiding blocks based on variable values
 */
export interface BlockCondition {
	variable: string;
	operator: 'equals' | 'notEquals' | 'contains' | 'exists' | 'notExists';
	value?: string;
}

/**
 * Repeat configuration for iterating over array variables.
 * Used for e-commerce emails (order items, product lists, recommendations).
 */
export interface BlockRepeat {
	/** Array variable name in variableValues (expects JSON-encoded array) */
	variable: string;
	/** Alias used to reference each item in variable interpolation (e.g. "item") */
	itemAlias: string;
	/** Maximum number of iterations (default: unlimited) */
	maxItems?: number;
}

/**
 * Common properties for conditional content
 */
export interface ConditionalOption {
	/** Condition to evaluate for showing/hiding this block */
	condition?: BlockCondition;
	/** Repeat this block for each item in an array variable */
	repeat?: BlockRepeat;
}

/**
 * Text block content
 */
export interface TextBlockContent extends DarkModeOverrides, ResponsiveVisibility, FullWidthOption, CssClassOption, ConditionalOption {
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
export interface ImageBlockContent extends DarkModeOverrides, ResponsiveVisibility, FullWidthOption, CssClassOption, ConditionalOption {
	src: string;
	alt: string;
	width: number;
	align: 'left' | 'center' | 'right';
	storageId?: string;
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
export interface ButtonBlockContent extends DarkModeOverrides, ResponsiveVisibility, FullWidthOption, CssClassOption, ConditionalOption {
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
export interface DividerBlockContent extends DarkModeOverrides, ResponsiveVisibility, FullWidthOption, CssClassOption, ConditionalOption {
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
export interface SpacerBlockContent extends DarkModeOverrides, ResponsiveVisibility, CssClassOption, ConditionalOption {
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
export interface ColumnsBlockContent extends DarkModeOverrides, ResponsiveVisibility, FullWidthOption, CssClassOption, ConditionalOption {
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

/**
 * Container item types - blocks that can be nested inside containers
 */
export type ContainerItemType =
	| 'text'
	| 'image'
	| 'button'
	| 'divider'
	| 'spacer'
	| 'columns'
	| 'social'
	| 'container';

/**
 * Container item content - all content types that can be nested in containers
 * Note: ContainerBlockContent is forward-referenced for recursive nesting
 */
export type ContainerItemContent =
	| TextBlockContent
	| ImageBlockContent
	| ButtonBlockContent
	| DividerBlockContent
	| SpacerBlockContent
	| ColumnsBlockContent
	| SocialBlockContent
	| ContainerBlockContent;

/**
 * A container item is a block nested inside a container
 */
export interface ContainerItem {
	id: string;
	type: ContainerItemType;
	content: ContainerItemContent;
}

/**
 * Container block content - groups multiple blocks with shared styling
 */
export interface ContainerBlockContent extends DarkModeOverrides, ResponsiveVisibility, FullWidthOption, CssClassOption, ConditionalOption {
	items: ContainerItem[];
	maxWidth: number;
	paddingTop: number;
	paddingRight: number;
	paddingBottom: number;
	paddingLeft: number;
	paddingLinked: boolean;
	marginTop: number;
	marginRight: number;
	marginBottom: number;
	marginLeft: number;
	backgroundColor?: string;
	borderWidth: number;
	borderColor: string;
	borderStyle: BorderStyle;
	borderRadius: number;
	/** Background image URL for hero-like sections */
	backgroundImage?: string;
	/** Background image position */
	backgroundPosition?: 'top' | 'center' | 'bottom';
	/** Background image size */
	backgroundSize?: 'cover' | 'contain';
	/** Gradient background (CSS linear-gradient with VML fallback) */
	backgroundGradient?: GradientBackground;
}

/**
 * Social link types
 */
export type SocialPlatform =
	| 'twitter'
	| 'facebook'
	| 'instagram'
	| 'linkedin'
	| 'youtube'
	| 'tiktok'
	| 'github'
	| 'whatsapp'
	| 'telegram'
	| 'threads'
	| 'pinterest'
	| 'discord'
	| 'mastodon'
	| 'bluesky'
	| 'vimeo'
	| 'medium'
	| 'snapchat';

/**
 * Exhaustive metadata for every {@link SocialPlatform}.
 *
 * Keying this `Record` on the `SocialPlatform` union makes a newly-added
 * platform a compile error here (and on every surface that derives its labels
 * from this map), so display names can never silently fall out of sync.
 *
 * - `label` — the canonical display/rendering name (e.g. Twitter renders as 'X').
 * - `editorLabel` — optional override for the block-editor platform picker
 *   (e.g. Twitter shows 'Twitter / X' so authors recognise the legacy name).
 */
export const SOCIAL_PLATFORMS: Record<SocialPlatform, { label: string; editorLabel?: string }> = {
	twitter: { label: 'X', editorLabel: 'Twitter / X' },
	facebook: { label: 'Facebook' },
	instagram: { label: 'Instagram' },
	linkedin: { label: 'LinkedIn' },
	youtube: { label: 'YouTube' },
	tiktok: { label: 'TikTok' },
	github: { label: 'GitHub' },
	whatsapp: { label: 'WhatsApp' },
	telegram: { label: 'Telegram' },
	threads: { label: 'Threads' },
	pinterest: { label: 'Pinterest' },
	discord: { label: 'Discord' },
	mastodon: { label: 'Mastodon' },
	bluesky: { label: 'Bluesky' },
	vimeo: { label: 'Vimeo' },
	medium: { label: 'Medium' },
	snapchat: { label: 'Snapchat' },
};

/**
 * Social link
 */
export interface SocialLink {
	platform: SocialPlatform;
	url: string;
	enabled: boolean;
	/** Custom icon URL */
	iconUrl?: string;
}

/**
 * Social block content
 */
export interface SocialBlockContent extends DarkModeOverrides, ResponsiveVisibility, FullWidthOption, CssClassOption, ConditionalOption {
	links: SocialLink[];
	iconStyle: 'filled' | 'outline';
	align: 'left' | 'center' | 'right';
	iconSize: number;
	iconSpacing: number;
	iconColor: string;
	/** Layout mode: horizontal or vertical */
	mode?: 'horizontal' | 'vertical';
	/** Show platform name text labels */
	showLabels?: boolean;
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
 * Hero block content - full-width background image with overlaid text + CTA
 */
export interface HeroBlockContent extends DarkModeOverrides, ResponsiveVisibility, FullWidthOption, CssClassOption, ConditionalOption {
	backgroundImage: string;
	backgroundPosition: 'top' | 'center' | 'bottom';
	backgroundSize: 'cover' | 'contain';
	height: number;
	mode: 'fixed-height' | 'fluid-height';
	verticalAlign: 'top' | 'middle' | 'bottom';
	overlayColor?: string;
	backgroundColor?: string;
	/** Gradient background (CSS linear-gradient with VML fallback) */
	backgroundGradient?: GradientBackground;
	items: ContainerItem[];
	paddingTop?: number;
	paddingRight?: number;
	paddingBottom?: number;
	paddingLeft?: number;
	paddingLinked?: boolean;
	marginTop?: number;
	marginRight?: number;
	marginBottom?: number;
	marginLeft?: number;
	borderRadius?: number;
	borderWidth?: number;
	borderColor?: string;
	borderStyle?: BorderStyle;
}

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
export interface TableBlockContent extends DarkModeOverrides, ResponsiveVisibility, FullWidthOption, CssClassOption, ConditionalOption {
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
export interface RawHtmlBlockContent extends ResponsiveVisibility, CssClassOption, ConditionalOption {
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
export interface VideoBlockContent extends DarkModeOverrides, ResponsiveVisibility, FullWidthOption, CssClassOption, ConditionalOption {
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
export interface AccordionBlockContent extends DarkModeOverrides, ResponsiveVisibility, FullWidthOption, CssClassOption, ConditionalOption {
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
export interface MenuBlockContent extends DarkModeOverrides, ResponsiveVisibility, FullWidthOption, CssClassOption, ConditionalOption {
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
export interface CarouselBlockContent extends DarkModeOverrides, ResponsiveVisibility, FullWidthOption, CssClassOption, ConditionalOption {
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
export interface ListBlockContent extends DarkModeOverrides, ResponsiveVisibility, FullWidthOption, CssClassOption, ConditionalOption {
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
export interface ProgressBarBlockContent extends DarkModeOverrides, ResponsiveVisibility, FullWidthOption, CssClassOption, ConditionalOption {
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

/**
 * Block content union type
 */
export type BlockContent =
	| TextBlockContent
	| ImageBlockContent
	| ButtonBlockContent
	| DividerBlockContent
	| SpacerBlockContent
	| ColumnsBlockContent
	| SocialBlockContent
	| ContainerBlockContent
	| HeroBlockContent
	| TableBlockContent
	| RawHtmlBlockContent
	| VideoBlockContent
	| AccordionBlockContent
	| MenuBlockContent
	| CarouselBlockContent
	| ListBlockContent
	| ProgressBarBlockContent;

/**
 * Maps each BlockType to its corresponding content type.
 * Used to create the discriminated union EditorBlock.
 */
export interface BlockTypeContentMap {
	text: TextBlockContent;
	image: ImageBlockContent;
	button: ButtonBlockContent;
	divider: DividerBlockContent;
	spacer: SpacerBlockContent;
	columns: ColumnsBlockContent;
	social: SocialBlockContent;
	container: ContainerBlockContent;
	hero: HeroBlockContent;
	table: TableBlockContent;
	rawHtml: RawHtmlBlockContent;
	video: VideoBlockContent;
	accordion: AccordionBlockContent;
	menu: MenuBlockContent;
	carousel: CarouselBlockContent;
	list: ListBlockContent;
	progressBar: ProgressBarBlockContent;
}

/**
 * Common properties shared across all block content types.
 * Used in helper functions that access padding/margin/border/background
 * without needing to know the specific block type.
 */
export interface CommonBlockProperties {
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
	blockBackgroundColor?: string;
	borderRadius?: number;
	borderWidth?: number;
	borderColor?: string;
	borderStyle?: BorderStyle;
	darkBackgroundColor?: string;
	darkTextColor?: string;
	hideOnMobile?: boolean;
	hideOnDesktop?: boolean;
	cssClass?: string;
	fullWidth?: boolean;
	condition?: BlockCondition;
	repeat?: BlockRepeat;
	backgroundGradient?: GradientBackground;
}

/**
 * Reference to a saved block for linked block functionality
 */
export interface SavedBlockRef {
	blockId: string; // _id of the saved block
	groupId: string; // Groups blocks from the same insertion
	blockName: string; // Denormalized name for UI display
}

/**
 * Editor block — discriminated union linking type to content.
 * TypeScript narrows `content` when you switch on `type`.
 */
export type EditorBlock = {
	[K in BlockType]: {
		id: string;
		type: K;
		content: BlockTypeContentMap[K];
		savedBlockRef?: SavedBlockRef;
	};
}[BlockType];

/**
 * Type guard to narrow an EditorBlock to a specific block type.
 */
export function isBlockType<T extends BlockType>(
	block: EditorBlock,
	type: T,
): block is EditorBlock & { type: T; content: BlockTypeContentMap[T] } {
	return block.type === type;
}

/**
 * Saved block for reuse
 */
export interface SavedBlock {
	_id: string;
	name: string;
	description?: string;
	/** JSON string containing block content */
	content: string;
	usageCount: number;
	blockCount?: number;
}
