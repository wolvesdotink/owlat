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
// The builder's keyframes and variable-chip style load with the builder chunk,
// not with every page of the host app.
import '../styles/utilities.css';
import type {
	EditorBlock,
	BlockType,
	Variable,
	EmailBuilderConfig,
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
import { headingContent, useBlockManagement } from '../composables/useBlockManagement';
import { useBlockTreeVersion } from '../composables/useBlockTreeVersion';
import { useRecentColors } from '../composables/useRecentColors';
import { useHistory, type HistoryState } from '../composables/useHistory';
import { useInlineTextEdit } from '../composables/useInlineTextEdit';
import { LINKED_BLOCK_INDEX_KEY, useLinkedBlocks } from '../composables/useLinkedBlocks';
import { useSavedBlockPicker } from '../composables/useSavedBlockPicker';
import { useSaveBlockModal } from '../composables/useSaveBlockModal';
import { useSlashCommands } from '../composables/useSlashCommands';
import { usePreview } from '../composables/usePreview';

// Render options surfaced in the preview's RenderOptionsPanel.
import type { PreviewRenderOptions } from '../preview/types';

// Utilities
import { createBlock, createColumnItem, withPrimaryStoredImage } from '../utils/blocks';
import {
	blockSlot,
	locateBlock,
	locateWithin,
	replaceBlockInTree,
	type BlockSlot,
} from '../utils/blockTree';
import { moveBlock, type MoveDirection } from '../utils/blockMove';
import { resolveEditorKeyAction } from '../utils/editorKeyboard';
import { htmlToBlocks } from '../utils/htmlToBlocks';
import { generateId } from '../utils/id';
import { fillPreviewVariables } from '../utils/variables';
import { setByPath } from '../utils/propertyPath';
import { defaultTheme } from '../defaults';
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
import {
	SaveBlockModal,
	UnsavedChangesDialog,
	LinkDialog,
	VariableCreateDialog,
	KeyboardShortcutsDialog,
} from './dialogs';
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
	/**
	 * The author's manual text/plain body, persisted with the email. Empty string
	 * (the default) means "ship the body generated from the blocks". Pass it and
	 * handle `update:plainTextOverride` to enable the Text view's editor.
	 */
	plainTextOverride?: string;
	/** Whether this host persists a plain-text override. */
	allowPlainTextOverride?: boolean;
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
	(e: 'update:plainTextOverride', value: string): void;
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

watch(
	() => props.blocks,
	(v) => {
		if (v === lastEmittedBlocks) return; // Skip echo from our own emit
		if (
			lastEmittedBlocks &&
			v.length === lastEmittedBlocks.length &&
			v.every((b, i) => b.id === lastEmittedBlocks![i]!.id)
		)
			return;
		canvasBlocks.value = [...v];
	},
	{ immediate: true }
);

/**
 * Replace the whole editing state at once — the explicit load path for a host
 * that restores a version snapshot or follows a newer server copy.
 *
 * The `props.blocks` watcher above deliberately ignores an incoming array whose
 * block ids match what we last emitted: the host's live query echoes the saved
 * document back while the user keeps typing, and re-seeding the canvas from it
 * would drop those in-flight edits. A restore or a collaborator's edit usually
 * keeps the same block ids and changes only their content, so it looks exactly
 * like that echo — hence this second, unambiguous door.
 *
 * Blocks equal to the canvas are left alone, so a host may push every server
 * copy through here: its own save echoing back does not replace the block
 * objects under an open inline editor or add an undo step.
 *
 * An edit still inside the history debounce is committed first, so it stays
 * its own undo step instead of merging into the loaded state.
 */
function loadState(state: HistoryState) {
	commitPendingHistory();
	if (JSON.stringify(state.blocks) !== JSON.stringify(canvasBlocks.value)) {
		canvasBlocks.value = [...state.blocks];
	}
	formName.value = state.name;
	formSubject.value = state.subject;
}

watch(
	() => props.subject,
	(v) => {
		if (v !== formSubject.value) formSubject.value = v;
	},
	{ immediate: true }
);
watch(
	() => props.name,
	(v) => {
		if (v !== formName.value) formName.value = v;
	},
	{ immediate: true }
);
// Seed the background from an explicit page-supplied value, else the org theme's
// configured background — otherwise the hardcoded white default masked the org
// theme background in both the editor preview and the test-send.
watch(
	() => props.backgroundColor ?? props.config?.theme?.backgroundColor,
	(v) => {
		if (v && v !== emailBackgroundColor.value) emailBackgroundColor.value = v;
	},
	{ immediate: true }
);

// One counter for every change to the block tree; everything below that
// follows the canvas watches it instead of deep-watching the blocks.
const { version: blocksVersion, bump: bumpBlocks } = useBlockTreeVersion(canvasBlocks);

// Emit local → props
watch(
	blocksVersion,
	() => {
		lastEmittedBlocks = canvasBlocks.value;
		emit('update:blocks', canvasBlocks.value);
	},
	{ flush: 'post' }
);
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
// Prefill for the dialog when it opens from the subject's "Define <key>" hint.
const variableDialogKey = ref('');
const existingVariableKeys = computed(() => props.variables.map((v) => v.key));

function openVariableDialog(key?: string) {
	variableDialogKey.value = key ?? '';
	showVariableDialog.value = true;
}

function handleVariableCreate(variable: { key: string; type?: string }) {
	emit('create-variable', variable);
	showVariableDialog.value = false;
}

const showMandatoryUnsubscribeFooter = computed(
	() => props.config?.showMandatoryUnsubscribeFooter ?? false
);
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
const {
	index: linkedBlockIndex,
	isLinkedBlock,
	detachBlock,
	getLinkedGroupByBlockId,
} = useLinkedBlocks({ canvasBlocks, onTreeMutated: bumpBlocks });

// Share the linked-block index with the canvas so both read one pass over the Blocks
provide(LINKED_BLOCK_INDEX_KEY, linkedBlockIndex);
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

// Linked block state for the active selection. Linked-group state lives on
// the root Block, however deep the selection is.
const selectedRootId = blockState.selectedRootId;
const isActiveBlockLinked = computed(() =>
	selectedRootId.value ? isLinkedBlock(selectedRootId.value) : false
);

const activeLinkedBlockName = computed<string | null>(() => {
	if (!isActiveBlockLinked.value || !selectedRootId.value) return null;
	const group = getLinkedGroupByBlockId(selectedRootId.value);
	return group?.blockName ?? null;
});

/**
 * Whether the content of the Block `blockId` (a root or a nested item) may be
 * edited. A linked Block mirrors the saved-block library, so nothing inside
 * it is edited in place until it is detached.
 */
function isEditable(blockId: string): boolean {
	const location = locateBlock(canvasBlocks.value, blockId, selectedRootId.value);
	return !!location && !isLinkedBlock(location.root.id);
}

/**
 * Select the nested item `itemId`, found anywhere below the composite
 * `scopeId`. Inside a linked Block the root is selected instead: the group is
 * edited as a whole.
 */
function selectNestedItem(scopeId: string, itemId: string, element?: HTMLElement) {
	const location = locateWithin(canvasBlocks.value, scopeId, itemId);
	if (!location?.parent) return;
	if (isLinkedBlock(location.root.id)) {
		handleSelectBlock(location.root.id);
		return;
	}
	if (location.parent.type === 'columns') {
		handleSelectColumnItem(location.parent.id, location.listIndex, itemId, undefined, element);
	} else {
		handleSelectContainerItem(location.parent.id, itemId, undefined, element);
	}
}

// Handle nested selection from the canvas, at any depth
function handleSelectNested(payload: {
	itemId: string;
	context: ParentContext;
	element: HTMLElement;
}) {
	selectNestedItem(payload.context.parentId, payload.itemId, payload.element);
}

// Block CRUD (simplified: no TipTap cleanup callbacks)
const {
	handleAddBlock,
	handleInsertBlockAtSlot,
	handleDeleteBlock,
	handleDuplicateBlock,
	handleDuplicateNestedItem,
	handleAddItemToColumn,
	handleDeleteNestedItem,
} = useBlockManagement({
	canvasBlocks,
	selectedBlockId,
	theme,
	onTreeMutated: bumpBlocks,
});

// History
const {
	canUndo,
	canRedo,
	undo,
	redo,
	commitPending: commitPendingHistory,
} = useHistory(canvasBlocks, formName, formSubject, {
	blocksVersion,
});

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
		focusHintTimer = setTimeout(() => {
			showFocusHint.value = false;
		}, 2500);
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
	onDeleteBlock: handleDeleteInlineEditedBlock,
});

