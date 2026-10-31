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
