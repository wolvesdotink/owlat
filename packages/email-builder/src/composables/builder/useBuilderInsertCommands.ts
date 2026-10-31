import { nextTick, type ComputedRef, type Ref } from 'vue';
import { prefersReducedMotion } from '@owlat/ui/composables/useReducedMotion';
import type {
	BlockType,
	BrandBlockKind,
	EditorBlock,
	EmailBuilderHandlers,
	EmailTheme,
	ImageBlockContent,
	SavedBlock,
	SlashCommand,
} from '../../types';
import { withPrimaryStoredImage } from '../../utils/blocks';
import { blockSlot, type BlockSlot } from '../../utils/blockTree';
import { htmlToBlocks } from '../../utils/htmlToBlocks';
import { headingContent, type UseBlockManagementReturn } from '../useBlockManagement';
import type { UseInlineTextEditReturn } from '../useInlineTextEdit';
import type { useBuilderSelection } from './useBuilderSelection';

interface UseBuilderInsertCommandsOptions {
	canvasBlocks: Ref<EditorBlock[]>;
	theme: ComputedRef<Required<EmailTheme>>;
	selection: ReturnType<typeof useBuilderSelection>;
	blockManagement: Pick<UseBlockManagementReturn, 'handleAddBlock' | 'handleInsertBlockAtSlot'>;
	inlineEdit: Pick<
		UseInlineTextEditReturn,
		'enterInlineEdit' | 'exitInlineEdit' | 'openLinkDialog'
	>;
	handlers: EmailBuilderHandlers;
	handleSavedBlockSelect: (block: SavedBlock) => void;
	insertBrandBlocks: (kind: BrandBlockKind, index?: number) => void;
}

/**
 * Commands that put new Blocks on the canvas: from the sidebar, the insert
 * points, the placeholder, the inline editor (Enter, the slash menu) and
 * pasting, plus opening a text Block in the inline editor.
 */
