/**
 * Finding and editing a Block anywhere in the canvas tree, at any depth.
 *
 * Which composites hold which child lists is the shared Block-tree contract
 * (`@owlat/shared/blockTree`). This module adds the editor's view of it: the
 * root Block that owns a nested item (linked-group and saved-block state live
 * on roots), path-copying edits that hand back a new root for a single write,
 * and deep copies with fresh ids for duplication and saved-block insertion.
 *
 * Nested items are typed as `EditorBlock`, the shape every level shares.
 */
import { childBlockLists, mapChildBlockLists, renewBlockTreeIds } from '@owlat/shared/blockTree';
import type { EditorBlock } from '../types';
import { generateId } from './id';
import { plainClone } from './plainClone';

/** Where a Block sits in the tree. */
export interface BlockLocation {
	/** Index of the root Block that owns it (its own index when it is a root). */
	rootIndex: number;
	/** The root Block that owns it. */
	root: EditorBlock;
	/** The Block itself. */
	block: EditorBlock;
	/** Its direct composite parent, or null for a root Block. */
	parent: EditorBlock | null;
	/** The array that holds it: one of the parent's child lists, or the root array. */
	list: EditorBlock[];
	/** Its position in `list`. */
	index: number;
	/** Which of the parent's child lists holds it (for a columns parent, the column). */
	listIndex: number;
}

type NestedLocation = Pick<BlockLocation, 'block' | 'parent' | 'list' | 'index' | 'listIndex'>;

function findBelow(node: EditorBlock, id: string): NestedLocation | null {
	const lists = childBlockLists(node);
	for (let listIndex = 0; listIndex < lists.length; listIndex++) {
		const list = lists[listIndex]!;
		const index = list.findIndex((child) => child.id === id);
		if (index !== -1) return { block: list[index]!, parent: node, list, index, listIndex };
	}
	for (const list of lists) {
		for (const child of list) {
			const found = findBelow(child, id);
			if (found) return found;
		}
	}
	return null;
}

/**
 * Locate the Block `id` among `blocks` and everything nested inside them.
 *
 * `preferRootId` searches that root's subtree first. Documents saved before
 * duplication renewed child ids can hold the same child id under two roots;
 * preferring the root of the current selection keeps an edit on the copy the
 * author is looking at.
 */
export function locateBlock(
	blocks: readonly EditorBlock[],
	id: string,
	preferRootId?: string | null
): BlockLocation | null {
	const order = [...blocks.keys()];
	const preferred = preferRootId ? blocks.findIndex((b) => b.id === preferRootId) : -1;
	if (preferred > 0) order.unshift(...order.splice(preferred, 1));
	for (const rootIndex of order) {
		const root = blocks[rootIndex]!;
		if (root.id === id) {
			return {
				rootIndex,
				root,
				block: root,
				parent: null,
				list: blocks as EditorBlock[],
				index: rootIndex,
				listIndex: 0,
			};
		}
		const nested = findBelow(root, id);
		if (nested) return { rootIndex, root, ...nested };
	}
	return null;
}

/**
 * Locate `id` strictly inside the subtree of the Block `scopeId` (which may
 * itself be nested). Returns null when either is missing or `id` is the scope.
 */
export function locateWithin(
	blocks: readonly EditorBlock[],
	scopeId: string,
	id: string
): BlockLocation | null {
	const scope = locateBlock(blocks, scopeId);
	if (!scope) return null;
	const nested = findBelow(scope.block, id);
	return nested ? { rootIndex: scope.rootIndex, root: scope.root, ...nested } : null;
}

function replaceBelow(
	node: EditorBlock,
	id: string,
	update: (block: EditorBlock) => EditorBlock
): EditorBlock | null {
	if (node.id === id) return update(node);
	let replaced = false;
	const next = mapChildBlockLists(node, (list) => {
		if (replaced) return list;
		for (let i = 0; i < list.length; i++) {
			const child = replaceBelow(list[i]!, id, update);
			if (child) {
				replaced = true;
				return [...list.slice(0, i), child, ...list.slice(i + 1)];
			}
		}
		return list;
	});
	return replaced ? next : null;
}

/**
 * Replace the Block `id` (a root or any descendant) by `update(block)` without
 * mutating anything: the root and every composite on the path to the Block are
 * copied, everything else is shared. Returns the new root and its index, for
 * the caller to write back in one assignment, or null when `id` is absent.
 */
export function replaceBlockInTree(
	blocks: readonly EditorBlock[],
	id: string,
	update: (block: EditorBlock) => EditorBlock,
	preferRootId?: string | null
): { rootIndex: number; root: EditorBlock } | null {
	const location = locateBlock(blocks, id, preferRootId);
	if (!location) return null;
	const root = replaceBelow(location.root, id, update);
	return root ? { rootIndex: location.rootIndex, root } : null;
}

/**
 * A deep, plain copy of `block` in which the Block and every descendant
 * (and every accordion section) has a fresh id. Use it for anything that puts
 * a second copy of existing content into the document: a duplicate, or a
 * saved Block inserted again.
 */
export function cloneWithFreshIds<T extends EditorBlock>(block: T): T {
	const copy = plainClone(block);
	renewBlockTreeIds(copy, generateId);
	return copy;
}
