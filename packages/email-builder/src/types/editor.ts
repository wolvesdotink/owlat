import type { EditorBlock, BlockType, SavedBlock } from './blocks';
import type { Variable, VariableType } from './variables';
import type { EmailTheme } from '@owlat/shared';

export type { EmailTheme } from '@owlat/shared';

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
}

/**
 * Image upload result
 */
export interface ImageUploadResult {
	url: string;
	storageId?: string;
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

/**
 * Slash command definition
 */
export interface SlashCommand {
	id: string;
	name: string;
	description: string;
	icon: unknown; // Component type
	category: 'text' | 'media' | 'layout' | 'components' | 'saved';
	aliases?: string[];
	savedBlock?: SavedBlock;
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