// `isInlineEditing` tells a host that text may be typed which the blocks do not
// hold yet (the inline editor commits when it closes), so replacing the canvas
// now would leave that text to be committed on top of whatever replaced it.
defineExpose({ loadState, isInlineEditing });

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
			handleMoveBlock(action.direction);
			break;
		case 'delete':
			handleDeleteActiveBlock();
			break;
		case 'duplicate':
			handleDuplicateActiveBlock();
			break;
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
	plainTextSource: previewPlainTextSource,
	ampHtml: previewAmpHtml,
	ampRequested: previewAmpRequested,
	renderWarnings: previewRenderWarnings,
	emailAnalysis: previewEmailAnalysis,
	healthScore: previewHealthScore,
	validationIssues: previewValidationIssues,
	emailDiff: previewEmailDiff,
	regenerate: regeneratePreview,
	regenerateHtml: regeneratePreviewHtml,
	togglePreviewMode,
} = usePreview({
	canvasBlocks,
	theme,
	variableType,
	showMandatoryUnsubscribeFooter,
	renderOptions,
	variables: computed(() => props.variables),
});

// The preview fills the subject's tokens the way it fills the body's, so the
// inbox line reads "Alex invited you" instead of "{{inviterName}} invited you".
const previewSubject = computed(() =>
	fillPreviewVariables(formSubject.value, {
		values: renderOptions.value.variableValues ?? {},
		labels: Object.fromEntries(props.variables.map((v) => [v.key, v.label])),
	})
);

