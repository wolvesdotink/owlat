import { computed, watch, type Ref } from 'vue';
import { applyCoeditOps, type CoeditOp } from '@owlat/shared/coeditOps';
import type { BuilderCollabFocus, EditorBlock, RemoteBlockMark } from '../../types';
import { locateBlock } from '../../utils/blockTree';
import { plainClone } from '../../utils/plainClone';
import type { HistoryState, UseHistoryReturn } from '../useHistory';
import { canvasBlocksOf } from './useBuilderModel';
import type { useBuilderSelection } from './useBuilderSelection';

interface UseBuilderCoeditingOptions {
	canvasBlocks: Ref<EditorBlock[]>;
	formName: Ref<string>;
	formSubject: Ref<string>;
	history: Pick<UseHistoryReturn, 'commitPending' | 'absorb'>;
	selection: Pick<ReturnType<typeof useBuilderSelection>, 'selectedRootId' | 'isLockedRoot'>;
	/** The Block open in the inline editor, if any. */
	inlineEditBlockId: Ref<string | null>;
	clearSelection: () => void;
	/** Other people on root blocks, keyed by root block id (co-editing). */
	remoteMarks: () => Record<string, RemoteBlockMark> | undefined;
	emitCollabFocus: (focus: BuilderCollabFocus) => void;
}

/**
 * How the builder takes in state from outside while it is open: a host's
 * explicit load, other people's edits, and the focus it reports for their
 * presence outline and edit lease.
 */
export function useBuilderCoediting({
	canvasBlocks,
	formName,
	formSubject,
	history,
	selection,
	inlineEditBlockId,
	clearSelection,
	remoteMarks,
	emitCollabFocus,
}: UseBuilderCoeditingOptions) {
	const { selectedRootId, isLockedRoot } = selection;

	/**
	 * Replace the whole editing state at once — the explicit load path for a host
	 * that restores a version snapshot or follows a newer server copy.
	 *
	 * The `props.blocks` watcher deliberately ignores an incoming array whose
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
		history.commitPending();
		const blocks = canvasBlocksOf(state.blocks);
		if (JSON.stringify(blocks) !== JSON.stringify(canvasBlocks.value)) {
			canvasBlocks.value = blocks;
		}
		formName.value = state.name;
		formSubject.value = state.subject;
	}

	/**
	 * Apply another person's edits (co-editing). Unlike `loadState`, this keeps
	 * the selection, the open inline editor and the undo history: the history
	 * folds the change into every recorded state, so undo and redo keep moving
	 * through this editor's own steps only. A selection whose block was deleted
	 * is cleared.
	 */
	function applyRemoteOps(ops: readonly CoeditOp<EditorBlock>[]) {
		if (ops.length === 0) return;
		const transformWith =
			(applied: readonly CoeditOp<EditorBlock>[]) =>
			(state: HistoryState): HistoryState => {
				const next = applyCoeditOps(
					{ blocks: state.blocks, fields: { name: state.name, subject: state.subject } },
					applied
				);
				return {
					blocks: next.blocks as EditorBlock[],
					name: String(next.fields['name'] ?? state.name),
					subject: String(next.fields['subject'] ?? state.subject),
				};
			};
		// The canvas edits some blocks in place, so it and the history each get
		// their own copy of the incoming blocks, and the caller keeps its own.
		const copy = () => plainClone(ops) as CoeditOp<EditorBlock>[];
		history.absorb(transformWith(copy()));
		const next = transformWith(copy())({
			blocks: canvasBlocks.value,
			name: formName.value,
			subject: formSubject.value,
		});
		if (next.blocks !== canvasBlocks.value) canvasBlocks.value = next.blocks;
		formName.value = next.name;
		formSubject.value = next.subject;
		const rootId = selectedRootId.value;
		if (rootId && !canvasBlocks.value.some((block) => block.id === rootId)) clearSelection();
	}

	// Co-editing focus: which root is selected and which is open in the inline
	// editor, for the host's presence outline and edit lease.
	const inlineEditRootId = computed(() =>
		inlineEditBlockId.value
			? (locateBlock(canvasBlocks.value, inlineEditBlockId.value, selectedRootId.value)?.root.id ??
				null)
			: null
	);
	watch(
		[() => selectedRootId.value ?? null, inlineEditRootId],
		([selected, editing]) => {
			emitCollabFocus({ selectedRootId: selected, inlineEditRootId: editing });
		},
		{ immediate: true }
	);

	// Someone else took the block selected here (they started editing it first):
	// let go of it, unless its text is open here, which then commits as the later
	// write and the other person is told their change was replaced.
	watch(remoteMarks, () => {
		const rootId = selectedRootId.value;
		if (rootId && isLockedRoot(rootId) && inlineEditRootId.value !== rootId) clearSelection();
	});

	return { loadState, applyRemoteOps };
}
