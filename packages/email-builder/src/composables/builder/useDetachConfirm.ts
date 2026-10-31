import { provide, ref, type Ref } from 'vue';
import type { UseLinkedBlocksReturn } from '../useLinkedBlocks';

interface UseDetachConfirmOptions {
	linkedBlocks: Pick<UseLinkedBlocksReturn, 'getLinkedGroupByBlockId' | 'detachBlock'>;
	/** The root Block that owns the selection, if any. */
	selectedRootId: Ref<string | null>;
}

/**
 * Detaching a linked Block from the saved-block library, after the user
 * confirms. The canvas asks for it through the injected
 * `requestDetachLinkedBlock`.
 */
export function useDetachConfirm({ linkedBlocks, selectedRootId }: UseDetachConfirmOptions) {
	const { getLinkedGroupByBlockId, detachBlock } = linkedBlocks;

	// Detach confirmation state
	const showDetachConfirm = ref(false);
	const pendingDetachBlockId = ref<string | null>(null);
	const pendingDetachBlockName = ref<string | null>(null);

	function requestDetachBlock(blockId: string) {
		const group = getLinkedGroupByBlockId(blockId);
		pendingDetachBlockId.value = blockId;
		pendingDetachBlockName.value = group?.blockName ?? null;
		showDetachConfirm.value = true;
	}

	function confirmDetach() {
		if (pendingDetachBlockId.value) {
			detachBlock(pendingDetachBlockId.value);
		}
		cancelDetach();
	}

	function cancelDetach() {
		showDetachConfirm.value = false;
		pendingDetachBlockId.value = null;
		pendingDetachBlockName.value = null;
	}

	function handleDetachActiveBlock() {
		if (selectedRootId.value) requestDetachBlock(selectedRootId.value);
	}

	provide('requestDetachLinkedBlock', requestDetachBlock);

	return {
		showDetachConfirm,
		pendingDetachBlockName,
		confirmDetach,
		cancelDetach,
		handleDetachActiveBlock,
	};
}
