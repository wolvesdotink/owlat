import { ref, watch, type Ref } from 'vue';
import type { EditorBlock } from '../types';

export interface UseBlockTreeVersionReturn {
	/** Goes up whenever the block tree changes. Watch this, not the tree. */
	version: Readonly<Ref<number>>;
	/** Record a change made in place inside a block (see below). */
	bump: () => void;
}

/**
 * One counter for "the block tree changed", so the things that follow the
 * canvas (the `update:blocks` emit, undo history, the live preview, the host's
 * dirty flag) each watch a number instead of walking every block on every edit.
 *
 * Writes to the root array are caught here by a watcher that looks one level
 * deep: it sees the array replaced, a block swapped in its slot, and blocks
 * inserted or removed, but not what happens inside a block. Every canvas edit
 * that goes through the property path swaps the whole block, so that is
 * enough for them. The block-management composables that edit inside a block
 * in place (column and container items, the linked-block ref) call `bump`.
 */
export function useBlockTreeVersion(blocks: Ref<EditorBlock[]>): UseBlockTreeVersionReturn {
	const version = ref(0);
	const bump = () => {
		version.value++;
	};
	watch(blocks, bump, { deep: 1 });
	return { version, bump };
}
