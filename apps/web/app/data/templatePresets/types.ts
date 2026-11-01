import type { BlockType } from '@owlat/shared';

export interface TemplatePreset {
	id: string;
	/**
	 * MESSAGE KEY for the card's title. This catalog is module scope, so it
	 * carries keys, not copy — `TemplateLibraryModal` resolves them with `t()`.
	 *
	 * Only the two lines the PICKER shows are keys. `subject`, the block
	 * `content` and `previewHtml` are the seed EMAIL the operator then edits in
	 * their own language, not interface chrome, and message values carry no HTML.
	 */
	name: string;
	/** MESSAGE KEY for the card's second line. */
	description: string;
	icon: string;
	subject: string;
	content: Array<{ id: string; type: BlockType; content: Record<string, unknown> }>;
	previewHtml: string;
}
