import { onMounted, onUnmounted, ref, type ComputedRef, type Ref } from 'vue';
import type { EditorBlock } from '../../types';
import { resolveEditorKeyAction } from '../../utils/editorKeyboard';
import type { MoveDirection } from '../../utils/blockMove';

interface UseBuilderShortcutsOptions {
	isInlineEditing: Ref<boolean> | ComputedRef<boolean>;
	activeBlock: ComputedRef<EditorBlock | null>;
	exitInlineEdit: () => void;
	undo: () => void;
	redo: () => void;
	moveBlock: (direction: MoveDirection) => void;
	deleteActiveBlock: () => void;
	duplicateActiveBlock: () => void;
}

/** The builder's global keyboard shortcuts and their help sheet. */
export function useBuilderShortcuts(options: UseBuilderShortcutsOptions) {
	const { isInlineEditing, activeBlock, exitInlineEdit, undo, redo } = options;

	// Keyboard shortcuts help sheet (opened with `?` or the header button)
	const showShortcutsDialog = ref(false);

	// Global shortcuts. The routing itself lives in utils/editorKeyboard so it is
	// testable without the editor; here we only dispatch.
	function handleKeydown(event: KeyboardEvent) {
		const action = resolveEditorKeyAction(event, {
			isInlineEditing: isInlineEditing.value,
			isShortcutsDialogOpen: showShortcutsDialog.value,
			hasActiveBlock: Boolean(activeBlock.value),
		});
		if (!action) return;

		event.preventDefault();
		switch (action.type) {
			case 'exit-inline-edit':
				exitInlineEdit();
				break;
			case 'undo':
				undo();
				break;
			case 'redo':
				redo();
				break;
			case 'show-shortcuts':
				showShortcutsDialog.value = true;
				break;
			case 'move':
				options.moveBlock(action.direction);
				break;
			case 'delete':
				options.deleteActiveBlock();
				break;
			case 'duplicate':
				options.duplicateActiveBlock();
				break;
		}
	}

	onMounted(() => window.addEventListener('keydown', handleKeydown));
	onUnmounted(() => window.removeEventListener('keydown', handleKeydown));

	return { showShortcutsDialog };
}
