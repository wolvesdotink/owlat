/**
 * Per-language translation overlay — shared by the i18n Convex module
 * (`emailTemplates/i18n.ts`, save-time merge via `mergeTranslationWithContent`)
 * and the saved-block rerender action (`emailBlocks/rendering.ts`, render-time
 * merge for each supported language).
 *
 * A translation stores only translatable *text* keyed by block id, not a full
 * block array. Overlaying a non-default language means taking the default
 * content's block structure/styling and replacing the translatable fields.
 *
 * This module is a pure TS helper with no Convex-runtime imports, so it is safe
 * to import into the `'use node'` rerender action.
 */

import { mapChildBlockLists } from '@owlat/shared/blockTree';

export interface TranslatableBlockContent {
	html?: string; // for text blocks
	buttonText?: string; // for button blocks
	alt?: string; // for image blocks
}

export interface BlockLikeItem {
	id: string;
	type: string;
	content: Record<string, unknown>;
}

// Merge the overlay into an item and, through the shared Block-tree child
// contract, into every Block nested inside it (columns, container, hero and
// accordion sections alike).
export function mergeTranslationIntoItem(
	item: BlockLikeItem,
	translationBlocks: Record<string, TranslatableBlockContent>
): BlockLikeItem {
	const translatedContent = translationBlocks[item.id];

	// Create a copy with potentially translated content.
	const merged: BlockLikeItem = {
		...item,
		content: {
			...item.content,
			...(translatedContent?.html !== undefined && { html: translatedContent.html }),
			...(translatedContent?.buttonText !== undefined && { text: translatedContent.buttonText }),
			...(translatedContent?.alt !== undefined && { alt: translatedContent.alt }),
		},
	};

	return mapChildBlockLists(merged, (list) =>
		list.map((child) => mergeTranslationIntoItem(child, translationBlocks))
	);
}
