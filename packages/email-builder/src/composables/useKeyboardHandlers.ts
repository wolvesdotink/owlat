import { onMounted, onUnmounted } from 'vue';
import type { Ref, ComputedRef } from 'vue';
import type { EditorBlock, ColumnItem, TextBlockContent, ImageBlockContent } from '../types';

export interface KeyboardHandlerCallbacks {
	/** Called on Ctrl/Cmd+Z (without Shift) */
	onUndo: () => void;
	/** Called on Ctrl/Cmd+Shift+Z */
	onRedo: () => void;
	/** Called when Escape is pressed and menus are open */
	onCloseSlashMenu: () => void;
	onCloseVariablePicker: () => void;
	onCloseSavedBlockPicker: () => void;
	/** Called on Delete/Backspace for the selected container item */
	onDeleteSelectedContainerItem: () => void;
	/** Called on Delete/Backspace for selected block/column images */
	onClearImageContent: (content: ImageBlockContent) => void;
	/** Called on Ctrl/Cmd+D for container item duplication */
	onDuplicateSelectedContainerItem: () => void;
	/** Called on Enter to insert a text item after the selected column item */
	onInsertColumnItemAfter: (
		blockId: string,
		columnIndex: number,
		afterItemId: string,
		itemType: ColumnItem['type']
	) => ColumnItem | null;
	/** Called on Enter to insert an empty text block after the selected block */
	onInsertEmptyTextBlockAfter: (afterBlockId: string) => EditorBlock;
	/** Called to focus a text editor after creating a new block */
	onFocusTextEditor: (blockId: string) => void;
	/** Called to focus a column item text editor */
	onFocusColumnItemTextEditor: (itemId: string) => void;
}

export interface KeyboardHandlerState {
	/** Whether the slash command menu is currently open */
	isSlashMenuOpen: boolean;
	/** Whether the variable picker is currently open */
	isVariablePickerOpen: boolean;
	/** Whether the saved block picker is currently open */
	isSavedBlockPickerOpen: boolean;
}

export interface UseKeyboardHandlersOptions {
	/** Reactive state for menu open/close status */
	menuState: ComputedRef<KeyboardHandlerState>;
	/** The currently selected block */
	selectedBlock: ComputedRef<EditorBlock | null>;
	/** The currently selected column item (typed as EditorBlock from useBlockState) */
	selectedColumnItem: ComputedRef<EditorBlock | null>;
	/** The currently selected column context */
	selectedColumnContext: Ref<{ blockId: string; columnIndex: number } | null>;
	/** The currently selected container item (typed as EditorBlock from useBlockState) */
	selectedContainerItem: ComputedRef<EditorBlock | null>;
	/** The currently selected container context */
	selectedContainerContext: Ref<{ blockId: string } | null>;
	/** Callback functions for keyboard actions */
	callbacks: KeyboardHandlerCallbacks;
}

/**
 * Composable that handles global keyboard shortcuts for the email builder.
 *
 * Manages:
 * - Undo/Redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z)
 * - Escape to close menus
 * - Delete/Backspace for block/item deletion or image clearing
 * - Ctrl/Cmd+D for duplication
 * - Enter to insert new text blocks/items
 */
export function useKeyboardHandlers(options: UseKeyboardHandlersOptions) {
	const {
		menuState,
		selectedBlock,
		selectedColumnItem,
		selectedColumnContext,
		selectedContainerItem,
		selectedContainerContext,
		callbacks,
	} = options;

	const isEditableTarget = (target: EventTarget | null): boolean => {
		if (!target || !(target instanceof HTMLElement)) return false;
		const tagName = target.tagName.toLowerCase();
		if (['input', 'textarea', 'select', 'button'].includes(tagName)) return true;
		return target.isContentEditable;
	};

	const handleUndoRedoKeydown = (event: KeyboardEvent) => {
		// Check for Cmd/Ctrl + Z (undo) or Cmd/Ctrl + Shift + Z (redo)
		if ((event.metaKey || event.ctrlKey) && event.key === 'z') {
			// Don't intercept if we're in a text input
			const target = event.target as HTMLElement;
			if (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
				return;
			}

			if (event.shiftKey) {
				event.preventDefault();
				callbacks.onRedo();
			} else {
				event.preventDefault();
				callbacks.onUndo();
			}
		}
	};

	const handleKeydown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') {
			let didCloseMenu = false;
			if (menuState.value.isSlashMenuOpen) {
				callbacks.onCloseSlashMenu();
				didCloseMenu = true;
			}
			if (menuState.value.isVariablePickerOpen) {
				callbacks.onCloseVariablePicker();
				didCloseMenu = true;
			}
			if (menuState.value.isSavedBlockPickerOpen) {
				callbacks.onCloseSavedBlockPicker();
				didCloseMenu = true;
			}
			if (didCloseMenu) {
				event.preventDefault();
				return;
			}
		}

		if (isEditableTarget(event.target)) return;

		// Handle Delete/Backspace for container items
		if (event.key === 'Delete' || event.key === 'Backspace') {
			// Handle container item deletion first (most specific)
			if (selectedContainerItem.value && selectedContainerContext.value) {
				// If it's an image, clear the content instead of deleting
				if (selectedContainerItem.value.type === 'image') {
					callbacks.onClearImageContent(selectedContainerItem.value.content as ImageBlockContent);
				} else {
					callbacks.onDeleteSelectedContainerItem();
				}
				event.preventDefault();
				return;
			}

			// Handle column item (image content clear)
			if (selectedColumnItem.value?.type === 'image') {
				callbacks.onClearImageContent(selectedColumnItem.value.content as ImageBlockContent);
				event.preventDefault();
				return;
			}

			// Handle block (image content clear)
			if (selectedBlock.value?.type === 'image') {
				callbacks.onClearImageContent(selectedBlock.value.content as ImageBlockContent);
				event.preventDefault();
				return;
			}
		}

		// Handle Cmd/Ctrl+D for duplication
		if ((event.metaKey || event.ctrlKey) && event.key === 'd') {
			// Handle container item duplication
			if (selectedContainerItem.value && selectedContainerContext.value) {
				callbacks.onDuplicateSelectedContainerItem();
				event.preventDefault();
				return;
			}
		}

		if (event.key === 'Enter') {
			if (selectedColumnItem.value && selectedColumnContext.value) {
				const newItem = callbacks.onInsertColumnItemAfter(
					selectedColumnContext.value.blockId,
					selectedColumnContext.value.columnIndex,
					selectedColumnItem.value.id,
					'text'
				);
				if (newItem) {
					const textContent = newItem.content as TextBlockContent;
					textContent.html = '';
					callbacks.onFocusColumnItemTextEditor(newItem.id);
				}
				event.preventDefault();
				return;
			}

			if (selectedBlock.value) {
				const newBlock = callbacks.onInsertEmptyTextBlockAfter(selectedBlock.value.id);
				callbacks.onFocusTextEditor(newBlock.id);
				event.preventDefault();
			}
		}
	};

	onMounted(() => {
		window.addEventListener('keydown', handleKeydown);
		window.addEventListener('keydown', handleUndoRedoKeydown);
	});

	onUnmounted(() => {
		window.removeEventListener('keydown', handleKeydown);
		window.removeEventListener('keydown', handleUndoRedoKeydown);
	});

	return {
		handleKeydown,
		handleUndoRedoKeydown,
	};
}
