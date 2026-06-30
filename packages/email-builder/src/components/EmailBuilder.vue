<script setup lang="ts">
/**
 * EmailBuilder — Notion-like inline document editor.
 *
 * Architecture:
 * - Single centered column (DocumentCanvas) with direct DOM previews
 * - BlockInsertToolbar: horizontal icon strip for quick block insertion
 * - SubjectFields: inline subject + name above canvas
 * - UnifiedToolbar: combined floating toolbar (formatting + settings)
 */
import { ref, computed, watch, provide, onMounted, onUnmounted, nextTick } from 'vue';
import type {
	EditorBlock,
	BlockType,
	Variable,
	EmailBuilderConfig,
	ColumnsBlockContent,
	ContainerBlockContent,
	HeroBlockContent,
	ContainerItem,
	ColumnItem,
	ImageBlockContent,
	SlashCommand,
	EmailTheme,
	VariableType,
} from '../types';
import type { ParentContext } from './canvas/types';

// Composables (kept from original)
import { useEmailBuilderHandlers } from '../composables/useEmailBuilderHandlers';
import { useFocusMode } from '../composables/useFocusMode';
import { useBlockState } from '../composables/useBlockState';
import { useBlockManagement } from '../composables/useBlockManagement';
import { useRecentColors } from '../composables/useRecentColors';
import { useHistory } from '../composables/useHistory';
import { useInlineTextEdit } from '../composables/useInlineTextEdit';
import { useLinkedBlocks } from '../composables/useLinkedBlocks';
import { useSavedBlockPicker } from '../composables/useSavedBlockPicker';
import { useSaveBlockModal } from '../composables/useSaveBlockModal';
import { useSlashCommands } from '../composables/useSlashCommands';
import { usePreview } from '../composables/usePreview';

// Render options surfaced in the preview's RenderOptionsPanel.
import type { PreviewRenderOptions } from '@owlat/email-previewer';

// Utilities
import { createBlock, createColumnItem } from '../utils/blocks';
import { htmlToBlocks } from '../utils/htmlToBlocks';
import { generateId } from '../utils/id';
import { setByPath } from '../utils/propertyPath';
import { defaultTheme, allBlockTypes } from '../defaults';
import { getBlock, getContainerItemTypes, getColumnItemTypes } from '../registry';

// Schema
import '../schema'; // Side-effect: registers all schemas
import { getSchema } from '../schema';

// Components
import EditorHeader from './EditorHeader.vue';
import FocusModeOverlay from './FocusModeOverlay.vue';
import PreviewPanel from './PreviewPanel.vue';
import DocumentCanvas from './canvas/DocumentCanvas.vue';
import FloatingBlockSidebar from './canvas/FloatingBlockSidebar.vue';
import SubjectFields from './canvas/SubjectFields.vue';
import UnifiedToolbar from './canvas/UnifiedToolbar.vue';
import { SaveBlockModal, UnsavedChangesDialog, LinkDialog, VariableCreateDialog } from './dialogs';
import SavedBlockPickerMenu from './canvas/SavedBlockPickerMenu.vue';
import UiConfirmationDialog from '@owlat/ui/components/ui/ConfirmationDialog.vue';

// ---------------------------------------------------------------------------
// Props & Emits (same interface as original EmailBuilder)
// ---------------------------------------------------------------------------
const props = defineProps<{
	blocks: EditorBlock[];
	subject: string;
	name: string;
	backgroundColor?: string;
	variables: Variable[];
	config?: EmailBuilderConfig;
	isSaving?: boolean;
}>();

const emit = defineEmits<{
	(e: 'update:blocks', value: EditorBlock[]): void;
	(e: 'update:subject', value: string): void;
	(e: 'update:name', value: string): void;
	(e: 'update:backgroundColor', value: string): void;
	(e: 'save'): void;
	(e: 'back'): void;
	(e: 'settings'): void;
	(e: 'send-test', html: string): void;
	(e: 'create-variable', variable: { key: string; type?: string }): void;
}>();

// ---------------------------------------------------------------------------
// Local state (synced with v-model props)
// ---------------------------------------------------------------------------
const canvasBlocks = ref<EditorBlock[]>([]);
const formName = ref('');
const formSubject = ref('');
const emailBackgroundColor = ref('#ffffff');

// Sync props → local
let lastEmittedBlocks: EditorBlock[] | null = null;

watch(() => props.blocks, (v) => {
	if (v === lastEmittedBlocks) return; // Skip echo from our own emit
	if (lastEmittedBlocks && v.length === lastEmittedBlocks.length &&
		v.every((b, i) => b.id === lastEmittedBlocks![i]!.id)) return;
	canvasBlocks.value = [...v];
}, { immediate: true });

