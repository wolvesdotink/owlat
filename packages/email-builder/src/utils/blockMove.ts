/**
 * Reordering a block (or a nested column/container item) one slot up or down.
 *
 * Extracted from EmailBuilder.vue so the index math is unit-testable and so the
 * undo contract is stated in one place: every branch returns a NEW top-level
 * blocks array and mutates nothing that was passed in. The caller assigns it in
 * a single write, so the history watcher sees exactly one change and Alt+Arrow
 * lands as one undoable step — the same shape a drag reorder produces.
 */
import { mapChildBlockLists } from '@owlat/shared/blockTree';
import type { EditorBlock } from '../types';
import { locateWithin, replaceBlockInTree } from './blockTree';

export type MoveDirection = 'up' | 'down';

/** The item to move, plus the nested list it lives in (if any). */
export interface MoveTarget {
	/** Id of the block, column item or container item being moved. */
	itemId: string;
	/** Set when the item is a column item: its columns block (at any depth) and column index. */
	column?: { blockId: string; columnIndex: number } | null;
	/** Set when the item is a nested item: a composite it sits below, at any depth. */
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
function replaceAt(
	blocks: readonly EditorBlock[],
	index: number,
	block: EditorBlock
): EditorBlock[] {
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
	const scope = target.column ?? target.container;
	if (!scope) {
		return swap(
			blocks,
			blocks.findIndex((b) => b.id === target.itemId),
			direction
		);
	}

	// A nested item moves within the child list that holds it. A column item
	// must still be in the column the selection named.
	const location = locateWithin(blocks, scope.blockId, target.itemId);
	if (!location?.parent) return null;
	if (
		target.column &&
		(location.parent.id !== target.column.blockId ||
			location.listIndex !== target.column.columnIndex)
	) {
		return null;
	}
	const moved = swap(location.list, location.index, direction);
	if (!moved) return null;

	const replaced = replaceBlockInTree(
		blocks,
		location.parent.id,
		(parent) =>
			mapChildBlockLists(parent, (list, listIndex) =>
				listIndex === location.listIndex ? moved : list
			),
		location.root.id
	);
	return replaced ? replaceAt(blocks, replaced.rootIndex, replaced.root) : null;
}
