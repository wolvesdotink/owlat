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
	/**
	 * Text a block holds by position (list items, table headers, cells, footer
	 * and caption, menu labels), keyed by {@link itemTextKey} of the source
	 * text. These entries carry no id of their own, so a key by position would
	 * attach a translation to whatever item moved into that slot. Keyed by the
	 * source text, a translation follows its item through a reorder, and an
	 * item whose source changed has no translation and shows the default text.
	 */
	texts?: Record<string, string>;
	/** Accordion section titles, keyed by section id. */
	sectionTitles?: Record<string, string>;
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

/**
 * The overlay key of a positional source text: a 53-bit hash (cyrb53) in base
 * 36. Keys are scoped to one block, so two different texts of the same block
 * would have to collide for a translation to land on the wrong item.
 */
export function itemTextKey(source: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < source.length; i++) {
		const ch = source.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The part of a block's positional text a translation row names. */
export type ItemTextPart = 'item' | 'header' | 'cell' | 'footer' | 'caption' | 'label';

/** One positional text of a block, in document order. */
export interface ItemTextSlot {
	part: ItemTextPart;
	/** Zero-based position: the item, header or footer cell, or the menu link. */
	index: number;
	/** Zero-based row of a body cell. */
	row?: number;
	text: string;
}

type MapText = (text: string, slot: Omit<ItemTextSlot, 'text'>) => string;

function mapStrings(value: unknown, part: ItemTextPart, fn: MapText, row?: number): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((entry, index) =>
		typeof entry === 'string'
			? fn(entry, { part, index, ...(row !== undefined && { row }) })
			: entry
	);
}

/**
 * A copy of `content` with every positional text passed through `fn`, for the
 * block types that hold text by position. Only fields the content has are
 * written, so an unmerged block renders exactly as before.
 */
function mapItemTexts(type: string, content: Record<string, unknown>, fn: MapText) {
	const next = { ...content };
	if (type === 'list') {
		if ('items' in content) next['items'] = mapStrings(content['items'], 'item', fn);
	} else if (type === 'table') {
		if ('headers' in content) next['headers'] = mapStrings(content['headers'], 'header', fn);
		// The renderer shows the rich cells when there are any and the plain
		// rows otherwise, so only the shown ones are translatable text.
		const hasCells = Array.isArray(content['cells']) && content['cells'].length > 0;
		if (!hasCells && Array.isArray(content['rows'])) {
			next['rows'] = content['rows'].map((row, r) => mapStrings(row, 'cell', fn, r));
		}
		if (hasCells && Array.isArray(content['cells'])) {
			next['cells'] = content['cells'].map((row, r) =>
				Array.isArray(row)
					? row.map((cell, index) =>
							isRecord(cell) && typeof cell['content'] === 'string'
								? { ...cell, content: fn(cell['content'], { part: 'cell', index, row: r }) }
								: cell
						)
					: row
			);
		}
		if ('footerRow' in content) next['footerRow'] = mapStrings(content['footerRow'], 'footer', fn);
		if (typeof content['captionText'] === 'string') {
			next['captionText'] = fn(content['captionText'], { part: 'caption', index: 0 });
		}
	} else if (type === 'menu') {
		if (Array.isArray(content['items'])) {
			next['items'] = content['items'].map((link, index) =>
				isRecord(link) && typeof link['label'] === 'string'
					? { ...link, label: fn(link['label'], { part: 'label', index }) }
					: link
			);
		}
	} else {
		return content;
	}
	return next;
}

/**
 * The positional texts of one block (list items, table text, menu labels), in
 * document order, empty ones left out.
 */
export function itemTextSlots(item: BlockLikeItem): ItemTextSlot[] {
	const slots: ItemTextSlot[] = [];
	mapItemTexts(item.type, item.content, (text, slot) => {
		if (text !== '') slots.push({ ...slot, text });
		return text;
	});
	return slots;
}

function mergeSectionTitles(
	content: Record<string, unknown>,
	titles: Record<string, string>
): Record<string, unknown> {
	if (!Array.isArray(content['sections'])) return content;
	return {
		...content,
		sections: content['sections'].map((section) =>
			isRecord(section) &&
			typeof section['id'] === 'string' &&
			typeof section['title'] === 'string' &&
			hasOwn(titles, section['id'])
				? { ...section, title: titles[section['id']] }
				: section
		),
	};
}

const hasOwn = (record: object, key: string): boolean =>
	Object.prototype.hasOwnProperty.call(record, key);