watch(() => props.subject, (v) => { if (v !== formSubject.value) formSubject.value = v; }, { immediate: true });
watch(() => props.name, (v) => { if (v !== formName.value) formName.value = v; }, { immediate: true });
// Seed the background from an explicit page-supplied value, else the org theme's
// configured background — otherwise the hardcoded white default masked the org
// theme background in both the editor preview and the test-send.
watch(
	() => props.backgroundColor ?? props.config?.theme?.backgroundColor,
	(v) => { if (v && v !== emailBackgroundColor.value) emailBackgroundColor.value = v; },
	{ immediate: true },
);

// Emit local → props
watch(canvasBlocks, (v) => { lastEmittedBlocks = v; emit('update:blocks', v); }, { deep: true, flush: 'post' });
watch(formSubject, (v) => emit('update:subject', v));
watch(formName, (v) => emit('update:name', v));
watch(emailBackgroundColor, (v) => emit('update:backgroundColor', v));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const theme = computed<Required<EmailTheme>>(() => ({
	...defaultTheme,
	...props.config?.theme,
	backgroundColor: emailBackgroundColor.value,
}));

const variableType = computed<VariableType>(() => props.config?.variableType ?? 'personalization');

// Data-variable authoring. Only the transactional editor (variableType: 'data')
// lets the user DEFINE variables in-editor; marketing personalization variables
// are derived from contact fields, not user-created here. The dialog re-emits
// `create-variable` so the host page can persist it (api.transactional.emails.updateSchema).
const showDataVariables = computed(() => variableType.value === 'data');
const showVariableDialog = ref(false);
const existingVariableKeys = computed(() => props.variables.map((v) => v.key));

function openVariableDialog() {
	showVariableDialog.value = true;
}

function handleVariableCreate(variable: { key: string; type?: string }) {
	emit('create-variable', variable);
	showVariableDialog.value = false;
}

const showMandatoryUnsubscribeFooter = computed(() => props.config?.showMandatoryUnsubscribeFooter ?? false);
const hideSubject = computed(() => props.config?.hideSubject ?? true);

// Host-config allowlist for the insertable block palette. Threaded to the
// floating sidebar, the block-picker popover, and the slash menu so a
// constrained editor (e.g. transactional) can't insert blocks it disallows.
// Undefined means "all blocks" (the default).
const allowedBlockTypes = computed<BlockType[] | undefined>(() => props.config?.blockTypes);

// ---------------------------------------------------------------------------
// Composables
// ---------------------------------------------------------------------------
const handlers = useEmailBuilderHandlers();

// Linked blocks
const { isLinkedBlock, detachBlock, getLinkedGroupByBlockId, isFirstInGroup, isLastInGroup } = useLinkedBlocks({ canvasBlocks });

// Provide linked block helpers so CanvasBlock can access them without prop drilling
provide('isLinkedBlock', isLinkedBlock);
provide('isFirstInLinkedGroup', isFirstInGroup);
provide('isLastInLinkedGroup', isLastInGroup);
provide('requestDetachLinkedBlock', requestDetachBlock);

// Block selection
const blockState = useBlockState({ canvasBlocks });
const {
	selectedBlockId,
	selectedBlock,
	selectedColumnItemId,
	selectedColumnItem,
	selectedContainerItemId,
	selectedContainerItem,
	blockElements,
	handleSelectBlock,
	handleSelectColumnItem,
	handleSelectContainerItem,
	clearSelection: clearBlockSelection,
} = blockState;

// Provide setBlockElement for CanvasBlock element registration
provide('setBlockElement', blockState.setBlockElement);

// Active block: nested item takes priority over root selection
const activeBlock = computed<EditorBlock | null>(() => {
	return selectedColumnItem.value ?? selectedContainerItem.value ?? selectedBlock.value;
});

// The nested item ID for passing down to CanvasArea/CanvasBlock
const selectedNestedItemId = computed(() => {
	return selectedColumnItemId.value ?? selectedContainerItemId.value ?? null;
});

// Active block element for toolbar positioning
const activeBlockElement = computed<HTMLElement | null>(() => {
	if (!activeBlock.value) return null;
	return blockElements.value.get(activeBlock.value.id) || null;
});

// Active block schema
const activeBlockSchema = computed(() => {
	if (!activeBlock.value) return undefined;
	return getSchema(activeBlock.value.type);
});

