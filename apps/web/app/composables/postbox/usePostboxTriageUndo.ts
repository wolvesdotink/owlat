/**
 * Undoable triage — "Archived — Undo" for archive/trash/move/spam.
 *
 * A triage action registers its inverse here after the mutation SUCCEEDS
 * (failure is already handled by usePostboxOptimisticHide restoring the
 * row). The registry is a bounded LIFO STACK (utils/postboxUndoStack.ts): up
 * to ten actions stay reversible at once, each with its own deadline, and
 * repeated Cmd/Ctrl+Z walks a triage burst back newest-first. It used to keep
 * exactly one slot, so archiving three messages in a row left only the third
 * undoable and the second Cmd+Z did nothing.
 *
 * Every entry gets its own toast with an Undo action; taking an entry (by
 * button or by keyboard) removes that toast, and an entry that expires or is
 * evicted takes its toast and its callback with it.
 *
 * The Cmd/Ctrl+Z listener is installed APP-WIDE by this module the moment the
 * stack becomes non-empty and removed again when it empties — no surface has
 * to remember to bind it, and there is exactly one binding however many
 * components hold the composable (two bindings would undo two entries per
 * keypress).
 *
 * Modeled on usePostboxUndoSend: a useState singleton holds the serializable
 * state; the inverse callbacks live at module scope because functions don't
 * belong in a useState payload.
 */

import type { Id } from '@owlat/api/dataModel';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import {
	popUndoEntry,
	pruneUndoStack,
	pushUndoEntry,
	POSTBOX_UNDO_STACK_LIMIT,
	type PostboxUndoEntry,
} from '~/utils/postboxUndoStack';
import { DEFAULT_OPTIMISTIC_UNDO_WINDOW_MS } from '~/composables/useOptimisticMutation';

/** Alias of the shared optimistic undo window — one source of truth for "undo is 8s". */
export const POSTBOX_TRIAGE_UNDO_WINDOW_MS = DEFAULT_OPTIMISTIC_UNDO_WINDOW_MS;

export { POSTBOX_UNDO_STACK_LIMIT };

/** One stacked entry, as it travels through `useState`. */
export interface TriageUndoEntry extends PostboxUndoEntry {
	/** Toast text, e.g. "Archived" / "Moved to Trash". */
	label: string;
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

// Callbacks + timers keyed by entry id, at module scope: functions and timer
// handles have no business inside a useState payload.
const inverses = new Map<string, () => void | Promise<void>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let entrySeq = 0;

// The single app-wide Cmd/Ctrl+Z binding, installed while entries are pending.
let boundHotkey: ((event: KeyboardEvent) => void) | null = null;

export function usePostboxTriageUndo() {
	const entries = useState<TriageUndoEntry[]>('postbox:triage-undo', () => []);
	const { showToast, removeToast } = useToast();
	const { t } = useI18n();

	/** Forget an entry's side tables (toast, callback, expiry timer). */
	function releaseEntry(entry: TriageUndoEntry) {
		const timer = timers.get(entry.id);
		if (timer) {
			clearTimeout(timer);
			timers.delete(entry.id);
		}
		inverses.delete(entry.id);
		if (entry.toastId) removeToast(entry.toastId);
	}

	function syncHotkey() {
		if (import.meta.server) return;
		const wanted = entries.value.length > 0;
		if (wanted && !boundHotkey) {
			boundHotkey = onWindowKeydown;
			window.addEventListener('keydown', boundHotkey);
		} else if (!wanted && boundHotkey) {
			window.removeEventListener('keydown', boundHotkey);
			boundHotkey = null;
		}
	}

	/** Drop every pending entry (used on teardown and by the tests). */
	function dismiss() {
		for (const entry of entries.value) releaseEntry(entry);
		entries.value = [];
		syncHotkey();
	}

	/** Drop expired entries — also called before every read of the stack. */
	function prune() {
		const { stack, expired } = pruneUndoStack(entries.value, Date.now());
		if (expired.length === 0) return;
		for (const entry of expired) releaseEntry(entry);
		entries.value = stack;
		syncHotkey();
	}

	/**
	 * Register a completed triage action's inverse on top of the stack. The
	 * oldest entry is evicted once the stack is full; nothing is ever refused.
	 */
	function register(args: {
		/** Toast text, e.g. "Archived" / "Moved to Trash". */
		label: string;
		inverse: () => void | Promise<void>;
		windowMs?: number;
	}) {
		const windowMs = args.windowMs ?? POSTBOX_TRIAGE_UNDO_WINDOW_MS;
		const now = Date.now();
		const id = `undo-${++entrySeq}`;
		const toastId = showToast(args.label, 'success', {
			durationMs: windowMs,
			action: {
				label: t('shared.postbox.usePostboxTriageUndo.undo'),
				onAction: () => {
					void undoEntry(id);
				},
			},
		});
		const entry: TriageUndoEntry = { id, label: args.label, expiresAt: now + windowMs, toastId };
		inverses.set(id, args.inverse);
		const { stack, evicted } = pushUndoEntry(entries.value, entry, now);
		for (const gone of evicted) releaseEntry(gone);
		entries.value = stack;
		timers.set(
			id,
			setTimeout(() => prune(), windowMs)
		);
		syncHotkey();
	}

	/** Run one entry's inverse and take it off the stack. */
	async function undoEntry(id: string): Promise<boolean> {
		prune();
		const entry = entries.value.find((e) => e.id === id);
		if (!entry) return false;
		const inverse = inverses.get(id);
		entries.value = entries.value.filter((e) => e.id !== id);
		releaseEntry(entry);
		syncHotkey();
		if (!inverse) return false;
		await inverse();
		return true;
	}

	/**
	 * Run the newest pending inverse (at most once each). Returns true when an
	 * undo was actually performed. The inverse's own failure surfaces through
	 * the caller's useBackendOperation error toast — nothing to roll back here.
	 */
	async function undo(): Promise<boolean> {
		const { stack, entry, expired } = popUndoEntry(entries.value, Date.now());
		for (const gone of expired) releaseEntry(gone);
		if (!entry) {
			entries.value = stack;
			syncHotkey();
			return false;
		}
		const inverse = inverses.get(entry.id);
		entries.value = stack;
		releaseEntry(entry);
		syncHotkey();
		if (!inverse) return false;
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
	 * Cmd/Ctrl+Z handler. Bound app-wide by this module while entries are
	 * pending (see `syncHotkey`) — surfaces do not bind it themselves. Inert
	 * while a composer/input/contenteditable has focus — the editor owns undo
	 * there — and when nothing is pending, so the browser default is untouched.
	 */
	function onWindowKeydown(event: KeyboardEvent) {
		if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
		if (event.key.toLowerCase() !== 'z') return;
		if (isEditableTarget(event.target)) return;
		prune();
		if (entries.value.length === 0) return;
		event.preventDefault();
		void undo();
	}

	/** How many actions are currently reversible (drives nothing but tests + hints). */
	const depth = computed(() => entries.value.length);
	const canUndo = computed(() => entries.value.length > 0);

	return {
		entries,
		depth,
		canUndo,
		register,
		registerMoveBack,
		undo,
		undoEntry,
		dismiss,
		onWindowKeydown,
	};
}
