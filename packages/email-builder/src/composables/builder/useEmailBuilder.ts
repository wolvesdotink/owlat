import { ref, computed, watch, provide, onMounted, nextTick } from 'vue';
import { prefersReducedMotion } from '@owlat/ui/composables/useReducedMotion';
import type {
	EditorBlock,
	BlockType,
	Variable,
	EmailBuilderConfig,
	EmailTheme,
	VariableType,
	RemoteBlockMark,
	BuilderCollabFocus,
} from '../../types';
import { locateBlock } from '../../utils/blockTree';
import { defaultTheme } from '../../defaults';
import { useEmailBuilderHandlers } from '../useEmailBuilderHandlers';
import { useFocusMode } from '../useFocusMode';
import { useBlockManagement } from '../useBlockManagement';
import { useRecentColors } from '../useRecentColors';
import { useHistory } from '../useHistory';
import { useInlineTextEdit } from '../useInlineTextEdit';
import { LINKED_BLOCK_INDEX_KEY, useLinkedBlocks } from '../useLinkedBlocks';
import { useSavedBlockPicker } from '../useSavedBlockPicker';
import { useSaveBlockModal } from '../useSaveBlockModal';
import { useSlashCommands } from '../useSlashCommands';
import { provideBlockRenderCache } from '../useBlockRenderer';
import { useBuilderModel } from './useBuilderModel';
import { useBuilderSelection } from './useBuilderSelection';
import { useBuilderBlockCommands } from './useBuilderBlockCommands';
import { useBuilderInsertCommands } from './useBuilderInsertCommands';
import { useBuilderBrandKit } from './useBuilderBrandKit';
import { useBuilderCoediting } from './useBuilderCoediting';
import { useBuilderPreview } from './useBuilderPreview';
import { useBuilderShortcuts } from './useBuilderShortcuts';
import { useDetachConfirm } from './useDetachConfirm';

export interface EmailBuilderProps {
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
	/**
	 * Other people on root blocks, keyed by root block id (co-editing). A
	 * locked block cannot be selected or edited here.
	 */
	remoteMarks?: Record<string, RemoteBlockMark>;
}

export interface EmailBuilderEmits {
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
	(e: 'collab-focus', value: BuilderCollabFocus): void;
}

/**
 * Everything EmailBuilder does, wired from the builder composables: the
 * editing state, selection, block commands, inline editing, history, brand
 * kit, co-editing, shortcuts, dialogs and preview. The component renders what
 * this returns.
 */
