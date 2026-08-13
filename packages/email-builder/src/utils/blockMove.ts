/**
 * Reordering a block (or a nested column/container item) one slot up or down.
 *
 * Extracted from EmailBuilder.vue so the index math is unit-testable and so the
 * undo contract is stated in one place: every branch returns a NEW top-level
 * blocks array and mutates nothing that was passed in. The caller assigns it in
 * a single write, so the history watcher sees exactly one change and Alt+Arrow
 * lands as one undoable step — the same shape a drag reorder produces.
 */
import type { EditorBlock, ColumnsBlockContent, ContainerBlockContent } from '../types';

export type MoveDirection = 'up' | 'down';

/** The item to move, plus the nested list it lives in (if any). */
export interface MoveTarget {
	/** Id of the block, column item or container item being moved. */
	itemId: string;
	/** Set when the item is a column item: its columns block and column index. */
	column?: { blockId: string; columnIndex: number } | null;
	/** Set when the item is a container/hero item: its parent block. */
	container?: { blockId: string } | null;
}

/** A copy of `list` with the item at `index` swapped one slot in `direction`, or null at the ends. */
function swap<T>(list: readonly T[], index: number, direction: MoveDirection): T[] | null {
	if (index === -1) return null;
	const target = direction === 'up' ? index - 1 : index + 1;
	if (target < 0 || target >= list.length) return null;
	const next = [...list];
	next[index] = list[target]!;
	next[target] = list[index]!;
	return next;
}

/** Replace one block of `blocks` by index, returning a new array. */
function replaceAt(blocks: readonly EditorBlock[], index: number, block: EditorBlock): EditorBlock[] {
	const next = [...blocks];
	next[index] = block;
	return next;
}

/**
 * The blocks array that results from moving `target` one slot in `direction`,
 * or `null` when the move is impossible (unknown item, already at an end).
 */
export function moveBlock(
	blocks: readonly EditorBlock[],
	target: MoveTarget,
	direction: MoveDirection
): EditorBlock[] | null {
	if (target.column) {
		const parentIndex = blocks.findIndex((b) => b.id === target.column!.blockId);
		const parent = blocks[parentIndex];
		if (!parent || parent.type !== 'columns') return null;
		const content = parent.content as ColumnsBlockContent;
		const column = content.columns[target.column.columnIndex];
		if (!column) return null;
		const moved = swap(
			column,
			column.findIndex((item) => item.id === target.itemId),
			direction
		);
		if (!moved) return null;
		const columns = [...content.columns];
		columns[target.column.columnIndex] = moved;
		return replaceAt(blocks, parentIndex, {
			...parent,
			content: { ...content, columns },
		} as EditorBlock);
	}

	if (target.container) {
		const parentIndex = blocks.findIndex((b) => b.id === target.container!.blockId);
		const parent = blocks[parentIndex];
		if (!parent) return null;
		const content = parent.content as ContainerBlockContent;
		const items = swap(
			content.items ?? [],
			(content.items ?? []).findIndex((item) => item.id === target.itemId),
			direction
		);
		if (!items) return null;
		return replaceAt(blocks, parentIndex, {
			...parent,
			content: { ...content, items },
		} as EditorBlock);
	}

	return swap(
		blocks,
		blocks.findIndex((b) => b.id === target.itemId),
		direction
	);
}
