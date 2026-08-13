// Alt+Arrow reordering, at every level the canvas nests to.
//
// The undo contract is the point of most of these: the move must produce a NEW
// top-level array and leave the array it was given untouched, so the editor
// applies it with one write and the history watcher records one step instead of
// half-mutating the state it is diffing against.
import { describe, it, expect } from 'vitest';
import { moveBlock } from '../blockMove';
import type {
	ColumnsBlockContent,
	ContainerBlockContent,
	EditorBlock,
	ColumnItem,
	ContainerItem,
} from '../../types';

const textItem = (id: string): ColumnItem =>
	({ id, type: 'text', content: { html: `<p>${id}</p>` } }) as unknown as ColumnItem;

const block = (id: string): EditorBlock =>
	({ id, type: 'text', content: { html: `<p>${id}</p>` } }) as unknown as EditorBlock;

const columns = (id: string, cols: ColumnItem[][]): EditorBlock =>
	({ id, type: 'columns', content: { columns: cols } }) as unknown as EditorBlock;

const container = (id: string, items: ContainerItem[], type = 'container'): EditorBlock =>
	({ id, type, content: { items } }) as unknown as EditorBlock;

const ids = (blocks: readonly EditorBlock[]) => blocks.map((b) => b.id);
const columnIds = (blocks: readonly EditorBlock[], index: number, column = 0) =>
	((blocks[index]!.content as ColumnsBlockContent).columns[column] ?? []).map((i) => i.id);
const itemIds = (blocks: readonly EditorBlock[], index: number) =>
	(blocks[index]!.content as ContainerBlockContent).items.map((i) => i.id);

describe('moveBlock — root blocks', () => {
	const blocks = () => [block('a'), block('b'), block('c')];

	it('moves a block up and down', () => {
		expect(ids(moveBlock(blocks(), { itemId: 'b' }, 'up')!)).toEqual(['b', 'a', 'c']);
		expect(ids(moveBlock(blocks(), { itemId: 'b' }, 'down')!)).toEqual(['a', 'c', 'b']);
	});

	it('stops at the ends instead of wrapping', () => {
		expect(moveBlock(blocks(), { itemId: 'a' }, 'up')).toBeNull();
		expect(moveBlock(blocks(), { itemId: 'c' }, 'down')).toBeNull();
	});

	it('ignores an unknown block', () => {
		expect(moveBlock(blocks(), { itemId: 'nope' }, 'up')).toBeNull();
	});

	it('leaves the array it was given untouched', () => {
		const original = blocks();
		const moved = moveBlock(original, { itemId: 'b' }, 'up')!;
		expect(ids(original)).toEqual(['a', 'b', 'c']);
		expect(moved).not.toBe(original);
	});
});

describe('moveBlock — column items', () => {
	const blocks = () => [
		block('before'),
		columns('cols', [[textItem('c1'), textItem('c2'), textItem('c3')], [textItem('other')]]),
	];
	const target = { itemId: 'c2', column: { blockId: 'cols', columnIndex: 0 } };

	it('moves an item within its own column', () => {
		expect(columnIds(moveBlock(blocks(), target, 'up')!, 1)).toEqual(['c2', 'c1', 'c3']);
		expect(columnIds(moveBlock(blocks(), target, 'down')!, 1)).toEqual(['c1', 'c3', 'c2']);
	});

	it('leaves the sibling columns and the rest of the document alone', () => {
		const moved = moveBlock(blocks(), target, 'up')!;
		expect(ids(moved)).toEqual(['before', 'cols']);
		expect(columnIds(moved, 1, 1)).toEqual(['other']);
	});

	it('stops at the ends of the column', () => {
		expect(
			moveBlock(blocks(), { itemId: 'c1', column: { blockId: 'cols', columnIndex: 0 } }, 'up')
		).toBeNull();
		expect(
			moveBlock(blocks(), { itemId: 'c3', column: { blockId: 'cols', columnIndex: 0 } }, 'down')
		).toBeNull();
	});

	it('ignores a missing column, a missing item and a non-columns parent', () => {
		expect(
			moveBlock(blocks(), { itemId: 'c2', column: { blockId: 'cols', columnIndex: 7 } }, 'up')
		).toBeNull();
		expect(
			moveBlock(blocks(), { itemId: 'ghost', column: { blockId: 'cols', columnIndex: 0 } }, 'up')
		).toBeNull();
		expect(
			moveBlock(blocks(), { itemId: 'c2', column: { blockId: 'before', columnIndex: 0 } }, 'up')
		).toBeNull();
	});

	it('replaces the whole array rather than mutating the parent in place', () => {
		const original = blocks();
		const moved = moveBlock(original, target, 'up')!;
		expect(columnIds(original, 1)).toEqual(['c1', 'c2', 'c3']);
		expect(moved).not.toBe(original);
		expect(moved[1]).not.toBe(original[1]);
		// The untouched sibling is carried over, not rebuilt.
		expect(moved[0]).toBe(original[0]);
	});
});

describe('moveBlock — container items', () => {
	const items = () =>
		[textItem('i1'), textItem('i2'), textItem('i3')] as unknown as ContainerItem[];
	const blocks = (type = 'container') => [container('box', items(), type), block('after')];
	const target = { itemId: 'i2', container: { blockId: 'box' } };

	it('moves an item up and down inside its container', () => {
		expect(itemIds(moveBlock(blocks(), target, 'up')!, 0)).toEqual(['i2', 'i1', 'i3']);
		expect(itemIds(moveBlock(blocks(), target, 'down')!, 0)).toEqual(['i1', 'i3', 'i2']);
	});

	it('works the same inside a hero', () => {
		expect(itemIds(moveBlock(blocks('hero'), target, 'up')!, 0)).toEqual(['i2', 'i1', 'i3']);
	});

	it('stops at the ends and ignores unknown ids', () => {
		expect(moveBlock(blocks(), { itemId: 'i1', container: { blockId: 'box' } }, 'up')).toBeNull();
		expect(moveBlock(blocks(), { itemId: 'i3', container: { blockId: 'box' } }, 'down')).toBeNull();
		expect(
			moveBlock(blocks(), { itemId: 'ghost', container: { blockId: 'box' } }, 'up')
		).toBeNull();
		expect(moveBlock(blocks(), { itemId: 'i2', container: { blockId: 'gone' } }, 'up')).toBeNull();
	});

	it('replaces the whole array rather than mutating the parent in place', () => {
		const original = blocks();
		const moved = moveBlock(original, target, 'up')!;
		expect(itemIds(original, 0)).toEqual(['i1', 'i2', 'i3']);
		expect(moved).not.toBe(original);
		expect(moved[0]).not.toBe(original[0]);
		expect(moved[1]).toBe(original[1]);
	});
});