// Linked block state for the active selection
const isActiveBlockLinked = computed(() => {
	if (selectedBlockId.value) return isLinkedBlock(selectedBlockId.value);
	if (blockState.selectedColumnContext.value) return isLinkedBlock(blockState.selectedColumnContext.value.blockId);
	if (blockState.selectedContainerContext.value) return isLinkedBlock(blockState.selectedContainerContext.value.blockId);
	return false;
});

const activeLinkedBlockName = computed<string | null>(() => {
	if (!isActiveBlockLinked.value) return null;
	const rootId = selectedBlockId.value
		?? blockState.selectedColumnContext.value?.blockId
		?? blockState.selectedContainerContext.value?.blockId;
	if (!rootId) return null;
	const group = getLinkedGroupByBlockId(rootId);
	return group?.blockName ?? null;
});

// Handle nested selection from CanvasArea
function handleSelectNested(payload: { itemId: string; context: ParentContext; element: HTMLElement }) {
	const { itemId, context, element } = payload;
	if (context.type === 'column') {
		handleSelectColumnItem(context.parentId, context.columnIndex, itemId, undefined, element);
	} else if (context.type === 'container') {
		handleSelectContainerItem(context.parentId, itemId, undefined, element);
	}
}

// Block CRUD (simplified: no TipTap cleanup callbacks)
const {
	handleAddBlock,
	handleAddHeadingBlock,
	handleDeleteBlock,
	handleDuplicateBlock,
	handleDuplicateColumnItem,
	handleDuplicateContainerItem,
	handleAddItemToColumn,
	handleDeleteColumnItem,
	handleDeleteContainerItem,
	handleColumnCountChange,
} = useBlockManagement({
	canvasBlocks,
	selectedBlockId,
	theme,
});

// History
const { canUndo, canRedo, undo, redo } = useHistory(canvasBlocks, formName, formSubject);

// Focus mode
const { isFocusMode, toggleFocusMode, exitFocusMode, setupKeyboardShortcut } = useFocusMode();
setupKeyboardShortcut();

// Focus mode hint (auto-dismiss after 2.5s)
const showFocusHint = ref(false);
let focusHintTimer: ReturnType<typeof setTimeout> | undefined;

watch(isFocusMode, (active) => {
	if (active) {
		showFocusHint.value = true;
		clearTimeout(focusHintTimer);
		focusHintTimer = setTimeout(() => { showFocusHint.value = false; }, 2500);
	} else {
		showFocusHint.value = false;
		clearTimeout(focusHintTimer);
	}
});

// Recent colors
const { recentBackgroundColors, addRecentBackgroundColor } = useRecentColors();
provide('recentColors', recentBackgroundColors);
provide('addRecentColor', addRecentBackgroundColor);

// Inline text editing
const {
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
} = useInlineTextEdit({
	activeBlock,
	onUpdate: handleBlockPropertyUpdate,
	onDeleteBlock: handleDeleteBlock,
});

// Saved block picker
const {
	savedBlockPickerState,
	openSavedBlockPicker,
	closeSavedBlockPicker,
	handleSavedBlockSelect,
} = useSavedBlockPicker({ canvasBlocks, selectedBlockId });

// Save-as-reusable-block modal. Only the root-selected block is offered (the
// composable persists a single top-level block via handlers.savedBlocks.save).
const {
	showSaveBlockModal,
	saveBlockName,
	isSavingBlock,
	openSaveBlockModal,
	closeSaveBlockModal,
	saveAsReusableBlock,
} = useSaveBlockModal({ selectedBlock });

// Whether the host wired a savedBlocks.save handler — gates the toolbar button.
const canSaveAsBlock = computed(() => Boolean(handlers.savedBlocks?.save));

// Provide registerInlineEditor for CanvasBlock to forward inline editor refs
provide('registerInlineEditor', (editorRef: { el: HTMLElement } | null) => {
	inlineEditorRef.value = editorRef;
});

// Wrap clearSelection to also exit inline edit
function clearSelection() {
	exitInlineEdit();
	clearBlockSelection();
}

// Simplified keyboard shortcuts (no TipTap dependencies)
function handleKeydown(event: KeyboardEvent) {
	const target = event.target as HTMLElement;
	const isEditable = target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);

	// Escape: exit inline edit first
	if (event.key === 'Escape' && isInlineEditing.value) {
		event.preventDefault();
		exitInlineEdit();
		return;
	}

	// Undo/Redo (Cmd/Ctrl+Z)
	if ((event.metaKey || event.ctrlKey) && event.key === 'z' && !isEditable) {
		event.preventDefault();
		if (event.shiftKey) redo();
		else undo();
		return;
	}

	if (isEditable) return;

	// Delete selected block
	if ((event.key === 'Delete' || event.key === 'Backspace') && activeBlock.value) {
		event.preventDefault();
		handleDeleteActiveBlock();
		return;
	}

	// Duplicate (Cmd/Ctrl+D)
	if ((event.metaKey || event.ctrlKey) && event.key === 'd' && activeBlock.value) {
		event.preventDefault();
		handleDuplicateBlock(activeBlock.value.id);
		return;
	}
}

