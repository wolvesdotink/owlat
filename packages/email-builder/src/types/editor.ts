import type { EditorBlock, BlockType, SavedBlock } from './blocks';
import type { Variable, VariableType } from './variables';
import type { EmailTheme } from '@owlat/shared';
import type { BrandKitDesign } from '@owlat/shared/brandKit';
import type { BrandLogos } from '@owlat/shared/brandKitBlocks';

export type { EmailTheme } from '@owlat/shared';

/**
 * The organization's brand kit, as the editor uses it: its colours lead every
 * colour picker, its logo and footer can be inserted as Blocks, and "Apply
 * brand kit" restyles the email with it. Pass `theme` from the same kit so new
 * Blocks start in its styles.
 */
export interface EmailBuilderBrand {
	design: BrandKitDesign;
	logos: BrandLogos;
}

/**
 * Email builder mode
 */
export type EmailBuilderMode = 'email' | 'block';

/**
 * Email builder configuration
 */
export interface EmailBuilderConfig {
	/** Variable type for variable insertion */
	variableType?: VariableType;
	/** Block types available in sidebar. Default: all */
	blockTypes?: BlockType[];
	/** Email theme for styling */
	theme?: EmailTheme;
	/**
	 * Show a required, non-editable unsubscribe footer in the builder and preview output.
	 * Use this for marketing emails where unsubscribe links are mandatory.
	 */
	showMandatoryUnsubscribeFooter?: boolean;
	/** Hide the subject field (default: true). Set to false to show subject field in editor header. */
	hideSubject?: boolean;
	/** Editor mode: 'email' for full email templates, 'block' for saved blocks */
	mode?: EmailBuilderMode;
	/**
	 * Show the settings gear button in the editor header (default: false).
	 * Only enable this when the host binds @settings and renders a settings target;
	 * otherwise the button is a dead control.
	 */
	showSettings?: boolean;
	/** The brand kit. Without it the editor offers no brand swatches, Blocks or restyle. */
	brand?: EmailBuilderBrand;
}

/**
 * Image upload result
 */
export interface ImageUploadResult {
	url: string;
	/** Durable blob identity; capability URLs are display-only and may expire. */
	storageId: string;
	/** Durable media-library provenance paired with storageId. */
	mediaAssetId: string;
}

/**
 * Handlers for backend integration
 */
export interface EmailBuilderHandlers {
	/** Upload image and return URL */
	uploadImage: (file: File) => Promise<ImageUploadResult>;
	/** Pick an image from the media library (optional). Calls onSelect with the result. */
	pickFromMediaLibrary?: (onSelect: (result: ImageUploadResult) => void) => void;
	/** Saved blocks integration (optional) */
	savedBlocks?: {
		fetch: (params?: { search?: string }) => Promise<SavedBlock[]>;
		/**
		 * Persist a block as a saved block. Resolve only once it is stored; reject
		 * on any failure (after surfacing it to the user) so the builder keeps its
		 * save dialog open with the entered name.
		 */
		save: (block: { name: string; content: EditorBlock[] }) => Promise<void>;
	};
	/** Error callback for surfacing upload failures and other errors to the host app (optional) */
	onError?: (message: string) => void;
}

/**
 * Email builder component props
 */
export interface EmailBuilderProps {
	/** Editor blocks (v-model:blocks) */
	blocks: EditorBlock[];
	/** Email subject (v-model:subject) */
	subject: string;
	/** Email/template name (v-model:name) */
	name: string;
	/** Email body background color (v-model:backgroundColor) */
	backgroundColor?: string;
	/** Available variables for personalization */
	variables: Variable[];
	/** Configuration options */
	config?: EmailBuilderConfig;
	/** Whether save is in progress */
	isSaving?: boolean;
}

/**
 * Another person's presence on one root block, drawn as a coloured outline
 * with a name label (co-editing, docs/adr/0071-email-coediting.md). The host
 * resolves names and builds the label text.
 */
export interface RemoteBlockMark {
	/** Shown on the block, e.g. "Alex" or "Alex is editing". */
	label: string;
	/** Outline and label colour (any CSS colour). */
	color: string;
	/** Someone else holds the block: it cannot be selected or edited here. */
	isLocked: boolean;
}

/** What this editor is focused on, for the host's presence and edit leases. */
export interface BuilderCollabFocus {
	/** Root of the current selection, or null. */
	selectedRootId: string | null;
	/** Root of the block open in the inline text editor, or null. */
	inlineEditRootId: string | null;
}

/**
 * Email builder emits
 */
export interface EmailBuilderEmits {
	(e: 'update:blocks', value: EditorBlock[]): void;
	(e: 'update:subject', value: string): void;
	(e: 'update:name', value: string): void;
	(e: 'update:backgroundColor', value: string): void;
	(e: 'save'): void;
	(e: 'back'): void;
	(e: 'create-variable', variable: { key: string; type?: string }): void;
}

/**
 * Preview device types
 */
export type PreviewDevice = 'desktop' | 'tablet' | 'mobile';

/**
 * Preview mode types
 */
export type PreviewMode = 'edit' | 'preview' | 'code';

/** The brand kit Blocks the editor can insert. */
export type BrandBlockKind = 'logo' | 'footer';

/**
 * Slash command definition
 */
export interface SlashCommand {
	id: string;
	name: string;
	description: string;
	icon: unknown; // Component type
	category: 'text' | 'media' | 'layout' | 'components' | 'brand' | 'saved';
	aliases?: string[];
	savedBlock?: SavedBlock;
	/** Inserts the brand kit's logo or footer Blocks. */
	brandBlock?: BrandBlockKind;
}

/**
 * Slash menu state
 */
export interface SlashMenuState {
	isOpen: boolean;
	position: { top: number; left: number };
	query: string;
	selectedIndex: number;
}
