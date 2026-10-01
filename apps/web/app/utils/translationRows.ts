/**
 * The Block rows of the translation table: one row per translatable field
 * (text HTML, button label, image alt text), at any depth of the Block tree.
 *
 * Nested Blocks are reached through the shared Block-tree child contract, the
 * same one the backend uses to seed a language and to merge its overlay, so
 * every Block the table lists is one the merge translates (and the reverse).
 * Each row's label names the path to it ("Column 1 > Text 1").
 */
import { childBlockLists, type BlockTreeNode } from '@owlat/shared/blockTree';

export interface TranslationBlockRow {
	id: string;
	blockId: string;
	fieldType: 'html' | 'buttonText' | 'alt';
	sourceText: string;
	label: string;
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

		const lists = childBlockLists(block);
		if (lists.length === 0) continue;
		const ordinal = (compositeOrdinals.get(block.type) ?? 0) + 1;
		compositeOrdinals.set(block.type, ordinal);
		for (const [listIndex, list] of lists.entries()) {
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