export function useBuilderInsertCommands({
	canvasBlocks,
	theme,
	selection,
	blockManagement,
	inlineEdit,
	handlers,
	handleSavedBlockSelect,
	insertBrandBlocks,
}: UseBuilderInsertCommandsOptions) {
	const { blockState, selectedRootId, isEditable, selectNestedItem } = selection;
	const { selectedBlockId, handleSelectBlock, clearSelection: clearBlockSelection } = blockState;
	const { handleAddBlock, handleInsertBlockAtSlot } = blockManagement;
	const { enterInlineEdit, exitInlineEdit, openLinkDialog } = inlineEdit;

	// Inline edit handlers. Text at any depth is edited in place; text inside a
	// linked Block is not.
	function handleDoubleClickBlock(blockId: string) {
		if (!isEditable(blockId)) return;
		enterInlineEdit(blockId);
	}

	/**
	 * Insert a Block next to the text Block `sourceId` the inline editor has just
	 * closed on, at `source`, the slot it held while open: right after it in the
	 * list that holds it, or in its place when closing the editor removed it
	 * (it was left empty). The new Block is selected.
	 */
	function insertAfterInlineSource(
		source: BlockSlot,
		sourceId: string,
		type: BlockType,
		content?: (defaults: EditorBlock['content']) => EditorBlock['content']
	): EditorBlock | null {
		const current = blockSlot(canvasBlocks.value, sourceId, source.rootId);
		const slot = current ? { ...current, index: current.index + 1 } : source;
		const inserted = handleInsertBlockAtSlot(type, slot, content);
		if (!inserted) return null;
		if (inserted.parentId) selectNestedItem(inserted.parentId, inserted.block.id);
		else handleSelectBlock(inserted.block.id);
		return inserted.block;
	}

	function handleExitInlineEdit() {
		exitInlineEdit();
	}

	// Add text block from placeholder click
	function handleAddTextBlockFromPlaceholder() {
		const newBlock = handleAddBlock('text');
		// Clear default content so user starts with empty block
		const idx = canvasBlocks.value.findIndex((b) => b.id === newBlock.id);
		if (idx !== -1) {
			canvasBlocks.value[idx] = {
				...canvasBlocks.value[idx]!,
				content: { ...canvasBlocks.value[idx]!.content, html: '' },
			} as EditorBlock;
		}
		nextTick(() => {
			enterInlineEdit(newBlock.id);
			nextTick(() => {
				const el = blockState.blockElements.value.get(newBlock.id);
				el?.scrollIntoView({
					behavior: prefersReducedMotion() ? 'auto' : 'smooth',
					block: 'nearest',
				});
			});
		});
	}

	// Enter key in inline editor: create an empty text Block after the current
	// one, in the same list, and keep typing in it
	function handleInsertBlockAfter(blockId: string) {
		const source = isEditable(blockId)
			? blockSlot(canvasBlocks.value, blockId, selectedRootId.value)
			: null;
		exitInlineEdit();
		if (!source) return;
		const newBlock = insertAfterInlineSource(source, blockId, 'text', (defaults) => ({
			...defaults,
			html: '',
		}));
		if (!newBlock) return;
		nextTick(() => {
			enterInlineEdit(newBlock.id);
		});
	}

	// Open link dialog from inline editor
	function handleOpenLinkDialog(_blockId: string) {
		openLinkDialog();
	}

	// Paste image handler: create image block and upload
	async function handlePasteImage(file: File) {
		const newBlock = handleAddBlock('image');
		try {
			const result = await handlers.uploadImage(file);
			const idx = canvasBlocks.value.findIndex((b) => b.id === newBlock.id);
			if (idx !== -1) {
				canvasBlocks.value[idx] = {
					...canvasBlocks.value[idx]!,
					content: withPrimaryStoredImage(
						canvasBlocks.value[idx]!.content as ImageBlockContent,
						result
					),
				} as EditorBlock;
			}
		} catch {
			// Paste upload failed silently
		}
	}

	// Paste rich content handler: convert HTML to blocks and insert
	function handlePasteRichContent(html: string) {
		const blocks = htmlToBlocks(html, theme.value);
		if (blocks.length === 0) return;

		// Insert after selected block, or append to end
		const afterId = selectedBlockId.value ?? canvasBlocks.value[canvasBlocks.value.length - 1]?.id;

		let insertAfterId = afterId;
		for (const block of blocks) {
			const idx = insertAfterId
				? canvasBlocks.value.findIndex((b) => b.id === insertAfterId)
				: canvasBlocks.value.length - 1;
			canvasBlocks.value.splice(idx + 1, 0, block);
			insertAfterId = block.id;
		}

		selectedBlockId.value = blocks[blocks.length - 1]!.id;
	}

	// Add block from sidebar
	function handleAddBlockFromToolbar(type: BlockType) {
		handleAddBlock(type);
	}

	// Insert block at a specific position (from between-block insert points)
	function handleInsertBlockAt(type: BlockType, afterBlockId: string) {
		handleAddBlock(type, afterBlockId);
	}

	// Slash command handler: insert block after the block where "/" was typed,
	// in the list that holds it
	function handleSlashCommandSelect(command: SlashCommand, fromBlockId: string) {
		// Capture the slot before exitInlineEdit, which may auto-delete an empty
		// text block (e.g. one that only contained "/slash-text")
		const source = isEditable(fromBlockId)
			? blockSlot(canvasBlocks.value, fromBlockId, selectedRootId.value)
			: null;

		exitInlineEdit();
		if (!source) return;

		// Handle saved block direct insertion. A saved Block is linked, and linked
		// Blocks are roots: it goes after the root that holds the source, or for a
		// root source that closing removed, after the Block before it.
		if (command.savedBlock) {
			const anchorBlockId = source.parentId
				? source.rootId
				: canvasBlocks.value.some((b) => b.id === fromBlockId)
					? fromBlockId
					: (canvasBlocks.value[source.index - 1]?.id ?? null);
			// Select the anchor so handleSavedBlockSelect inserts after it
			clearBlockSelection();
			selectedBlockId.value = anchorBlockId;
			handleSavedBlockSelect(command.savedBlock);
			return;
		}

		// Brand kit Blocks are roots, placed like a saved Block: after the root
		// that holds the source, or where a root source that closing removed was.
		if (command.brandBlock) {
			const rootIndex = canvasBlocks.value.findIndex(
				(b) => b.id === (source.parentId ? source.rootId : fromBlockId)
			);
			insertBrandBlocks(command.brandBlock, rootIndex >= 0 ? rootIndex + 1 : source.index);
			return;
		}

		const headingMatch = command.id.match(/^h([123])$/);
		if (headingMatch) {
			const level = Number(headingMatch[1]) as 1 | 2 | 3;
			insertAfterInlineSource(source, fromBlockId, 'text', () =>
				headingContent(level, theme.value)
			);
		} else {
			insertAfterInlineSource(source, fromBlockId, command.id as BlockType);
		}
	}

	return {
		handleDoubleClickBlock,
		handleExitInlineEdit,
		handleAddTextBlockFromPlaceholder,
		handleInsertBlockAfter,
		handleOpenLinkDialog,
		handlePasteImage,
		handlePasteRichContent,
		handleAddBlockFromToolbar,
		handleInsertBlockAt,
		handleSlashCommandSelect,
	};
}
