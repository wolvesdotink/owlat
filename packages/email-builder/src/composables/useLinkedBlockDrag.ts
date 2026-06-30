import { ref, type Ref } from 'vue';
import type { EditorBlock } from '../types';
import type { UseLinkedBlocksReturn } from './useLinkedBlocks';

export interface UseLinkedBlockDragOptions {
	canvasBlocks: Ref<EditorBlock[]>;
	linkedBlocks: UseLinkedBlocksReturn;
}

export interface UseLinkedBlockDragReturn {
	draggingGroupId: Ref<string | null>;
	draggedBlockId: Ref<string | null>;
	handleDragStart: (event: { oldDraggableIndex?: number; item?: HTMLElement }) => void;
	handleDragUpdate: (event: { newDraggableIndex?: number }) => void;
	handleDragEnd: () => void;
}

const DRAG_CLONE_ATTR = 'data-drag-clone';

/**
 * Composable for moving linked blocks as a single unit during drag-and-drop.
 *
 * Strategy: post-hoc correction. VueDraggable moves a single block, then
 * handleDragUpdate rearranges the array so all group siblings are contiguous
 * at the new position. Both mutations happen in the same synchronous call
 * stack so Vue batches them into one render — no flicker.
 *
 * For visuals, sibling block DOM elements are cloned and injected into the
 * drag element on start so the full group follows the cursor. The original
 * siblings are collapsed via CSS. Clones are removed on drag end.
 */
export function useLinkedBlockDrag(options: UseLinkedBlockDragOptions): UseLinkedBlockDragReturn {
	const { canvasBlocks } = options;

	const draggingGroupId = ref<string | null>(null);
	const draggedBlockId = ref<string | null>(null);
	const originalGroupBlocks = ref<EditorBlock[]>([]);

	function handleDragStart(event: { oldDraggableIndex?: number; item?: HTMLElement }) {
		if (event.oldDraggableIndex == null) return;
		const block = canvasBlocks.value[event.oldDraggableIndex];
		if (!block?.savedBlockRef) return;

		const groupId = block.savedBlockRef.groupId;

		// Snapshot group blocks in their original order
		const groupBlocks = canvasBlocks.value.filter(
			(b) => b.savedBlockRef?.groupId === groupId,
		);

		// Clone sibling DOM elements into the drag element BEFORE setting
		// reactive state (which will collapse the originals via CSS).
		// The drag handle only exists on the first-in-group block, so the
		// user always drags from the first element — append siblings after.
		if (event.item && groupBlocks.length > 1) {
			const container = event.item.parentElement;
			if (container) {
				const allChildren = Array.from(container.children) as HTMLElement[];
				for (const groupBlock of groupBlocks) {
					if (groupBlock.id === block.id) continue;
					const idx = canvasBlocks.value.findIndex((b) => b.id === groupBlock.id);
					const siblingEl = allChildren[idx];
					if (!siblingEl) continue;
					const clone = siblingEl.cloneNode(true) as HTMLElement;
					clone.setAttribute(DRAG_CLONE_ATTR, 'true');
					event.item.appendChild(clone);
				}
			}
		}

		// Now set reactive state (triggers isDragSiblingHidden on siblings)
		draggingGroupId.value = groupId;
		draggedBlockId.value = block.id;
		originalGroupBlocks.value = groupBlocks;
	}

	function handleDragUpdate(event: { newDraggableIndex?: number }) {
		if (event.newDraggableIndex == null) return;
		const movedBlock = canvasBlocks.value[event.newDraggableIndex];
		if (!movedBlock?.savedBlockRef) return;

		const groupBlockIds = new Set(originalGroupBlocks.value.map((b) => b.id));

		// Separate non-group blocks from group blocks
		const nonGroupBlocks = canvasBlocks.value.filter((b) => !groupBlockIds.has(b.id));

		// Find where the dragged block landed among non-group blocks
		// Count how many non-group blocks appear before newDraggableIndex
		let insertionPoint = 0;
		for (let i = 0; i < event.newDraggableIndex; i++) {
			if (!groupBlockIds.has(canvasBlocks.value[i]!.id)) {
				insertionPoint++;
			}
		}

		// Rebuild array: non-group blocks with original group blocks spliced in
		const result = [...nonGroupBlocks];
		result.splice(insertionPoint, 0, ...originalGroupBlocks.value);

		canvasBlocks.value = result;
	}

	function handleDragEnd() {
		// Remove injected clones from the drag element
		document.querySelectorAll(`[${DRAG_CLONE_ATTR}]`).forEach((el) => el.remove());

		draggingGroupId.value = null;
		draggedBlockId.value = null;
		originalGroupBlocks.value = [];
	}

	return {
		draggingGroupId,
		draggedBlockId,
		handleDragStart,
		handleDragUpdate,
		handleDragEnd,
	};
}
