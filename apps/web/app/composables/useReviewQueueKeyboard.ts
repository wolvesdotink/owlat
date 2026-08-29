import { usePostboxListKeyboard } from '~/composables/postbox/usePostboxListKeyboard';
import { resolveAgentTaskShortcut } from '~/utils/agentTaskShortcuts';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import { resolveReviewSelectShortcut, resolveReviewShortcut } from '~/utils/reviewShortcuts';
import { pushShortcutScope } from '~/utils/shortcutScope';

/**
 * Keyboard-first navigation for the agent Review Queue, built by REUSING the
 * proven Postbox house composables rather than forking them:
 *
 * - `usePostboxListKeyboard` supplies j/k (+ arrows) focus movement, Enter to
 *   activate, single-key action delegation, focus that survives live Convex
 *   updates, and the Cmd/Ctrl/Alt-chord filter.
 * - `isEditableTarget` (utils/postboxShortcuts) keeps every key inert while a
 *   text input / textarea / contenteditable is focused — so typing a reply into
 *   the inline compose box never approves or rejects a draft.
 * - `resolveReviewShortcut` maps the review vocabulary: a → approve (send),
 *   e → edit, x/# → reject, s → skip (non-destructive: focus the next card).
 * - `resolveAgentTaskShortcut` (the shared agent-task-card vocabulary) adds
 *   1–9 → pick the matching option chip on the focused card.
 *
 * FAIL-SOFT: this is purely an input layer. Every action is dispatched to the
 * SAME callbacks the on-screen buttons already call (which route through the
 * existing undo-guarded send / edit / reject flow), so a mis-key is exactly as
 * recoverable as a mis-click and no new send path is introduced. `approve` is
 * only offered for rows the caller marks approvable (a draft exists); otherwise
 * it falls back to opening the thread.
 */
export function useReviewQueueKeyboard<T extends { _id: string }>(opts: {
	items: Ref<T[]>;
	resetKey: Ref<unknown>;
	rowDomId: (row: T) => string;
	/** Enter — open the draft/thread for a closer look. */
	onOpen: (row: T) => void;
	/** a — approve & send through the existing undo-guarded send flow. */
	onApprove: (row: T) => void;
	/** e — jump to the thread to edit the draft before sending. */
	onEdit: (row: T) => void;
	/** x / # — reject the draft. */
	onReject: (row: T) => void;
	/** 1–9 — pick the matching option chip on the focused card (optional). */
	onPickOption?: (row: T, index: number) => void;
	/**
	 * Multi-select model (piece C2, optional). When provided, the selection
	 * vocabulary is resolved BEFORE the single-card keys — so Space/`x` toggle
	 * the focused card (`x` no longer rejects; `#` still does), Shift+J/K select
	 * the focused + next/previous card while moving focus, and `*` selects all
	 * visible. Surfaces without a selection model (the focus flow) are untouched.
	 */
	selection?: {
		toggle: (row: T) => void;
		selectMany: (rows: T[]) => void;
		selectAllVisible: () => void;
	};
}) {
	const {
		focusedIndex,
		activeId,
		onKeydown: listKeydown,
	} = usePostboxListKeyboard<T>({
		items: opts.items,
		resetKey: opts.resetKey,
		rowDomId: opts.rowDomId,
		// Movement resolves against the `review` half of the catalog, so a
		// Postbox remap of j/k does not silently move this queue too.
		scope: 'review',
		onActivate: opts.onOpen,
		onAction: (key, row) => {
			// The shared agent-task-card vocabulary first: digits pick a chip.
			const taskShortcut = resolveAgentTaskShortcut(key);
			if (taskShortcut?.type === 'chip') {
				opts.onPickOption?.(row, taskShortcut.index);
				return;
			}
			switch (resolveReviewShortcut(key)) {
				case 'approve':
					opts.onApprove(row);
					break;
				case 'edit':
					opts.onEdit(row);
					break;
				case 'reject':
					opts.onReject(row);
					break;
				case 'skip':
					// Non-destructive: leave the card for later, focus the next one.
					focusedIndex.value = Math.min(focusedIndex.value + 1, opts.items.value.length - 1);
					break;
			}
		},
	});

	// The multi-select layer runs ahead of the reused list keyboard so its keys
	// never double as triage keys. Returns true when the event was claimed.
	function handleSelectionKey(event: KeyboardEvent): boolean {
		const selection = opts.selection;
		if (!selection) return false;
		// Never claim a Cmd/Ctrl/Alt chord (browser shortcut) as selection.
		if (event.metaKey || event.ctrlKey || event.altKey) return false;
		const action = resolveReviewSelectShortcut(event.key);
		if (!action) return false;

		const items = opts.items.value;
		const focused = items[focusedIndex.value];
		switch (action) {
			case 'toggleSelect':
				if (!focused) return false;
				// Space would otherwise scroll the listbox.
				event.preventDefault();
				selection.toggle(focused);
				return true;
			case 'extendSelectDown':
			case 'extendSelectUp': {
				if (!focused) return false;
				event.preventDefault();
				const nextIndex =
					action === 'extendSelectDown'
						? Math.min(focusedIndex.value + 1, items.length - 1)
						: Math.max(focusedIndex.value - 1, 0);
				const next = items[nextIndex];
				selection.selectMany(next && next !== focused ? [focused, next] : [focused]);
				focusedIndex.value = nextIndex;
				return true;
			}
			case 'selectAllVisible':
				event.preventDefault();
				selection.selectAllVisible();
				return true;
		}
	}

	// Guard at the call site (the same place Postbox guards its reader handler):
	// while focus is in the inline compose input/textarea, keystrokes are the
	// user typing a reply, not triage — let them through untouched.
	function onKeydown(event: KeyboardEvent) {
		if (isEditableTarget(event.target)) return;
		if (handleSelectionKey(event)) return;
		listKeydown(event);
	}

	// Claim the `review` scope of the shortcut registry while the queue is
	// mounted, so its keys shadow the app-wide map (`s` is Skip here, not Save)
	// and the cheat sheet documents this surface rather than the one underneath.
	let releaseScope: (() => void) | null = null;
	onMounted(() => {
		releaseScope = pushShortcutScope('review');
	});
	onBeforeUnmount(() => {
		releaseScope?.();
		releaseScope = null;
	});

	return { focusedIndex, activeId, onKeydown };
}