// Slash commands — fetch saved blocks so they appear directly in the slash menu
const { setSavedBlocks, setAllowedBlockTypes } = useSlashCommands();

// Keep the slash menu's insertable set in sync with the host config allowlist.
watch(allowedBlockTypes, (types) => setAllowedBlockTypes(types), { immediate: true });

async function fetchSavedBlocksForSlashMenu() {
	if (!handlers.savedBlocks) return;
	try {
		const blocks = await handlers.savedBlocks.fetch();
		setSavedBlocks(blocks);
	} catch {
		// Fetch failed silently
	}
}

onMounted(() => {
	window.addEventListener('keydown', handleKeydown);
	fetchSavedBlocksForSlashMenu();
});
onUnmounted(() => window.removeEventListener('keydown', handleKeydown));

// Preview — driven entirely by usePreview, which wires the renderer's HTML /
// plain-text / AMP / analysis / diff generation through the user-controllable
// render options (base width, direction, custom CSS, web fonts, preheader,
// title, variables, minify, CSS inlining, …). The RenderOptionsPanel in the
// previewer emits update:render-options; we own the backing ref so every
// control actually re-renders the preview.
const renderOptions = ref<Partial<PreviewRenderOptions>>({});

const {
	previewMode,
	previewDarkMode,
	generatedHtml: previewHtml,
	isGeneratingHtml,
	plainText: previewPlainText,
	ampHtml: previewAmpHtml,
	renderWarnings: previewRenderWarnings,
	emailAnalysis: previewEmailAnalysis,
	healthScore: previewHealthScore,
	validationIssues: previewValidationIssues,
	emailDiff: previewEmailDiff,
	regenerate: regeneratePreview,
	togglePreviewMode,
} = usePreview({
	canvasBlocks,
	theme,
	variableType,
	showMandatoryUnsubscribeFooter,
	renderOptions,
});

// Keep the live editing reactivity the canvas had before: while a non-edit
// preview is open, re-render the moment the blocks change.
watch(canvasBlocks, () => {
	if (previewMode.value !== 'edit') regeneratePreview();
}, { deep: true });

// Dark-mode toggle from the previewer re-renders against the new mode.
function handlePreviewDarkMode(value: boolean) {
	previewDarkMode.value = value;
	if (previewMode.value !== 'edit') regeneratePreview();
}

// ---------------------------------------------------------------------------
// Block operations
// ---------------------------------------------------------------------------

/**
 * Find a nested block inside columns/containers and return its parent + mutator.
 */
function findNestedBlock(blockId: string): { parentIndex: number; mutate: (value: unknown, key: string) => void } | null {
	for (let i = 0; i < canvasBlocks.value.length; i++) {
		const block = canvasBlocks.value[i]!;
		if (block.type === 'columns') {
			const content = block.content as ColumnsBlockContent;
			for (let colIdx = 0; colIdx < content.columns.length; colIdx++) {
				const col = content.columns[colIdx]!;
				const itemIdx = col.findIndex((item) => item.id === blockId);
				if (itemIdx !== -1) {
					return {
						parentIndex: i,
						mutate: (value, key) => {
							const newColumns = content.columns.map((c, ci) => {
								if (ci !== colIdx) return c;
								return c.map((item, ii) => {
									if (ii !== itemIdx) return item;
									if (key.includes('.')) {
										const itemContent = setByPath(item.content as unknown as Record<string, unknown>, key, value);
										return { ...item, content: itemContent as unknown as ColumnItem['content'] };
									}
									return { ...item, content: { ...item.content, [key]: value } };
								});
							});
							canvasBlocks.value[i] = { ...block, content: { ...content, columns: newColumns } } as EditorBlock;
						},
					};
				}
			}
		}
		if (block.type === 'container' || block.type === 'hero') {
			const content = block.content as ContainerBlockContent;
			const itemIdx = content.items.findIndex((item) => item.id === blockId);
			if (itemIdx !== -1) {
				return {
					parentIndex: i,
					mutate: (value, key) => {
						const newItems = content.items.map((item, ii) => {
							if (ii !== itemIdx) return item;
							if (key.includes('.')) {
								const itemContent = setByPath(item.content as unknown as Record<string, unknown>, key, value);
								return { ...item, content: itemContent as unknown as ContainerItem['content'] };
							}
							return { ...item, content: { ...item.content, [key]: value } };
						});
						canvasBlocks.value[i] = { ...block, content: { ...content, items: newItems } } as EditorBlock;
					},
				};
			}
		}
	}
	return null;
}

