import { ref, shallowRef, computed, type Ref, type ShallowRef, type ComputedRef } from 'vue';
import { sanitizeRawHtml } from '@owlat/email-renderer';
import type { EditorBlock } from '../types';

export interface UseInlineTextEditOptions {
	activeBlock: ComputedRef<EditorBlock | null>;
	onUpdate: (blockId: string, key: string, value: unknown) => void;
	onDeleteBlock?: (blockId: string) => void;
}

export interface UseInlineTextEditReturn {
	isInlineEditing: ComputedRef<boolean>;
	inlineEditBlockId: Ref<string | null>;
	inlineEditorRef: ShallowRef<{ el: HTMLElement } | null>;
	showLinkDialog: Ref<boolean>;
	linkDialogInitialUrl: Ref<string>;
	linkDialogIsEditing: Ref<boolean>;
	enterInlineEdit: (blockId: string) => void;
	exitInlineEdit: () => void;
	handleInlineFormat: (command: string, value?: string) => void;
	openLinkDialog: () => void;
	handleLinkApply: (url: string) => void;
	handleLinkRemove: () => void;
	closeLinkDialog: () => void;
}

/**
 * Manages inline text editing state for the email builder canvas.
 */
export function useInlineTextEdit(options: UseInlineTextEditOptions): UseInlineTextEditReturn {
	const { activeBlock, onUpdate, onDeleteBlock } = options;

	const inlineEditBlockId = ref<string | null>(null);
	const inlineEditorRef = shallowRef<{ el: HTMLElement } | null>(null);

	// Link dialog state
	const showLinkDialog = ref(false);
	const linkDialogInitialUrl = ref('');
	const linkDialogIsEditing = ref(false);
	let savedSelection: Range | null = null;

	const isInlineEditing = computed(() => inlineEditBlockId.value !== null);

	function enterInlineEdit(blockId: string) {
		// Allow inline editing for text blocks at any level
		const block = activeBlock.value;
		if (!block || block.id !== blockId || block.type !== 'text') return;
		inlineEditBlockId.value = blockId;
	}

	function exitInlineEdit() {
		if (!inlineEditBlockId.value) return;

		// Save final HTML from editor ref
		if (inlineEditorRef.value?.el) {
			const html = inlineEditorRef.value.el.innerHTML;

			// Auto-delete empty text blocks on blur
			const isEmpty = !html || html === '<br>' || html.replace(/<[^>]*>/g, '').trim() === '';
			if (isEmpty && onDeleteBlock) {
				onDeleteBlock(inlineEditBlockId.value);
				inlineEditBlockId.value = null;
				inlineEditorRef.value = null;
				return;
			}

			// Belt-and-suspenders: scrub contenteditable output before it is
			// persisted, so a pasted `<img onerror=…>`/`<script>` never reaches
			// storage. The renderer sanitises again at the email boundary.
			onUpdate(inlineEditBlockId.value, 'html', sanitizeRawHtml(html));
		}

		inlineEditBlockId.value = null;
		inlineEditorRef.value = null;
	}

	function handleInlineFormat(command: string, value?: string) {
		if (!isInlineEditing.value || !inlineEditorRef.value?.el) return;

		// Focus the editor to ensure selection is active
		inlineEditorRef.value.el.focus();

		if (command === 'createLink') {
			openLinkDialog();
		} else {
			document.execCommand(command, false, value);
		}
	}

	function saveSelection() {
		const selection = window.getSelection();
		if (selection && selection.rangeCount > 0) {
			savedSelection = selection.getRangeAt(0).cloneRange();
		}
	}

	function restoreSelection() {
		if (savedSelection) {
			const selection = window.getSelection();
			if (selection) {
				selection.removeAllRanges();
				selection.addRange(savedSelection);
			}
		}
	}

	function openLinkDialog() {
		if (!inlineEditorRef.value?.el) return;

		inlineEditorRef.value.el.focus();
		saveSelection();

		// Check if cursor is inside an existing link
		const selection = window.getSelection();
		let existingUrl = '';
		let isEditing = false;

		if (selection && selection.rangeCount > 0) {
			let node: Node | null = selection.getRangeAt(0).commonAncestorContainer;
			while (node && node !== (inlineEditorRef.value.el as Node)) {
				if (node instanceof HTMLAnchorElement) {
					existingUrl = node.href;
					isEditing = true;
					break;
				}
				node = node.parentNode;
			}
		}

		linkDialogInitialUrl.value = existingUrl;
		linkDialogIsEditing.value = isEditing;
		showLinkDialog.value = true;
	}

	function handleLinkApply(url: string) {
		if (!inlineEditorRef.value?.el) return;
		inlineEditorRef.value.el.focus();
		restoreSelection();
		document.execCommand('createLink', false, url);
		closeLinkDialog();
	}

	function handleLinkRemove() {
		if (!inlineEditorRef.value?.el) return;
		inlineEditorRef.value.el.focus();
		restoreSelection();
		document.execCommand('unlink');
		closeLinkDialog();
	}

	function closeLinkDialog() {
		showLinkDialog.value = false;
		linkDialogInitialUrl.value = '';
		linkDialogIsEditing.value = false;
		savedSelection = null;
		// Re-focus editor
		inlineEditorRef.value?.el?.focus();
	}

	return {
		isInlineEditing,
		inlineEditBlockId,
		inlineEditorRef,
		showLinkDialog,
		linkDialogInitialUrl,
		linkDialogIsEditing,
		enterInlineEdit,
		exitInlineEdit,
		handleInlineFormat,
		openLinkDialog,
		handleLinkApply,
		handleLinkRemove,
		closeLinkDialog,
	};
}
