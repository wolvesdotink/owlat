import { computed, ref, type ComputedRef, type InjectionKey, type Ref } from 'vue';
import type { EditorBlock } from '../types';

export interface UseLinkedBlocksOptions {
	canvasBlocks: Ref<EditorBlock[]>;
	/** Called after detaching, which edits the blocks in place (see useBlockTreeVersion). */
	onTreeMutated?: () => void;
}

export interface LinkedBlockGroup {
	groupId: string;
	blockId: string;
	blockName: string;
	blockIndices: number[];
}

/** One draggable unit on the canvas: a whole linked group, or a single unlinked Block. */
export interface CanvasDisplayItem {
	id: string;
	blocks: EditorBlock[];
}

export interface LinkedBlockEntry {
	index: number;
	/** Saved-block group this Block belongs to, or null when it is not linked. */
	groupId: string | null;
	isFirstInGroup: boolean;
	isLastInGroup: boolean;
}

/** Everything the canvas asks about linked Blocks, built in one pass over the root array. */
export interface LinkedBlockIndex {
	/** The array this index was built from. */
	source: readonly EditorBlock[];
	byId: Map<string, LinkedBlockEntry>;
	/** Groups in first-appearance order. */
	groups: Map<string, LinkedBlockGroup>;
	/** Canvas draggable units: each group sits where its first Block appears. */
	displayItems: CanvasDisplayItem[];
}

/** Shared index provided by EmailBuilder; DocumentCanvas falls back to its own. */
export const LINKED_BLOCK_INDEX_KEY: InjectionKey<ComputedRef<LinkedBlockIndex>> =
	Symbol('linkedBlockIndex');

/**
 * Index the root Blocks by id and saved-block group in a single pass. Reads
 * `id` and `savedBlockRef` of every Block, so inside a `computed` it is
 * invalidated by reorders, inserts, removals, swapped Blocks and an in-place
 * `delete block.savedBlockRef`, and by nothing else (selection included).
 */
export function buildLinkedBlockIndex(blocks: readonly EditorBlock[]): LinkedBlockIndex {
	const byId = new Map<string, LinkedBlockEntry>();
	const groups = new Map<string, LinkedBlockGroup>();
	const groupItems = new Map<string, CanvasDisplayItem>();
	const lastEntry = new Map<string, LinkedBlockEntry>();
	const displayItems: CanvasDisplayItem[] = [];

	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index]!;
		const ref = block.savedBlockRef;
		if (!ref) {
			if (!byId.has(block.id)) {
				byId.set(block.id, { index, groupId: null, isFirstInGroup: false, isLastInGroup: false });
			}
			displayItems.push({ id: block.id, blocks: [block] });
			continue;
		}
		const { groupId } = ref;
		const group = groups.get(groupId);
		const entry: LinkedBlockEntry = { index, groupId, isFirstInGroup: !group, isLastInGroup: true };
		if (group) {
			group.blockIndices.push(index);
			// The group's metadata follows its last Block, as the old scan did.
			group.blockId = ref.blockId;
			group.blockName = ref.blockName;
			lastEntry.get(groupId)!.isLastInGroup = false;
			groupItems.get(groupId)!.blocks.push(block);
		} else {
			groups.set(groupId, {
				groupId,
				blockId: ref.blockId,
				blockName: ref.blockName,
				blockIndices: [index],
			});
			const item = { id: `group-${groupId}`, blocks: [block] };
			groupItems.set(groupId, item);
			displayItems.push(item);
		}
		lastEntry.set(groupId, entry);
		// A duplicate id resolves to its first occurrence, like the old `Array.find`.
		if (!byId.has(block.id)) byId.set(block.id, entry);
	}

	return { source: blocks, byId, groups, displayItems };
}

export interface UseLinkedBlocksReturn {
	/** The shared index; recomputed only when order or linked-group membership changes. */
	index: ComputedRef<LinkedBlockIndex>;
	isLinkedBlock: (blockId: string) => boolean;
	getLinkedGroup: (groupId: string) => LinkedBlockGroup | null;
	getLinkedGroupByBlockId: (blockId: string) => LinkedBlockGroup | null;
	detachLinkedGroup: (groupId: string) => void;
	detachBlock: (blockId: string) => void;
	getLinkedBlockGroups: () => LinkedBlockGroup[];
	isFirstInGroup: (blockId: string) => boolean;
	isLastInGroup: (blockId: string) => boolean;
}

const copyGroup = (group: LinkedBlockGroup): LinkedBlockGroup => ({
	...group,
	blockIndices: [...group.blockIndices],
});

/**
 * Composable for managing linked block state and operations
 */
export function useLinkedBlocks(options: UseLinkedBlocksOptions): UseLinkedBlocksReturn {
	const { canvasBlocks, onTreeMutated } = options;

	// Detach deletes `savedBlockRef` in place. A deep ref already reports that to
	// the index, but a shallow or plain one would not, so detach also bumps this.
	const detachTick = ref(0);
	const index = computed(() => {
		void detachTick.value;
		return buildLinkedBlockIndex(canvasBlocks.value);
	});

	const isLinkedBlock = (blockId: string): boolean => !!index.value.byId.get(blockId)?.groupId;

	const getLinkedGroup = (groupId: string): LinkedBlockGroup | null => {
		const group = index.value.groups.get(groupId);
		return group ? copyGroup(group) : null;
	};

	const getLinkedGroupByBlockId = (blockId: string): LinkedBlockGroup | null => {
		const groupId = index.value.byId.get(blockId)?.groupId;
		return groupId ? getLinkedGroup(groupId) : null;
	};

	const detachLinkedGroup = (groupId: string): void => {
		// A user action, not a render path: scan the live array rather than trust the index.
		let detached = false;
		for (const block of canvasBlocks.value) {
			if (block.savedBlockRef?.groupId === groupId) {
				delete block.savedBlockRef;
				detached = true;
			}
		}
		if (!detached) return;
		detachTick.value++;
		onTreeMutated?.();
	};

	const detachBlock = (blockId: string): void => {
		const groupId = index.value.byId.get(blockId)?.groupId;
		// Detach the entire group, not just one block
		if (groupId) detachLinkedGroup(groupId);
	};

	const getLinkedBlockGroups = (): LinkedBlockGroup[] =>
		Array.from(index.value.groups.values(), copyGroup);

	const isFirstInGroup = (blockId: string): boolean =>
		!!index.value.byId.get(blockId)?.isFirstInGroup;

	const isLastInGroup = (blockId: string): boolean =>
		!!index.value.byId.get(blockId)?.isLastInGroup;

	return {
		index,
		isLinkedBlock,
		getLinkedGroup,
		getLinkedGroupByBlockId,
		detachLinkedGroup,
		detachBlock,
		getLinkedBlockGroups,
		isFirstInGroup,
		isLastInGroup,
	};
}
