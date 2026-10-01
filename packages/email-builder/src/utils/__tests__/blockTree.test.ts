// Resolving a Block at any depth of the canvas tree, and copying a Block with
// fresh ids for every descendant.
import { describe, it, expect } from 'vitest';
import { childBlockLists } from '@owlat/shared/blockTree';
import { cloneWithFreshIds, locateBlock, locateWithin, replaceBlockInTree } from '../blockTree';
import type { EditorBlock } from '../../types';

const text = (id: string, html = id): EditorBlock =>
	({ id, type: 'text', content: { html } }) as unknown as EditorBlock;
const node = (id: string, type: string, content: Record<string, unknown>): EditorBlock =>
	({ id, type, content }) as unknown as EditorBlock;

/** root → container → container → text, and root → container → columns → text. */
const document = (): EditorBlock[] => [
	text('intro'),
	node('outer', 'container', {
		items: [
			node('inner', 'container', { items: [text('deep')] }),
			node('cols', 'columns', { columns: [[text('left')], [text('right')]] }),
		],
	}),
	node('hero', 'hero', { items: [text('hero-text')] }),
];

/** Every id in the document, at every depth. */
const documentIds = (blocks: readonly EditorBlock[]): string[] =>
	blocks.flatMap((b) => [b.id, ...documentIds(childBlockLists(b).flat())]);

describe('locateBlock', () => {
	it('finds a root Block', () => {
		const location = locateBlock(document(), 'intro')!;
		expect(location.parent).toBeNull();
		expect(location.rootIndex).toBe(0);
		expect(location.block.id).toBe('intro');
	});

	it('finds items two and three levels down with their owner and parent', () => {
		const blocks = document();
		const deep = locateBlock(blocks, 'deep')!;
		expect(deep.root.id).toBe('outer');
		expect(deep.parent!.id).toBe('inner');
		expect(deep.list).toBe(
			(blocks[1]!.content as { items: { content: { items: unknown[] } }[] }).items[0]!.content.items
		);

		const right = locateBlock(blocks, 'right')!;
		expect(right.root.id).toBe('outer');
		expect(right.parent!.id).toBe('cols');
		expect(right.listIndex).toBe(1);

		expect(locateBlock(blocks, 'hero-text')!.parent!.id).toBe('hero');
	});

	it('returns null for an unknown id', () => {
		expect(locateBlock(document(), 'ghost')).toBeNull();
	});

	it('prefers the given root when an older document repeats a child id', () => {
		const blocks = [
			node('a', 'columns', { columns: [[text('same', 'first')]] }),
			node('b', 'columns', { columns: [[text('same', 'second')]] }),
		];
		expect(locateBlock(blocks, 'same')!.root.id).toBe('a');
		expect(locateBlock(blocks, 'same', 'b')!.root.id).toBe('b');
	});
});

describe('locateWithin', () => {
	it('looks only below the scope Block, which may itself be nested', () => {
		const blocks = document();
		expect(locateWithin(blocks, 'inner', 'deep')!.parent!.id).toBe('inner');
		expect(locateWithin(blocks, 'outer', 'left')!.parent!.id).toBe('cols');
		expect(locateWithin(blocks, 'inner', 'left')).toBeNull();
		expect(locateWithin(blocks, 'inner', 'inner')).toBeNull();
		expect(locateWithin(blocks, 'intro', 'deep')).toBeNull();
	});
});

describe('replaceBlockInTree', () => {
	it('copies the path to a deep item and shares everything else', () => {
		const blocks = document();
		const before = JSON.stringify(blocks);
		const result = replaceBlockInTree(
			blocks,
			'deep',
			(b) => ({ ...b, content: { html: 'edited' } }) as EditorBlock
		)!;

		expect(JSON.stringify(blocks)).toBe(before);
		expect(result.rootIndex).toBe(1);
		expect(locateBlock([result.root], 'deep')!.block.content).toEqual({ html: 'edited' });
		// The sibling columns block is carried over, not rebuilt.
		expect(locateBlock([result.root], 'cols')!.block).toBe(locateBlock(blocks, 'cols')!.block);
	});

	it('replaces a root Block', () => {
		const result = replaceBlockInTree(document(), 'intro', () => text('intro', 'new'))!;
		expect(result).toEqual({ rootIndex: 0, root: text('intro', 'new') });
	});

	it('returns null for an unknown id', () => {
		expect(replaceBlockInTree(document(), 'ghost', (b) => b)).toBeNull();
	});
});

describe('cloneWithFreshIds', () => {
	it('renews every descendant id of columns, containers, nested composites and hero', () => {
		const blocks = document();
		for (const root of blocks) {
			const copy = cloneWithFreshIds(root);
			const ids = documentIds([...blocks, copy]);
			expect(new Set(ids).size).toBe(ids.length);
			expect(documentIds([copy])).toHaveLength(documentIds([root]).length);
		}
	});

	it('is a deep copy: editing it leaves the original alone', () => {
		const original = document()[1]!;
		const copy = cloneWithFreshIds(original);
		(
			locateBlock([copy], childBlockLists(copy)[0]![0]!.id)!.block.content as { items: unknown[] }
		).items.length = 0;
		expect(locateBlock([original], 'deep')).not.toBeNull();
	});
});