function handleBlockPropertyUpdate(blockId: string, key: string, value: unknown) {
	// Block edits on linked blocks
	if (isLinkedBlock(blockId)) return;
	const nestedCheck = findNestedBlock(blockId);
	if (nestedCheck && canvasBlocks.value[nestedCheck.parentIndex]?.savedBlockRef) return;

	// Try root blocks first
	const blockIndex = canvasBlocks.value.findIndex((b) => b.id === blockId);
	if (blockIndex !== -1) {
		const block = canvasBlocks.value[blockIndex]!;

		// Support dot notation (e.g. 'labels.days')
		if (key.includes('.')) {
			const content = setByPath(block.content as unknown as Record<string, unknown>, key, value);
			canvasBlocks.value[blockIndex] = { ...block, content: content as unknown as EditorBlock['content'] } as EditorBlock;
		} else {
			canvasBlocks.value[blockIndex] = {
				...block,
				content: { ...block.content, [key]: value } as EditorBlock['content'],
			} as EditorBlock;
		}
		return;
	}

	// Fallback: search nested items in columns/containers
	const nested = findNestedBlock(blockId);
	if (nested) {
		nested.mutate(value, key);
	}
}

function handleDeleteActiveBlock() {
	if (!activeBlock.value) return;
	const blockId = activeBlock.value.id;

	// Check if it's a nested item
	if (selectedColumnItemId.value && blockState.selectedColumnContext.value) {
		const ctx = blockState.selectedColumnContext.value;
		handleDeleteColumnItem(ctx.blockId, ctx.columnIndex, blockId);
		clearBlockSelection();
	} else if (selectedContainerItemId.value && blockState.selectedContainerContext.value) {
		const ctx = blockState.selectedContainerContext.value;
		handleDeleteContainerItem(ctx.blockId, blockId);
		clearBlockSelection();
	} else {
		// If this block is part of a linked group, delete all blocks in the group
		const group = getLinkedGroupByBlockId(blockId);
		if (group) {
			// Delete in reverse index order to keep indices stable
			for (const idx of [...group.blockIndices].reverse()) {
				const block = canvasBlocks.value[idx];
				if (block) {
					handleDeleteBlock(block.id);
				}
			}
		} else {
			handleDeleteBlock(blockId);
		}
	}
}

function handleDuplicateActiveBlock() {
	if (!activeBlock.value) return;
	const blockId = activeBlock.value.id;

	if (selectedColumnItemId.value && blockState.selectedColumnContext.value) {
		// Duplicate within a column — delegate to the canonical handler so the
		// clone is deep (no shared nested references with the original).
		const ctx = blockState.selectedColumnContext.value;
		handleDuplicateColumnItem(ctx.blockId, ctx.columnIndex, blockId);
	} else if (selectedContainerItemId.value && blockState.selectedContainerContext.value) {
		// Duplicate within a container — delegate to the canonical handler so the
		// clone is deep AND nested container/column item IDs are regenerated.
		const ctx = blockState.selectedContainerContext.value;
		handleDuplicateContainerItem(ctx.blockId, blockId);
	} else {
		handleDuplicateBlock(blockId);
	}
}

function handleMoveBlock(direction: 'up' | 'down') {
	if (!activeBlock.value) return;
	const blockId = activeBlock.value.id;

	if (selectedColumnItemId.value && blockState.selectedColumnContext.value) {
		const ctx = blockState.selectedColumnContext.value;
		const block = canvasBlocks.value.find((b) => b.id === ctx.blockId);
		if (!block || block.type !== 'columns') return;
		const content = block.content as ColumnsBlockContent;
		const col = [...content.columns[ctx.columnIndex]!];
		const idx = col.findIndex((item) => item.id === blockId);
		if (idx === -1) return;
		const newIdx = direction === 'up' ? idx - 1 : idx + 1;
		if (newIdx < 0 || newIdx >= col.length) return;
		[col[idx], col[newIdx]] = [col[newIdx]!, col[idx]!];
		const newColumns = [...content.columns];
		newColumns[ctx.columnIndex] = col;
		const parentIdx = canvasBlocks.value.findIndex((b) => b.id === ctx.blockId);
		canvasBlocks.value[parentIdx] = { ...block, content: { ...content, columns: newColumns } } as EditorBlock;
	} else if (selectedContainerItemId.value && blockState.selectedContainerContext.value) {
		const ctx = blockState.selectedContainerContext.value;
		const block = canvasBlocks.value.find((b) => b.id === ctx.blockId);
		if (!block) return;
		const content = block.content as ContainerBlockContent;
		const items = [...content.items];
		const idx = items.findIndex((item) => item.id === blockId);
		if (idx === -1) return;
		const newIdx = direction === 'up' ? idx - 1 : idx + 1;
		if (newIdx < 0 || newIdx >= items.length) return;
		[items[idx], items[newIdx]] = [items[newIdx]!, items[idx]!];
		const parentIdx = canvasBlocks.value.findIndex((b) => b.id === ctx.blockId);
		canvasBlocks.value[parentIdx] = { ...block, content: { ...content, items } } as EditorBlock;
	} else {
		const idx = canvasBlocks.value.findIndex((b) => b.id === blockId);
		if (idx === -1) return;
		const newIdx = direction === 'up' ? idx - 1 : idx + 1;
		if (newIdx < 0 || newIdx >= canvasBlocks.value.length) return;
		const blocks = [...canvasBlocks.value];
		[blocks[idx], blocks[newIdx]] = [blocks[newIdx]!, blocks[idx]!];
		canvasBlocks.value = blocks;
	}
}

