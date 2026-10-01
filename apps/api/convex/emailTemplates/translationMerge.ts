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

// Recursive helper to merge translation into any block-like item.
export function mergeTranslationIntoItem(
	item: BlockLikeItem,
	translationBlocks: Record<string, TranslatableBlockContent>
): BlockLikeItem {
	const translatedContent = translationBlocks[item.id];

	// Create a copy with potentially translated content.
	const mergedContent: Record<string, unknown> = {
		...item.content,
		...(translatedContent?.html !== undefined && { html: translatedContent.html }),
		...(translatedContent?.buttonText !== undefined && { text: translatedContent.buttonText }),
		...(translatedContent?.alt !== undefined && { alt: translatedContent.alt }),
	};

	// Recursively handle columns.
	if (item.type === 'columns' && Array.isArray(item.content['columns'])) {
		mergedContent['columns'] = (item.content['columns'] as BlockLikeItem[][]).map((column) =>
			column.map((columnItem) => mergeTranslationIntoItem(columnItem, translationBlocks))
		);
	}

	// Recursively handle containers.
	if (item.type === 'container' && Array.isArray(item.content['items'])) {
		mergedContent['items'] = (item.content['items'] as BlockLikeItem[]).map((containerItem) =>
			mergeTranslationIntoItem(containerItem, translationBlocks)
		);
	}

	return { ...item, content: mergedContent };
}

// Recursive helper to extract translatable content from any block-like item.
function extractFromItem(
	item: BlockLikeItem,
	translatableContent: Record<string, TranslatableBlockContent>
): void {
	const content: TranslatableBlockContent = {};

	if (item.type === 'text' && item.content['html']) {
		content.html = item.content['html'] as string;
	} else if (item.type === 'button' && item.content['text']) {
		content.buttonText = item.content['text'] as string;
	} else if (item.type === 'image' && item.content['alt']) {
		content.alt = item.content['alt'] as string;
	} else if (item.type === 'columns' && Array.isArray(item.content['columns'])) {
		// Recursively extract from column items
		for (const column of item.content['columns'] as BlockLikeItem[][]) {
			for (const columnItem of column) {
				extractFromItem(columnItem, translatableContent);
			}
		}
	} else if (item.type === 'container' && Array.isArray(item.content['items'])) {
		// Recursively extract from container items
		for (const containerItem of item.content['items'] as BlockLikeItem[]) {
			extractFromItem(containerItem, translatableContent);
		}
	}

	// Only add if there's translatable content
	if (Object.keys(content).length > 0) {
		translatableContent[item.id] = content;
	}
}

/**
 * The translatable text of a block JSON document, keyed by block id: the
 * overlay a language would need to render exactly as this content does.
 * Changing the default language stores the outgoing default as this overlay.
 */
export function extractTranslatableContent(
	blocksJson: string
): Record<string, TranslatableBlockContent> {
	try {
		const blocks = JSON.parse(blocksJson) as BlockLikeItem[];
		const translatableContent: Record<string, TranslatableBlockContent> = {};

		for (const block of blocks) {
			extractFromItem(block, translatableContent);
		}

		return translatableContent;
	} catch {
		return {};
	}
}
