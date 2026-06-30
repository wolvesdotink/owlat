import { type Ref } from 'vue';
import type { EditorBlock } from '../types';

export interface UseLinkedBlocksOptions {
	canvasBlocks: Ref<EditorBlock[]>;
}

export interface LinkedBlockGroup {
	groupId: string;
	blockId: string;
	blockName: string;
	blockIndices: number[];
}

export interface UseLinkedBlocksReturn {
	isLinkedBlock: (blockId: string) => boolean;
	getLinkedGroup: (groupId: string) => LinkedBlockGroup | null;
	getLinkedGroupByBlockId: (blockId: string) => LinkedBlockGroup | null;
	detachLinkedGroup: (groupId: string) => void;
	detachBlock: (blockId: string) => void;
	getLinkedBlockGroups: () => LinkedBlockGroup[];
	isFirstInGroup: (blockId: string) => boolean;
	isLastInGroup: (blockId: string) => boolean;
}

/**
 * Composable for managing linked block state and operations
 */
export function useLinkedBlocks(options: UseLinkedBlocksOptions): UseLinkedBlocksReturn {
	const { canvasBlocks } = options;

	const isLinkedBlock = (blockId: string): boolean => {
		const block = canvasBlocks.value.find((b) => b.id === blockId);
		return !!block?.savedBlockRef;
	};

	const getLinkedGroup = (groupId: string): LinkedBlockGroup | null => {
		const indices: number[] = [];
		let blockId = '';
		let blockName = '';

		canvasBlocks.value.forEach((block, index) => {
			if (block.savedBlockRef?.groupId === groupId) {
				indices.push(index);
				blockId = block.savedBlockRef.blockId;
				blockName = block.savedBlockRef.blockName;
			}
		});

		if (indices.length === 0) return null;

		return { groupId, blockId, blockName, blockIndices: indices };
	};

	const getLinkedGroupByBlockId = (blockId: string): LinkedBlockGroup | null => {
		const block = canvasBlocks.value.find((b) => b.id === blockId);
		if (!block?.savedBlockRef) return null;
		return getLinkedGroup(block.savedBlockRef.groupId);
	};

	const detachLinkedGroup = (groupId: string): void => {
		canvasBlocks.value.forEach((block) => {
			if (block.savedBlockRef?.groupId === groupId) {
				delete block.savedBlockRef;
			}
		});
	};

	const detachBlock = (blockId: string): void => {
		const block = canvasBlocks.value.find((b) => b.id === blockId);
		if (block?.savedBlockRef) {
			// Detach the entire group, not just one block
			detachLinkedGroup(block.savedBlockRef.groupId);
		}
	};

	const getLinkedBlockGroups = (): LinkedBlockGroup[] => {
		const groups = new Map<string, LinkedBlockGroup>();

		canvasBlocks.value.forEach((block, index) => {
			if (block.savedBlockRef) {
				const { groupId, blockId, blockName } = block.savedBlockRef;
				const existing = groups.get(groupId);
				if (existing) {
					existing.blockIndices.push(index);
				} else {
					groups.set(groupId, {
						groupId,
						blockId,
						blockName,
						blockIndices: [index],
					});
				}
			}
		});

		return Array.from(groups.values());
	};

	const isFirstInGroup = (blockId: string): boolean => {
		const block = canvasBlocks.value.find((b) => b.id === blockId);
		if (!block?.savedBlockRef) return false;

		const group = getLinkedGroup(block.savedBlockRef.groupId);
		if (!group) return false;

		const blockIndex = canvasBlocks.value.findIndex((b) => b.id === blockId);
		return group.blockIndices[0] === blockIndex;
	};

	const isLastInGroup = (blockId: string): boolean => {
		const block = canvasBlocks.value.find((b) => b.id === blockId);
		if (!block?.savedBlockRef) return false;

		const group = getLinkedGroup(block.savedBlockRef.groupId);
		if (!group) return false;

		const blockIndex = canvasBlocks.value.findIndex((b) => b.id === blockId);
		return group.blockIndices[group.blockIndices.length - 1] === blockIndex;
	};

	return {
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
