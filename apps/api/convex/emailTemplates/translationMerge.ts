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
 * to import into the `'use node'` rerender action, and the web app imports it
 * (`@owlat/api/translationMerge`) to render a language exactly as the backend
 * stores it.
 */

import { childBlockLists, mapChildBlockLists } from '@owlat/shared/blockTree';
import { isRecord } from '@owlat/shared/utils/guards';

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

/** Whether a parsed value has the shape of a stored Block: an id, a type and a content object. */
export function isBlockLikeItem(value: unknown): value is BlockLikeItem {
	return (
		isRecord(value) &&
		typeof value['id'] === 'string' &&
		typeof value['type'] === 'string' &&
		isRecord(value['content'])
	);
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

// Extract translatable content from an item and, through the shared Block-tree
// child contract, from every Block nested inside it.
function extractFromItem(
	item: BlockLikeItem,
	translatableContent: Record<string, TranslatableBlockContent>
): void {
	const content: TranslatableBlockContent = {};
	// Only text is carried over: a non-string value in a stored block is not
	// translatable text and must not become an overlay field.
	const text = (key: string): string | undefined => {
		const value = item.content[key];
		return typeof value === 'string' && value !== '' ? value : undefined;
	};

	if (item.type === 'text' && text('html') !== undefined) {
		content.html = text('html');
	} else if (item.type === 'button' && text('text') !== undefined) {
		content.buttonText = text('text');
	} else if (item.type === 'image' && text('alt') !== undefined) {
		content.alt = text('alt');
	}

	// Only add if there's translatable content
	if (Object.keys(content).length > 0) {
		translatableContent[item.id] = content;
	}

	for (const list of childBlockLists(item)) {
		for (const child of list) {
			if (isBlockLikeItem(child)) extractFromItem(child, translatableContent);
		}
	}
}

/**
 * The stored Block list of a block JSON document, or null when the document is
 * not JSON or not a list of Blocks (every entry with an id, a type and a
 * content object).
 */
export function parseBlockList(blocksJson: string): BlockLikeItem[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(blocksJson);
	} catch {
		return null;
	}
	return Array.isArray(parsed) && parsed.every(isBlockLikeItem) ? parsed : null;
}

/**
 * The translatable text of a block JSON document, keyed by block id: the
 * overlay a language would need to render exactly as this content does.
 * Changing the default language stores the outgoing default as this overlay.
 * A document that is not a Block list has no translatable text.
 */
export function extractTranslatableContent(
	blocksJson: string
): Record<string, TranslatableBlockContent> {
	const translatableContent: Record<string, TranslatableBlockContent> = {};
	for (const block of parseBlockList(blocksJson) ?? []) {
		extractFromItem(block, translatableContent);
	}
	return translatableContent;
}