// Keep the live editing reactivity the canvas had before: while a non-edit
// preview is open, re-render the moment the blocks change.
watch(blocksVersion, () => {
	if (previewMode.value !== 'edit') regeneratePreview();
});

// Dark-mode toggle from the previewer re-renders the HTML against the new mode;
// plain text, AMP and Block validation do not depend on it.
function handlePreviewDarkMode(value: boolean) {
	previewDarkMode.value = value;
	if (previewMode.value !== 'edit') regeneratePreviewHtml();
}

// ---------------------------------------------------------------------------
// Block operations
// ---------------------------------------------------------------------------

/**
 * Write one property of a Block, a root or a nested item at any depth. The
 * root and the composites on the path are replaced rather than mutated, so the
 * edit lands as one write to the root array. A dotted key (`labels.days`)
 * writes a nested property.
 */
function handleBlockPropertyUpdate(blockId: string, key: string, value: unknown) {
	if (!isEditable(blockId)) return;
	const replaced = replaceBlockInTree(
		canvasBlocks.value,
		blockId,
		(block) =>
			({
				...block,
				content: (key.includes('.')
					? setByPath(block.content as unknown as Record<string, unknown>, key, value)
					: { ...block.content, [key]: value }) as unknown as EditorBlock['content'],
			}) as EditorBlock,
		selectedRootId.value
	);
	if (replaced) canvasBlocks.value[replaced.rootIndex] = replaced.root;
}