export function useEmailBuilder(props: EmailBuilderProps, emit: EmailBuilderEmits) {
	// Local state (synced with v-model props)
	const { canvasBlocks, formName, formSubject, emailBackgroundColor, blocksVersion, bumpBlocks } =
		useBuilderModel(props, emit);

	// ---------------------------------------------------------------------------
	// Configuration
	// ---------------------------------------------------------------------------
	const theme = computed<Required<EmailTheme>>(() => ({
		...defaultTheme,
		...props.config?.theme,
		backgroundColor: emailBackgroundColor.value,
	}));

	const variableType = computed<VariableType>(
		() => props.config?.variableType ?? 'personalization'
	);

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
	const linkedBlocks = useLinkedBlocks({ canvasBlocks, onTreeMutated: bumpBlocks });

	// Share the linked-block index with the canvas so both read one pass over the Blocks
	provide(LINKED_BLOCK_INDEX_KEY, linkedBlocks.index);

	// One fragment cache for the canvas previews, released with this editor
	provideBlockRenderCache();

	// Block selection
	const selection = useBuilderSelection({
		canvasBlocks,
		linkedBlocks,
		remoteMarks: () => props.remoteMarks,
	});
	const { blockState, activeBlock, selectedRootId } = selection;
	const {
		selectedBlockId,
		selectedBlock,
		blockElements,
		handleSelectBlock,
		clearSelection: clearBlockSelection,
	} = blockState;

	// Detaching a linked Block, after the user confirms
	const detach = useDetachConfirm({ linkedBlocks, selectedRootId });

	// Block CRUD (simplified: no TipTap cleanup callbacks)
	const blockManagement = useBlockManagement({
		canvasBlocks,
		selectedBlockId,
		theme,
		onTreeMutated: bumpBlocks,
	});

	// History
	const history = useHistory(canvasBlocks, formName, formSubject, {
		blocksVersion,
	});

	// Brand kit: swatches for the colour pickers, the logo and footer Blocks, and
	// the "Apply brand kit" restyle (one undoable step).
	const brandKit = useBuilderBrandKit({
		brand: computed(() => props.config?.brand),
		theme,
		allowedBlockTypes,
		canvasBlocks,
		commitPendingHistory: () => history.commitPending(),
		isRootHeld: selection.isLockedRoot,
		selectedRootId,
		handleSelectBlock,
		clearSelection,
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

	// Property writes, delete, duplicate, move and child commands on existing Blocks
	const blockCommands = useBuilderBlockCommands({
		canvasBlocks,
		theme,
		selection,
		linkedBlocks,
		blockManagement,
	});

	// Inline text editing
	const inlineEdit = useInlineTextEdit({
		activeBlock,
		onUpdate: blockCommands.handleBlockPropertyUpdate,
		onDeleteBlock: blockCommands.handleDeleteInlineEditedBlock,
	});
	const { inlineEditBlockId, inlineEditorRef, exitInlineEdit } = inlineEdit;

	/**
	 * Select the Block `blockId` (a root or a nested item) and scroll it into
	 * view, switching back from a preview to the canvas first. Hosts call it to
	 * point at a Block from outside the builder (the pre-send checks' "Show me").
	 * Returns false when no Block has that id.
	 */
	function selectBlock(blockId: string): boolean {
		const location = locateBlock(canvasBlocks.value, blockId);
		if (!location) return false;
		if (preview.previewMode.value !== 'edit') preview.previewMode.value = 'edit';
		if (location.parent) selection.selectNestedItem(location.root.id, blockId);
		else handleSelectBlock(blockId);
		nextTick(() => {
			blockElements.value.get(location.root.id)?.scrollIntoView({
				behavior: prefersReducedMotion() ? 'auto' : 'smooth',
				block: 'nearest',
			});
		});
		return true;
	}

	// A host's explicit load, other people's edits, and the focus reported to them
	const { loadState, applyRemoteOps } = useBuilderCoediting({
		canvasBlocks,
		formName,
		formSubject,
		history,
		selection,
		inlineEditBlockId,
		clearSelection,
		remoteMarks: () => props.remoteMarks,
		emitCollabFocus: (focus) => emit('collab-focus', focus),
	});

	// Saved block picker
	const savedBlockPicker = useSavedBlockPicker({ canvasBlocks, selectedBlockId });

	// Save-as-reusable-block modal. Only the root-selected block is offered (the
	// composable persists a single top-level block via handlers.savedBlocks.save).
	const saveBlockModal = useSaveBlockModal({ selectedBlock });

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

	// Global shortcuts and their help sheet
	const { showShortcutsDialog } = useBuilderShortcuts({
		isInlineEditing: inlineEdit.isInlineEditing,
		activeBlock,
		exitInlineEdit,
		undo: history.undo,
		redo: history.redo,
		moveBlock: blockCommands.handleMoveBlock,
		deleteActiveBlock: blockCommands.handleDeleteActiveBlock,
		duplicateActiveBlock: blockCommands.handleDuplicateActiveBlock,
	});

	// Slash commands — fetch saved blocks so they appear directly in the slash menu
	const { setSavedBlocks, setAllowedBlockTypes, setBrandBlocks } = useSlashCommands();

	// Keep the slash menu's insertable set in sync with the host config allowlist.
	watch(allowedBlockTypes, (types) => setAllowedBlockTypes(types), { immediate: true });
	watch(brandKit.insertableBrandBlocks, (kinds) => setBrandBlocks(kinds), { immediate: true });

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
		fetchSavedBlocksForSlashMenu();
	});

	// The rendered email and everything the previewer shows about it
	const preview = useBuilderPreview({
		canvasBlocks,
		blocksVersion,
		formSubject,
		theme,
		variableType,
		showMandatoryUnsubscribeFooter,
		variables: computed(() => props.variables),
	});

	// Sidebar, insert points, placeholder, inline editor and paste insertions
	const insertCommands = useBuilderInsertCommands({
		canvasBlocks,
		theme,
		selection,
		blockManagement,
		inlineEdit,
		handlers,
		handleSavedBlockSelect: savedBlockPicker.handleSavedBlockSelect,
		insertBrandBlocks: brandKit.insertBrandBlocks,
	});

	return {
		canvasBlocks,
		formName,
		formSubject,
		emailBackgroundColor,
		theme,
		showDataVariables,
		showVariableDialog,
		variableDialogKey,
		existingVariableKeys,
		openVariableDialog,
		handleVariableCreate,
		hideSubject,
		allowedBlockTypes,
		...selection,
		selectedBlockId,
		...detach,
		...history,
		...brandKit,
		isFocusMode,
		toggleFocusMode,
		exitFocusMode,
		showFocusHint,
		...blockCommands,
		...inlineEdit,
		selectBlock,
		loadState,
		applyRemoteOps,
		...savedBlockPicker,
		...saveBlockModal,
		canSaveAsBlock,
		clearSelection,
		showShortcutsDialog,
		...preview,
		...insertCommands,
	};
}
