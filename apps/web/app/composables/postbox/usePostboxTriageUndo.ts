/**
 * Undoable triage — "Archived — Undo" for archive/trash/move/spam.
 *
 * A triage action registers its inverse here after the mutation SUCCEEDS
 * (failure is already handled by usePostboxOptimisticHide restoring the
 * row). The registry keeps exactly ONE pending entry — registering a new
 * action replaces the previous toast; there is no undo stack. The entry is
 * surfaced through the shared useToast action button and can also be
 * invoked with Cmd/Ctrl+Z while focus is outside any text-entry surface
 * (the composer's editor owns its own undo history).
 *
 * Modeled on usePostboxUndoSend: a useState singleton holds the
 * serializable state; the inverse callback itself lives at module scope
 * because functions don't belong in a useState payload.
 */

import type { Id } from '@owlat/api/dataModel';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import { DEFAULT_OPTIMISTIC_UNDO_WINDOW_MS } from '~/composables/useOptimisticMutation';

/** Alias of the shared optimistic undo window — one source of truth for "undo is 8s". */
export const POSTBOX_TRIAGE_UNDO_WINDOW_MS = DEFAULT_OPTIMISTIC_UNDO_WINDOW_MS;

interface TriageUndoState {
	active: boolean;
	/** Absolute deadline; a Cmd+Z after this is ignored even if timers lag. */
	expiresAt: number;
	toastId: string | null;
}

export interface TriageMovedEntry {
	messageId: Id<'mailMessages'>;
	sourceFolderId: Id<'mailFolders'>;
}

/**
 * Group a move-family mutation's `moved` provenance into the inverse move
 * calls (one per distinct source folder, preserving message order).
 */
export function groupMovedBySourceFolder(
	moved: TriageMovedEntry[]
): Array<{ targetFolderId: Id<'mailFolders'>; messageIds: Id<'mailMessages'>[] }> {
	const byFolder = new Map<Id<'mailFolders'>, Id<'mailMessages'>[]>();
	for (const entry of moved) {
		const bucket = byFolder.get(entry.sourceFolderId) ?? [];
		bucket.push(entry.messageId);
		byFolder.set(entry.sourceFolderId, bucket);
	}
	return [...byFolder.entries()].map(([targetFolderId, messageIds]) => ({
		targetFolderId,
		messageIds,
	}));
}

// Single pending entry (by design): callback + timer at module scope.
let pendingInverse: (() => void | Promise<void>) | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

export function usePostboxTriageUndo() {
	const state = useState<TriageUndoState>('postbox:triage-undo', () => ({
		active: false,
		expiresAt: 0,
		toastId: null,
	}));
	const { showToast, removeToast } = useToast();

	/** Drop the pending entry (expiry, dismissal, or replacement). */
	function dismiss() {
		if (expiryTimer) {
			clearTimeout(expiryTimer);
			expiryTimer = null;
		}
		if (state.value.toastId) removeToast(state.value.toastId);
		pendingInverse = null;
		state.value = { active: false, expiresAt: 0, toastId: null };
	}

	/**
	 * Register a completed triage action's inverse. Replaces any previous
	 * entry (its toast disappears and its inverse becomes unreachable).
	 */
	function register(args: {
		/** Toast text, e.g. "Archived" / "Moved to Trash". */
		label: string;
		inverse: () => void | Promise<void>;
		windowMs?: number;
	}) {
		dismiss();
		const windowMs = args.windowMs ?? POSTBOX_TRIAGE_UNDO_WINDOW_MS;
		pendingInverse = args.inverse;
		const toastId = showToast(args.label, 'success', {
			durationMs: windowMs,
			action: {
				label: 'Undo',
				onAction: () => {
					void undo();
				},
			},
		});
		state.value = { active: true, expiresAt: Date.now() + windowMs, toastId };
		expiryTimer = setTimeout(dismiss, windowMs);
	}

	/**
	 * Run the pending inverse (at most once). Returns true when an undo was
	 * actually performed. The inverse's own failure surfaces through the
	 * caller's useBackendOperation error toast — nothing to roll back here.
	 */
	async function undo(): Promise<boolean> {
		if (!state.value.active || !pendingInverse) return false;
		if (Date.now() > state.value.expiresAt) {
			dismiss();
			return false;
		}
		const inverse = pendingInverse;
		dismiss();
		await inverse();
		return true;
	}

	/**
	 * Convenience for the dominant case: undo a move-family action by moving
	 * each message back to its source folder (grouped per folder), optionally
	 * preceded by a semantic inverse (e.g. notSpam) and followed by local
	 * cleanup (e.g. un-hiding optimistic rows).
	 */
	function registerMoveBack(args: {
		label: string;
		moved: TriageMovedEntry[];
		runMove: (args: {
			messageIds: Id<'mailMessages'>[];
			targetFolderId: Id<'mailFolders'>;
		}) => Promise<unknown>;
		before?: () => Promise<unknown> | void;
		after?: () => void;
	}) {
		if (args.moved.length === 0) return;
		register({
			label: args.label,
			inverse: async () => {
				if (args.before) await args.before();
				for (const group of groupMovedBySourceFolder(args.moved)) {
					await args.runMove({
						messageIds: group.messageIds,
						targetFolderId: group.targetFolderId,
					});
				}
				args.after?.();
			},
		});
	}

	/**
	 * Cmd/Ctrl+Z handler (registered on window by PostboxLayout). Inert while
	 * a composer/input/contenteditable has focus — the editor owns undo there
	 * — and when nothing is pending, so the browser default is untouched.
	 */
	function onWindowKeydown(event: KeyboardEvent) {
		if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
		if (event.key.toLowerCase() !== 'z') return;
		if (isEditableTarget(event.target)) return;
		if (!state.value.active) return;
		event.preventDefault();
		void undo();
	}

	return { state, register, registerMoveBack, undo, dismiss, onWindowKeydown };
}