function handleDeleteActiveBlock() {
	if (!activeBlock.value) return;
	const blockId = activeBlock.value.id;

	// A nested item, at any depth
	const scope =
		blockState.selectedColumnContext.value ?? blockState.selectedContainerContext.value;
	if (selectedNestedItemId.value && scope) {
		if (isEditable(scope.blockId)) handleDeleteNestedItem(scope.blockId, blockId);
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

	// A nested item is copied next to itself, at any depth. The canonical
	// handler deep-clones it and gives it and everything inside it fresh ids.
	const scope =
		blockState.selectedColumnContext.value ?? blockState.selectedContainerContext.value;
	if (selectedNestedItemId.value && scope) {
		if (isEditable(scope.blockId)) handleDuplicateNestedItem(scope.blockId, blockId);
	} else {
		handleDuplicateBlock(blockId);
	}
}

function handleMoveBlock(direction: MoveDirection) {
	if (!activeBlock.value) return;

	// One whole-array write, whatever level the moved item lives at, so the
	// history watcher records the move as a single undoable step. Items inside
	// a linked Block keep their order.
	if (selectedNestedItemId.value && selectedRootId.value && isLinkedBlock(selectedRootId.value))
		return;
	const moved = moveBlock(
		canvasBlocks.value,
		{
			itemId: activeBlock.value.id,
			column: selectedColumnItemId.value ? blockState.selectedColumnContext.value : null,
			container: selectedContainerItemId.value ? blockState.selectedContainerContext.value : null,
		},
		direction
	);
	if (moved) canvasBlocks.value = moved;
}

// Child-panel commands for the active composite, which may itself be nested.
// Where a new child goes and which defaults it gets is the composite's
// placement: column items take the compact column defaults.
function handleAddChild(blockId: string, childType: BlockType) {
	if (!isEditable(blockId)) return;
	const block = locateBlock(canvasBlocks.value, blockId, selectedRootId.value)?.block;
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
	if (isEditable(blockId)) handleDeleteNestedItem(blockId, childId);
}

function handleSelectChild(blockId: string, childId: string) {
	selectNestedItem(blockId, childId);
}

function handleUpdateChildren(blockId: string, children: unknown[]) {
	const block = locateBlock(canvasBlocks.value, blockId, selectedRootId.value)?.block;
	if (!block) return;
	const key = block.type === 'columns' ? 'columns' : 'items';
	handleBlockPropertyUpdate(blockId, key, children);
}

function handleReorderChildren(blockId: string, children: unknown[]) {
	handleBlockPropertyUpdate(blockId, 'items', children);
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

// Inline edit handlers. Text at any depth is edited in place; text inside a
// linked Block is not.
function handleDoubleClickBlock(blockId: string) {
	if (!isEditable(blockId)) return;
	enterInlineEdit(blockId);
}

// The inline editor removes a text Block it closes empty, root or nested.
function handleDeleteInlineEditedBlock(blockId: string) {
	const location = locateBlock(canvasBlocks.value, blockId, selectedRootId.value);
	if (!location) return;
	if (!location.parent) {
		handleDeleteBlock(blockId);
		return;
	}
	if (!isEditable(blockId)) return;
	handleDeleteNestedItem(location.parent.id, blockId);
	if (selectedNestedItemId.value === blockId) clearBlockSelection();
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
const canvasInnerElement = computed(
	() => (documentCanvasRef.value?.canvasInnerElement ?? null) as HTMLElement | null
);

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

	const headingMatch = command.id.match(/^h([123])$/);
	if (headingMatch) {
		const level = Number(headingMatch[1]) as 1 | 2 | 3;
		insertAfterInlineSource(source, fromBlockId, 'text', () => headingContent(level));
	} else {
		insertAfterInlineSource(source, fromBlockId, command.id as BlockType);
	}
}
</script>

<template>
	<div class="light flex flex-col h-full bg-bg-base">
		<!-- Header -->
		<div
			class="shrink-0 overflow-hidden transition-[max-height,opacity] duration-(--motion-moderate) ease-spring max-h-20"
			:class="{ '!max-h-0 !opacity-0 !pointer-events-none': isFocusMode }"
		>
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
				@show-shortcuts="showShortcutsDialog = true"
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
						:variables="variables"
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
			:is-linked="isActiveBlockLinked"
			:linked-block-name="activeLinkedBlockName"
			:can-save-as-block="canSaveAsBlock && !!selectedBlockId"
			@update="handleToolbarUpdate"
			@format="handleInlineFormat"
			@delete="handleToolbarDelete"
			@duplicate="handleToolbarDuplicate"
			@detach="handleDetachActiveBlock"
			@save-block="openSaveBlockModal"
			@select-child="handleSelectChild"
			@add-child="handleAddChild"
			@remove-child="handleRemoveChild"
			@reorder-children="handleReorderChildren"
		/>

		<!-- Preview mode -->
		<div v-if="previewMode !== 'edit'" class="flex-1 overflow-hidden">
			<PreviewPanel
				:html="previewHtml"
				:subject="previewSubject"
				:is-generating="isGeneratingHtml"
				:dark-mode="previewDarkMode"
				:plain-text="previewPlainText"
				:plain-text-source="previewPlainTextSource"
				:plain-text-override="props.plainTextOverride ?? ''"
				:allow-plain-text-override="props.allowPlainTextOverride ?? false"
				:amp-html="previewAmpHtml"
				amp-available
				:render-warnings="previewRenderWarnings"
				:email-analysis="previewEmailAnalysis"
				:health-score="previewHealthScore"
				:validation-issues="previewValidationIssues"
				:email-diff="previewEmailDiff"
				:render-options="renderOptions"
				@update:render-options="renderOptions = $event"
				@update:dark-mode="handlePreviewDarkMode"
				@update:amp-requested="previewAmpRequested = $event"
				@send-test="emit('send-test', previewHtml)"
				@update:plain-text-override="emit('update:plainTextOverride', $event)"
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
			:initial-key="variableDialogKey"
			:existing-keys="existingVariableKeys"
			@create="handleVariableCreate"
			@close="showVariableDialog = false"
		/>

		<!-- Keyboard shortcuts help sheet -->
		<KeyboardShortcutsDialog :show="showShortcutsDialog" @close="showShortcutsDialog = false" />

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
