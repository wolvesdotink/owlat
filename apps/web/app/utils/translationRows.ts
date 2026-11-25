/**
 * The Block rows of the translation table: one row per translatable field
 * (text HTML, button label, image alt text, list item, table text, menu label,
 * accordion section title), at any depth of the Block tree.
 *
 * Nested Blocks are reached through the shared Block-tree child contract, the
 * same one the backend uses to seed a language and to merge its overlay, so
 * every Block the table lists is one the merge translates (and the reverse).
 * Each row's label names the path to it ("Column 1 > Text 1").
 */
import { childBlockLists, type BlockTreeNode } from '@owlat/shared/blockTree';
import { isRecord } from '@owlat/shared/utils/guards';
import { itemTextKey, itemTextSlots, type ItemTextSlot } from '@owlat/api/translationMerge';

/** The Block field a row translates. */
export type BlockFieldType = 'html' | 'buttonText' | 'alt' | 'itemText' | 'sectionTitle';

export interface TranslationBlockRow {
	id: string;
	blockId: string;
	fieldType: BlockFieldType;
	sourceText: string;
	label: string;
	/**
	 * For `itemText` the source text's overlay key, for `sectionTitle` the
	 * section id: where the translation sits in the Block's overlay entry.
	 */
	entryKey?: string;
	/**
	 * The Block a row of a list, table or menu belongs to. The table shows the
	 * rows of one Block under one heading, so a long table stays readable.
	 */
	group?: string;
}

/** One row of the translation table: the subject, the preview text or a Block field. */
export interface TranslatableRow {
	id: string;
	fieldType: 'subject' | 'previewText' | BlockFieldType;
	sourceText: string;
	label: string;
	blockId?: string;
	entryKey?: string;
	group?: string;
}

type Translate = (key: string, params: Record<string, unknown>) => string;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The label prefix for one child list of a composite Block. `ordinal` counts
 * composites of the same type among their siblings; `listIndex` is the column
 * or accordion section. The " > " chain is joined by the caller: it is a
 * structural separator, not copy.
 */
function childListPrefix(
	block: BlockTreeNode,
	prefix: string,
	ordinal: number,
	listIndex: number,
	t: Translate
): string {
	switch (block.type) {
		case 'columns':
			return t('components.translation.manager.columnPrefix', { prefix, index: listIndex + 1 });
		case 'hero':
			return t('components.translation.manager.heroPrefix', { prefix, index: ordinal });
		case 'accordion':
			return t('components.translation.manager.accordionSectionPrefix', {
				prefix,
				index: ordinal,
				section: listIndex + 1,
			});
		default:
			return t('components.translation.manager.containerPrefix', { prefix, index: ordinal });
	}
}

/** The label of one positional text inside its Block's group. */
function slotLabel(slot: ItemTextSlot, t: Translate): string {
	switch (slot.part) {
		case 'item':
			return t('components.translation.manager.listItem', { index: slot.index + 1 });
		case 'header':
			return t('components.translation.manager.tableHeader', { index: slot.index + 1 });
		case 'cell':
			return t('components.translation.manager.tableCell', {
				row: (slot.row ?? 0) + 1,
				column: slot.index + 1,
			});
		case 'footer':
			return t('components.translation.manager.tableFooter', { index: slot.index + 1 });
		case 'caption':
			return t('components.translation.manager.tableCaption', {});
		case 'label':
			return t('components.translation.manager.menuLink', { index: slot.index + 1 });
	}
}

const GROUP_KEYS: Readonly<Record<string, string>> = {
	list: 'components.translation.manager.listBlock',
	table: 'components.translation.manager.tableBlock',
	menu: 'components.translation.manager.menuBlock',
};

/**
 * One row per distinct positional text of a list, table or menu. A text that
 * appears in several positions has one translation (the overlay keys it by
 * its source), so it gets one row, labelled by its first position.
 */
function pushItemRows(
	block: BlockTreeNode,
	group: string,
	rows: TranslationBlockRow[],
	t: Translate
): void {
	const slots = itemTextSlots({
		id: block.id,
		type: block.type,
		content: block.content as Record<string, unknown>,
	});
	const byKey = new Map<string, { slot: ItemTextSlot; count: number }>();
	for (const slot of slots) {
		const key = itemTextKey(slot.text);
		const seen = byKey.get(key);
		if (seen) seen.count++;
		else byKey.set(key, { slot, count: 1 });
	}
	for (const [key, { slot, count }] of byKey) {
		const label = slotLabel(slot, t);
		rows.push({
			id: `${block.id}:texts:${key}`,
			blockId: block.id,
			fieldType: 'itemText',
			sourceText: slot.text,
			label:
				count > 1
					? t('components.translation.manager.repeatedText', { label, count: count - 1 })
					: label,
			entryKey: key,
			group,
		});
	}
}

function pushSectionTitle(
	block: BlockTreeNode,
	section: unknown,
	prefix: string,
	ordinal: number,
	listIndex: number,
	rows: TranslationBlockRow[],
	t: Translate
): void {
	if (typeof section !== 'object' || section === null) return;
	const { id: sectionId, title } = section as Record<string, unknown>;
	if (typeof sectionId !== 'string' || !text(title)) return;
	rows.push({
		id: `${block.id}:sectionTitles:${sectionId}`,
		blockId: block.id,
		fieldType: 'sectionTitle',
		sourceText: text(title),
		label: t('components.translation.manager.accordionSectionTitle', {
			prefix,
			index: ordinal,
			section: listIndex + 1,
		}),
		entryKey: sectionId,
	});
}

