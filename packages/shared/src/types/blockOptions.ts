/**
 * Shared option types for email editor blocks: the block type union and the
 * padding, border, dark-mode, visibility and condition mixins that the block
 * content types extend.
 *
 * Import from `blocks.ts`, which re-exports everything here.
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
	/** Stretch the block's background across the whole window; the content keeps the email's width. */
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
 * Show the block only when a variable matches.
 */
export interface BlockCondition {
	/** The variable's name, without braces. */
	variable: string;
	/** `exists` is true for a variable that is set and not empty. */
	operator: 'equals' | 'notEquals' | 'contains' | 'exists' | 'notExists';
	/** What `equals`, `notEquals` and `contains` compare with. */
	value?: string;
}

/**
 * Render the block once per item of an array variable, such as the lines of an order.
 */
export interface BlockRepeat {
	/** The variable holding the items, as a JSON array. */
	variable: string;
	/** The name each item's fields go by: with `item`, `{{item.name}}` is the item's `name`. */
	itemAlias: string;
	/** Render at most this many items; 500 at most in any case. */
	maxItems?: number;
}

/**
 * Common properties for conditional content
 */
export interface ConditionalOption {
	/** Show the block only when a variable matches. Only top-level blocks honour it. */
	condition?: BlockCondition;
	/** Render the block once per item of an array variable. Only top-level blocks honour it. */
	repeat?: BlockRepeat;
}
