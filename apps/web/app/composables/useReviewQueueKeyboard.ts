import { usePostboxListKeyboard } from '~/composables/postbox/usePostboxListKeyboard';
import { resolveAgentTaskShortcut } from '~/utils/agentTaskShortcuts';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import { resolveReviewShortcut } from '~/utils/reviewShortcuts';

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
}) {
	const { focusedIndex, activeId, onKeydown: listKeydown } = usePostboxListKeyboard<T>({
		items: opts.items,
		resetKey: opts.resetKey,
		rowDomId: opts.rowDomId,
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

	// Guard at the call site (the same place Postbox guards its reader handler):
	// while focus is in the inline compose input/textarea, keystrokes are the
	// user typing a reply, not triage — let them through untouched.
	function onKeydown(event: KeyboardEvent) {
		if (isEditableTarget(event.target)) return;
		listKeydown(event);
	}

	return { focusedIndex, activeId, onKeydown };
}