/** Append the rows for `blocks` and everything nested in them to `rows`. */
function collectRows(
	blocks: readonly BlockTreeNode[],
	rows: TranslationBlockRow[],
	prefix: string,
	t: Translate
): void {
	let textIndex = 0;
	let imageIndex = 0;
	const compositeOrdinals = new Map<string, number>();
	const itemBlockOrdinals = new Map<string, number>();

	for (const block of blocks) {
		const content = block.content as Record<string, unknown>;
		if (block.type === 'text' && text(content['html'])) {
			textIndex++;
			rows.push({
				id: block.id,
				blockId: block.id,
				fieldType: 'html',
				sourceText: text(content['html']),
				label: t('components.translation.manager.textBlock', { prefix, index: textIndex }),
			});
		} else if (block.type === 'button' && text(content['text'])) {
			rows.push({
				id: block.id,
				blockId: block.id,
				fieldType: 'buttonText',
				sourceText: text(content['text']),
				label: t('components.translation.manager.buttonBlock', {
					prefix,
					text: text(content['text']),
				}),
			});
		} else if (block.type === 'image' && text(content['alt'])) {
			imageIndex++;
			rows.push({
				id: block.id,
				blockId: block.id,
				fieldType: 'alt',
				sourceText: text(content['alt']),
				label: t('components.translation.manager.imageBlock', { prefix, index: imageIndex }),
			});
		}

		const groupKey = GROUP_KEYS[block.type];
		if (groupKey) {
			const ordinal = (itemBlockOrdinals.get(block.type) ?? 0) + 1;
			itemBlockOrdinals.set(block.type, ordinal);
			pushItemRows(block, t(groupKey, { prefix, index: ordinal }), rows, t);
		}

		const lists = childBlockLists(block);
		if (lists.length === 0) continue;
		const ordinal = (compositeOrdinals.get(block.type) ?? 0) + 1;
		compositeOrdinals.set(block.type, ordinal);
		const sections = block.type === 'accordion' ? content['sections'] : undefined;
		for (const [listIndex, list] of lists.entries()) {
			// An accordion's child lists are its sections, in order: each
			// section's title comes before the Blocks inside it.
			if (Array.isArray(sections))
				pushSectionTitle(block, sections[listIndex], prefix, ordinal, listIndex, rows, t);
			collectRows(list, rows, `${childListPrefix(block, prefix, ordinal, listIndex, t)} > `, t);
		}
	}
}

/** The translation-table rows for an email's Blocks, in document order. */
export function translationBlockRows(
	blocks: readonly BlockTreeNode[],
	t: Translate
): TranslationBlockRow[] {
	const rows: TranslationBlockRow[] = [];
	collectRows(blocks, rows, '', t);
	return rows;
}

/**
 * How many of `rows` hold a translation in one language: a row counts once
 * its cell has text. Every row the table lists is required; link and image
 * addresses are not rows, so they never count as missing.
 */
export function translationProgress(
	rows: readonly TranslatableRow[],
	valueOf: (row: TranslatableRow) => string
): { done: number; total: number } {
	let done = 0;
	for (const row of rows) if (valueOf(row) !== '') done++;
	return { done, total: rows.length };
}

/** Content the translation table does not offer, which every language shares. */
export type SharedContentKind = 'links' | 'images' | 'rawHtml' | 'video' | 'carousel';

const SHARED_KIND_ORDER: readonly SharedContentKind[] = [
	'links',
	'images',
	'rawHtml',
	'video',
	'carousel',
];

function collectSharedKinds(blocks: readonly BlockTreeNode[], found: Set<SharedContentKind>) {
	for (const block of blocks) {
		const content = block.content as Record<string, unknown>;
		switch (block.type) {
			case 'button':
				if (text(content['url'])) found.add('links');
				break;
			case 'image':
				if (text(content['src'])) found.add('images');
				if (text(content['linkUrl'])) found.add('links');
				break;
			case 'hero':
				if (text(content['backgroundImage'])) found.add('images');
				break;
			case 'menu':
				if (
					Array.isArray(content['items']) &&
					content['items'].some((link) => isRecord(link) && text(link['url']))
				) {
					found.add('links');
				}
				break;
			case 'rawHtml':
				if (text(content['html'])) found.add('rawHtml');
				break;
			case 'video':
				found.add('video');
				break;
			case 'carousel':
				found.add('carousel');
				break;
		}
		for (const list of childBlockLists(block)) collectSharedKinds(list, found);
	}
}

/**
 * The kinds of content in `blocks` that the translation table cannot
 * translate, so the screen can say they stay the same in every language.
 */
export function sharedContentKinds(blocks: readonly BlockTreeNode[]): SharedContentKind[] {
	const found = new Set<SharedContentKind>();
	collectSharedKinds(blocks, found);
	return SHARED_KIND_ORDER.filter((kind) => found.has(kind));
}
