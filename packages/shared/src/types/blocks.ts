/**
 * Block types for the email editor
 *
 * The stored `EditorBlock[]` contract. The option mixins and the per-block
 * content types live in the sibling modules re-exported below; this module
 * assembles them into the `EditorBlock` union.
 */

import type {
	BlockCondition,
	BlockRepeat,
	BlockType,
	BorderStyle,
	GradientBackground,
} from './blockOptions';
import type {
	ButtonBlockContent,
	ColumnsBlockContent,
	DividerBlockContent,
	ImageBlockContent,
	SpacerBlockContent,
	TextBlockContent,
} from './blockContentBasic';
import type {
	ContainerBlockContent,
	HeroBlockContent,
	SocialBlockContent,
} from './blockContentNested';
import type {
	AccordionBlockContent,
	CarouselBlockContent,
	ListBlockContent,
	MenuBlockContent,
	ProgressBarBlockContent,
	RawHtmlBlockContent,
	TableBlockContent,
	VideoBlockContent,
} from './blockContentExtended';

export type {
	BlockCondition,
	BlockRepeat,
	BlockType,
	BorderStyle,
	ConditionalOption,
	CssClassOption,
	DarkModeOverrides,
	FullWidthOption,
	GradientBackground,
	ResponsiveVisibility,
	TextBlockType,
	UniversalBorder,
	UniversalMargin,
	UniversalPadding,
} from './blockOptions';
export type {
	ButtonBlockContent,
	ColumnItem,
	ColumnCount,
	ColumnRatio,
	ColumnStyle,
	ColumnsBlockContent,
	DividerBlockContent,
	ImageBlockContent,
	SpacerBlockContent,
	TextBlockContent,
} from './blockContentBasic';
export type {
	ContainerBlockContent,
	ContainerItem,
	ContainerItemContent,
	ContainerItemType,
	HeroBlockContent,
	SocialBlockContent,
	SocialLink,
	SocialPlatform,
} from './blockContentNested';
export { SOCIAL_PLATFORMS } from './blockContentNested';
export type {
	AccordionBlockContent,
	AccordionSection,
	CarouselBlockContent,
	CarouselImage,
	ListBlockContent,
	MenuBlockContent,
	MenuLink,
	ProgressBarBlockContent,
	RawHtmlBlockContent,
	TableBlockContent,
	TableCell,
	TableColumn,
	TableResponsiveMode,
	VideoBlockContent,
} from './blockContentExtended';

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
	/** Space inside the block's border, in px. */
	paddingTop?: number;
	/** Space inside the block's border, in px. */
	paddingRight?: number;
	/** Space inside the block's border, in px. */
	paddingBottom?: number;
	/** Space inside the block's border, in px. */
	paddingLeft?: number;
	/** Editor state: whether the four paddings are edited as one. The render ignores it. */
	paddingLinked?: boolean;
	/** Space outside the block, in px. */
	marginTop?: number;
	/** Space outside the block, in px. */
	marginRight?: number;
	/** Space outside the block, in px. */
	marginBottom?: number;
	/** Space outside the block, in px. */
	marginLeft?: number;
	/** Background of the block (CSS color). */
	backgroundColor?: string;
	/** Background of the section around a button (CSS color). */
	blockBackgroundColor?: string;
	/** Corner radius in px. */
	borderRadius?: number;
	/** Border width in px. */
	borderWidth?: number;
	/** Border color (CSS color). */
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