// Merge the overlay into an item and, through the shared Block-tree child
// contract, into every Block nested inside it (columns, container, hero and
// accordion sections alike).
export function mergeTranslationIntoItem(
	item: BlockLikeItem,
	translationBlocks: Record<string, TranslatableBlockContent>
): BlockLikeItem {
	const translatedContent = hasOwn(translationBlocks, item.id)
		? translationBlocks[item.id]
		: undefined;

	// Create a copy with potentially translated content.
	let content: Record<string, unknown> = {
		...item.content,
		...(translatedContent?.html !== undefined && { html: translatedContent.html }),
		...(translatedContent?.buttonText !== undefined && { text: translatedContent.buttonText }),
		...(translatedContent?.alt !== undefined && { alt: translatedContent.alt }),
	};
	const texts = translatedContent?.texts;
	if (texts) {
		// An empty translation is a cleared cell: the item shows its source
		// text, as an untranslated one does.
		content = mapItemTexts(item.type, content, (text) => {
			const key = itemTextKey(text);
			const translated = text !== '' && hasOwn(texts, key) ? texts[key] : undefined;
			return translated || text;
		});
	}
	if (item.type === 'accordion' && translatedContent?.sectionTitles) {
		content = mergeSectionTitles(content, translatedContent.sectionTitles);
	}
	const merged: BlockLikeItem = { ...item, content };

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

	const slots = itemTextSlots(item);
	if (slots.length > 0) {
		content.texts = {};
		for (const slot of slots) content.texts[itemTextKey(slot.text)] = slot.text;
	}
	if (item.type === 'accordion' && Array.isArray(item.content['sections'])) {
		const titles: Record<string, string> = {};
		for (const section of item.content['sections']) {
			if (
				isRecord(section) &&
				typeof section['id'] === 'string' &&
				typeof section['title'] === 'string' &&
				section['title'] !== ''
			) {
				titles[section['id']] = section['title'];
			}
		}
		if (Object.keys(titles).length > 0) content.sectionTitles = titles;
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

/** Where a positional text sits in its block, independent of its text. */
const slotPosition = (slot: ItemTextSlot): string => `${slot.part}:${slot.row ?? ''}:${slot.index}`;

function collectSlotsById(
	items: readonly unknown[],
	slotsById: Map<string, Map<string, ItemTextSlot>>
): void {
	for (const item of items) {
		if (!isBlockLikeItem(item)) continue;
		if (!slotsById.has(item.id)) {
			slotsById.set(
				item.id,
				new Map(itemTextSlots(item).map((slot) => [slotPosition(slot), slot]))
			);
		}
		for (const list of childBlockLists(item)) collectSlotsById(list, slotsById);
	}
}

/**
 * An overlay's block map re-keyed for new default content. Positional texts
 * are keyed by their source text, so when the default content changes from
 * `previous` to `next` with the same structure (a language promoted to the
 * default), each translation moves from the key of the text that stood in its
 * position to the key of the text standing there now. A translation of a text
 * no longer in the content is dropped. The other fields are keyed by block or
 * section id and are copied as they are.
 */
export function rekeyItemTexts(
	previous: readonly unknown[],
	next: readonly unknown[],
	blocks: Record<string, TranslatableBlockContent>
): Record<string, TranslatableBlockContent> {
	const before = new Map<string, Map<string, ItemTextSlot>>();
	const after = new Map<string, Map<string, ItemTextSlot>>();
	collectSlotsById(previous, before);
	collectSlotsById(next, after);
	const rekeyed: Record<string, TranslatableBlockContent> = {};
	for (const [blockId, entry] of Object.entries(blocks)) {
		const { texts, ...rest } = entry;
		if (!texts) {
			rekeyed[blockId] = { ...rest };
			continue;
		}
		const newSlots = after.get(blockId);
		const moved: Record<string, string> = {};
		// Two source texts the new default writes the same way share one key.
		// When their translations differ, keeping either would show it on the
		// wrong item, so both items become untranslated instead.
		const conflicting = new Set<string>();
		for (const [position, slot] of before.get(blockId) ?? []) {
			const target = newSlots?.get(position);
			const key = itemTextKey(slot.text);
			if (!target || !hasOwn(texts, key)) continue;
			const newKey = itemTextKey(target.text);
			const value = texts[key] as string;
			if (!hasOwn(moved, newKey)) moved[newKey] = value;
			else if (moved[newKey] !== value) conflicting.add(newKey);
		}
		for (const key of conflicting) delete moved[key];
		rekeyed[blockId] = Object.keys(moved).length > 0 ? { ...rest, texts: moved } : { ...rest };
	}
	return rekeyed;
}
