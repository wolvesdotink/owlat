/**
 * Shared block style type definitions
 * Used across block control components to reduce duplication
 */

/**
 * Block padding interface
 * All values are in pixels
 */
export interface BlockPadding {
	paddingTop: number;
	paddingRight: number;
	paddingBottom: number;
	paddingLeft: number;
	paddingLinked: boolean;
}

/**
 * Block margin interface
 * All values are in pixels
 */
export interface BlockMargin {
	marginTop: number;
	marginRight: number;
	marginBottom: number;
	marginLeft: number;
}

/**
 * Block border interface
 */
export interface BlockBorder {
	borderWidth: number;
	borderColor: string;
	borderStyle: BlockBorderStyle;
}

/**
 * Border style options
 */
export type BlockBorderStyle = 'solid' | 'dashed' | 'dotted' | 'none';