function handleAddChild(blockId: string, childType: BlockType) {
	const block = canvasBlocks.value.find((b) => b.id === blockId);
	if (!block) return;

	if (block.type === 'columns') {
		// Add to first column by default
		handleAddItemToColumn(blockId, 0, childType as ColumnItem['type']);
	} else if (block.type === 'container' || block.type === 'hero') {
		const content = block.content as ContainerBlockContent | HeroBlockContent;
		const newItem: ContainerItem = {
			id: generateId(),
			type: childType as ContainerItem['type'],
			content: createBlock(childType, theme.value).content as ContainerItem['content'],
		};
		const updatedItems = [...content.items, newItem];
		handleBlockPropertyUpdate(blockId, 'items', updatedItems);
	}
}

function handleRemoveChild(blockId: string, childId: string) {
	const block = canvasBlocks.value.find((b) => b.id === blockId);
	if (!block) return;

	if (block.type === 'container' || block.type === 'hero') {
		handleDeleteContainerItem(blockId, childId);
	} else if (block.type === 'columns') {
		const content = block.content as ColumnsBlockContent;
		for (let colIdx = 0; colIdx < content.columns.length; colIdx++) {
			const idx = content.columns[colIdx]!.findIndex((item) => item.id === childId);
			if (idx !== -1) {
				handleDeleteColumnItem(blockId, colIdx, childId);
				return;
			}
		}
	}
}

function handleUpdateChildren(blockId: string, children: unknown[]) {
	const block = canvasBlocks.value.find(b => b.id === blockId);
	const key = block?.type === 'columns' ? 'columns' : 'items';
	handleBlockPropertyUpdate(blockId, key, children);
}

function handleReorderChildren(blockId: string, children: unknown[]) {
	handleBlockPropertyUpdate(blockId, 'items', children);
}

// Image upload handler for PropertyPanel
async function handleUploadImage(file: File) {
	return handlers.uploadImage(file);
}

// Toolbar event handlers
function handleToolbarUpdate(blockId: string, key: string, value: unknown) {
	handleBlockPropertyUpdate(blockId, key, value);
}

function handleToolbarDelete() {
	handleDeleteActiveBlock();
}

function handleToolbarDuplicate() {
	handleDuplicateActiveBlock();
}


// Inline edit handlers
function handleDoubleClickBlock(blockId: string) {
	if (isActiveBlockLinked.value) return;
	enterInlineEdit(blockId);
}

function handleExitInlineEdit() {
	exitInlineEdit();
}

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
	const rootId = selectedBlockId.value
		?? blockState.selectedColumnContext.value?.blockId
		?? blockState.selectedContainerContext.value?.blockId;
	if (rootId) {
		requestDetachBlock(rootId);
	}
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
			el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
		});
	});
}

// Enter key in inline editor: create new text block after current
function handleInsertBlockAfter(blockId: string) {
	exitInlineEdit();
	const newBlock = handleAddBlock('text', blockId);
	// Clear HTML for empty start
	const idx = canvasBlocks.value.findIndex((b) => b.id === newBlock.id);
	if (idx !== -1) {
		canvasBlocks.value[idx] = {
			...canvasBlocks.value[idx]!,
			content: { ...canvasBlocks.value[idx]!.content, html: '' },
		} as EditorBlock;
	}
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
				content: { ...canvasBlocks.value[idx]!.content, src: result.url },
			} as EditorBlock;
		}
	} catch (error) {
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

// Canvas ref for sidebar positioning
const documentCanvasRef = ref<InstanceType<typeof DocumentCanvas> | null>(null);
const canvasInnerElement = computed(() => (documentCanvasRef.value?.canvasInnerElement ?? null) as HTMLElement | null);

// Add block from sidebar
function handleAddBlockFromToolbar(type: BlockType) {
	handleAddBlock(type);
}

// Insert block at a specific position (from between-block insert points)
function handleInsertBlockAt(type: BlockType, afterBlockId: string) {
	handleAddBlock(type, afterBlockId);
}

// Slash command handler: insert block after the block where "/" was typed
function handleSlashCommandSelect(command: SlashCommand, fromBlockId: string) {
	// Capture the block index before exitInlineEdit, which may auto-delete
	// an empty text block (e.g. one that only contained "/slash-text")
	const fromIndex = canvasBlocks.value.findIndex((b) => b.id === fromBlockId);

	exitInlineEdit();

	// After exitInlineEdit, the source block may have been deleted.
	// Find a stable insertion anchor: the block now at fromIndex - 1.
	const blockStillExists = canvasBlocks.value.some((b) => b.id === fromBlockId);
	const anchorBlockId = blockStillExists
		? fromBlockId
		: fromIndex > 0
			? canvasBlocks.value[fromIndex - 1]?.id ?? null
			: null;

	// Handle saved block direct insertion
	if (command.savedBlock) {
		// Set selectedBlockId so handleSavedBlockSelect inserts after the anchor
		selectedBlockId.value = anchorBlockId;
		handleSavedBlockSelect(command.savedBlock);
		return;
	}

	const afterId = anchorBlockId ?? undefined;
	const headingMatch = command.id.match(/^h([123])$/);
	if (headingMatch) {
		handleAddHeadingBlock(Number(headingMatch[1]) as 1 | 2 | 3, afterId);
	} else {
		handleAddBlock(command.id as BlockType, afterId);
	}
}
</script>

<template>
	<div class="light flex flex-col h-screen bg-bg-base">
		<!-- Header -->
		<div class="shrink-0 overflow-hidden transition-[max-height,opacity] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] max-h-20" :class="{ '!max-h-0 !opacity-0 !pointer-events-none': isFocusMode }">
			<EditorHeader
				:name="formName"
				:subject="formSubject"
				:preview-mode="previewMode"
				:is-focus-mode="isFocusMode"
				:is-saving="isSaving ?? false"
				:is-generating-html="isGeneratingHtml"
				:hide-subject="true"
				:config="config"
				:can-undo="canUndo"
				:can-redo="canRedo"
				@update:name="formName = $event"
				@update:subject="formSubject = $event"
				@toggle-preview="togglePreviewMode"
				@toggle-focus-mode="toggleFocusMode"
				@save="emit('save')"
				@back="emit('back')"
				@settings="emit('settings')"
				@undo="undo"
				@redo="redo"
			>
				<template v-if="$slots['toolbar-actions']" #toolbar-actions>
					<slot name="toolbar-actions" />
				</template>
			</EditorHeader>
		</div>

		<!-- Focus mode overlay -->
		<FocusModeOverlay
			v-if="isFocusMode"
			:is-focus-mode="isFocusMode"
			:show-hint="showFocusHint"
			:is-saving="isSaving ?? false"
			@exit="exitFocusMode"
		/>

		<!-- Main editor area: single column document canvas -->
		<div v-if="previewMode === 'edit'" class="flex-1 overflow-hidden flex">
			<DocumentCanvas
				ref="documentCanvasRef"
				:blocks="canvasBlocks"
				:selected-block-id="selectedBlockId"
				:selected-nested-item-id="selectedNestedItemId"
				:theme="theme"
				:background-color="emailBackgroundColor"
				:inline-edit-block-id="inlineEditBlockId"
				:variables="variables"
				:block-types="allowedBlockTypes"
				@update:blocks="canvasBlocks = $event"
				@select="handleSelectBlock"
				@select-nested="handleSelectNested"
				@clear-selection="clearSelection"
				@update-children="handleUpdateChildren"
				@double-click-block="handleDoubleClickBlock"
				@exit-inline-edit="handleExitInlineEdit"
				@slash-command-select="handleSlashCommandSelect"
				@add-text-block="handleAddTextBlockFromPlaceholder"
				@insert-block-after="handleInsertBlockAfter"
				@open-link-dialog="handleOpenLinkDialog"
				@paste-image="handlePasteImage"
				@paste-rich-content="handlePasteRichContent"
				@insert-block-at="handleInsertBlockAt"
				@update:background-color="emailBackgroundColor = $event"
				>
				<!-- Subject fields slot -->
				<template #subject-fields>
					<SubjectFields
						:name="formName"
						:subject="formSubject"
						:hide-subject="hideSubject"
						:mode="config?.mode"
						:show-data-variables="showDataVariables"
						:data-variables="variables"
						@update:name="formName = $event"
						@update:subject="formSubject = $event"
						@add-variable="openVariableDialog"
					/>
				</template>

				<!-- Forward after-canvas slot -->
				<template v-if="$slots['after-canvas']" #after-canvas>
					<slot name="after-canvas" />
				</template>
			</DocumentCanvas>

			<!-- Floating block sidebar (left of canvas) -->
			<FloatingBlockSidebar
				v-if="!isFocusMode"
				:canvas-element="canvasInnerElement"
				:visible="true"
				:block-types="allowedBlockTypes"
				@add-block="handleAddBlockFromToolbar"
			/>
		</div>

		<!-- Unified toolbar (format bar + settings popover combined) -->
		<UnifiedToolbar
			v-if="activeBlock && activeBlockElement && activeBlockSchema"
			:block="activeBlock"
			:anchor-element="activeBlockElement"
			:schema="activeBlockSchema"
			:is-inline-editing="isInlineEditing"
			:variables="variables"
			:theme="theme"
			:on-upload-image="handleUploadImage"
			:is-linked="isActiveBlockLinked"
			:linked-block-name="activeLinkedBlockName"
			:can-save-as-block="canSaveAsBlock && !!selectedBlockId"
			@update="handleToolbarUpdate"
			@format="handleInlineFormat"
			@delete="handleToolbarDelete"
			@duplicate="handleToolbarDuplicate"
			@detach="handleDetachActiveBlock"
			@save-block="openSaveBlockModal"
			@select-child="(_, childId) => handleSelectBlock(childId)"
			@add-child="handleAddChild"
			@remove-child="handleRemoveChild"
			@reorder-children="handleReorderChildren"
		/>

		<!-- Preview mode -->
		<div v-if="previewMode !== 'edit'" class="flex-1 overflow-hidden">
			<PreviewPanel
				:html="previewHtml"
				:subject="formSubject"
				:is-generating="isGeneratingHtml"
				:dark-mode="previewDarkMode"
				:plain-text="previewPlainText"
				:amp-html="previewAmpHtml"
				:render-warnings="previewRenderWarnings"
				:email-analysis="previewEmailAnalysis"
				:health-score="previewHealthScore"
				:validation-issues="previewValidationIssues"
				:email-diff="previewEmailDiff"
				:render-options="renderOptions"
				@update:render-options="renderOptions = $event"
				@update:dark-mode="handlePreviewDarkMode"
				@send-test="emit('send-test', previewHtml)"
			/>
		</div>

		<!-- Link dialog -->
		<LinkDialog
			v-if="showLinkDialog"
			:initial-url="linkDialogInitialUrl"
			:is-editing="linkDialogIsEditing"
			@apply="handleLinkApply"
			@remove="handleLinkRemove"
			@close="closeLinkDialog"
		/>

		<!-- Saved block picker -->
		<SavedBlockPickerMenu
			v-if="savedBlockPickerState.isOpen"
			:blocks="savedBlockPickerState.blocks"
			:is-loading="savedBlockPickerState.isLoading"
			:position="savedBlockPickerState.position"
			@select="handleSavedBlockSelect"
			@close="closeSavedBlockPicker"
		/>

		<!-- Save as reusable block dialog — captures the selected block into the
		     reusable-block library via the host-wired savedBlocks.save handler. -->
		<SaveBlockModal
			:show="showSaveBlockModal"
			:block-name="saveBlockName"
			:is-saving="isSavingBlock"
			@update:block-name="saveBlockName = $event"
			@save="saveAsReusableBlock"
			@close="closeSaveBlockModal"
		/>

		<!-- Add data variable dialog — the in-editor affordance to define a new
		     data variable. Emits create-variable so the host page persists it. -->
		<VariableCreateDialog
			:show="showVariableDialog"
			:existing-keys="existingVariableKeys"
			@create="handleVariableCreate"
			@close="showVariableDialog = false"
		/>

		<!-- Detach confirmation dialog -->
		<UiConfirmationDialog
			:open="showDetachConfirm"
			title="Detach linked block?"
			:description="`${pendingDetachBlockName || 'This block'} will no longer receive updates from the saved block library.`"
			confirm-text="Detach"
			cancel-text="Cancel"
			variant="warning"
			@confirm="confirmDetach"
			@cancel="cancelDetach"
			@update:open="!$event && cancelDetach()"
		/>
	</div>
</template>
