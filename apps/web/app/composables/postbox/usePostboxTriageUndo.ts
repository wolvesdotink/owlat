/**
 * Undoable triage — "Archived — Undo" for archive/trash/move/spam.
 *
 * A triage action registers its inverse here after the mutation SUCCEEDS
 * (failure is already handled by usePostboxOptimisticHide restoring the
 * row). The registry is a bounded LIFO STACK (utils/postboxUndoStack.ts): up
 * to ten actions stay reversible at once, each with its own deadline, and
 * repeated Cmd/Ctrl+Z walks a triage burst back newest-first.
 *
 * Actions are shown in NOTICES (toasts). Consecutive actions of the same kind
 * (an archive after an archive, a move to the same folder) share one notice
 * that counts them up: "Archived 8 messages · Ctrl+Z undoes the last · Undo
 * all". The keyboard still takes one action at a time (the newest), and the
 * notice's count follows; its button takes every action the notice still
 * holds. Any other action opens a notice of its own, and a notice the user
 * closed is never added to again. An action registered without a `group` always
 * has its own notice.
 *
 * Every action keeps its own deadline: when it expires or is evicted it leaves
 * its notice, and the notice goes with its last action. Only the notice holding
 * the NEWEST action names the chord (⌘Z on a Mac): the keyboard always takes
 * the top of the stack, so an older notice offering it would be a promise the
 * key breaks.
 *
 * Inverses run one after another, never side by side: an "Undo all" in flight
 * finishes before a keypress's inverse starts, so a burst is put back in the
 * reverse order it happened. Entries leave the stack before their inverse
 * runs, so the button and the key can never reverse the same action twice.
 *
 * The Cmd/Ctrl+Z listener is installed APP-WIDE by this module the moment the
 * stack becomes non-empty and removed again when it empties — no surface has
 * to remember to bind it, and there is exactly one binding however many
 * components hold the composable (two bindings would undo two entries per
 * keypress).
 *
 * Modeled on usePostboxUndoSend: a useState singleton holds the serializable
 * state; the inverse callbacks and notices live at module scope because
 * functions and toast handles don't belong in a useState payload.
 */

import type { Id } from '@owlat/api/dataModel';
import type { ToastAction } from '@owlat/ui/composables/useToast';
import { isTriageUndoPress } from '~/utils/fixedShortcutPresses';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import {
	joinableUndoGroup,
	popUndoEntry,
	pruneUndoStack,
	pushUndoEntry,
	takeUndoGroup,
	undoGroupMembers,
	undoGroupTotal,
	POSTBOX_UNDO_STACK_LIMIT,
	type PostboxUndoEntry,
} from '~/utils/postboxUndoStack';
import { DEFAULT_OPTIMISTIC_UNDO_WINDOW_MS } from '~/composables/useOptimisticMutation';
import { useShortcutLabels } from '~/composables/useShortcutLabels';

/** Alias of the shared optimistic undo window — one source of truth for "undo is 8s". */
export const POSTBOX_TRIAGE_UNDO_WINDOW_MS = DEFAULT_OPTIMISTIC_UNDO_WINDOW_MS;

export { POSTBOX_UNDO_STACK_LIMIT };

/** One stacked entry, as it travels through `useState`. */
export interface TriageUndoEntry extends PostboxUndoEntry {
	/** This action's own notice text, e.g. "Archived" / "Moved to Trash". */
	label: string;
}

/**
 * How an action coalesces with the ones before it.
 *
 * `key` names the kind of action and its scope (`postbox:archived`,
 * `postbox:moved:<folderId>`, `inbox:assign:<userId>`): two consecutive actions
 * with equal keys share a notice. It is never a translated label, which could
 * collide across kinds or differ between two calls for one kind.
 */
export interface UndoGroup {
	key: string;
	/** Items this action touched (messages archived, contacts added). Defaults to 1. */
	count?: number;
	/** The shared notice's text once it holds more than one action, for `total` items. */
	label: (total: number) => string;
}

/** The move-family triage kinds a Postbox notice can count up. */
export type PostboxMoveUndoKind = 'archived' | 'trashed' | 'moved' | 'spam';

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

/** A notice on screen, standing for every stacked entry with its id as `groupId`. */
interface UndoNotice {
	/** Null once the toast is gone (closed by the user): the notice takes no more actions. */
	toastId: string | null;
	/** Text for more than one action; null for a notice that never coalesces. */
	label: ((total: number) => string) | null;
	/** The button for one action and for several, built once so a resync does not re-render it. */
	undoOne: ToastAction;
	undoAll: ToastAction;
}

// Callbacks, timers and notices keyed by id, at module scope: functions and
// timer/toast handles have no business inside a useState payload.
const inverses = new Map<string, () => void | Promise<void>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const notices = new Map<string, UndoNotice>();
let entrySeq = 0;

// The single app-wide Cmd/Ctrl+Z binding, installed while entries are pending.
let boundHotkey: ((event: KeyboardEvent) => void) | null = null;

/** The chord `onWindowKeydown` answers, for the hint that names it. */
const UNDO_CHORD = 'mod+z';

/** The run of inverses in flight, or null when idle. */
let inverseTail: Promise<void> | null = null;

/** Run inverses in order; the first failure is re-thrown once all have run. */
async function runAll(list: ReadonlyArray<() => void | Promise<void>>): Promise<void> {
	let failure: { error: unknown } | null = null;
	for (const inverse of list) {
		try {
			await inverse();
		} catch (error) {
			failure ??= { error };
		}
	}
	if (failure) throw failure.error;
}

/**
 * Queue a batch of inverses behind whatever is still running. When nothing
 * is, the first inverse starts synchronously, so a keypress acts at once.
 */
function runInOrder(list: ReadonlyArray<() => void | Promise<void>>): Promise<void> {
	const run = inverseTail ? inverseTail.then(() => runAll(list)) : runAll(list);
	const settled = run.then(
		() => {},
		() => {}
	);
	inverseTail = settled;
	void settled.then(() => {
		if (inverseTail === settled) inverseTail = null;
	});
	return run;
}

export function usePostboxTriageUndo() {
	const entries = useState<TriageUndoEntry[]>('postbox:triage-undo', () => []);
	const { showToast, removeToast, setToastShortcutHint, updateToast } = useToast();
	const { t } = useI18n();
	const { chordLabel } = useShortcutLabels();

	/** Forget an entry's side tables (callback, expiry timer); `sync` handles its notice. */
	function releaseEntry(entry: TriageUndoEntry) {
		const timer = timers.get(entry.id);
		if (timer) {
			clearTimeout(timer);
			timers.delete(entry.id);
		}
		inverses.delete(entry.id);
	}

	/**
	 * Bring every notice in line with the stack: a notice with no entries left
	 * goes; the rest show their count, the right button and (on the notice of
	 * the newest entry only) the chord.
	 */
	function syncNotices() {
		const newestGroup = entries.value[0]?.groupId;
		const keys = chordLabel(UNDO_CHORD);
		for (const [groupId, notice] of notices) {
			const members = undoGroupMembers(entries.value, groupId);
			if (members.length === 0) {
				notices.delete(groupId);
				if (notice.toastId) removeToast(notice.toastId);
				continue;
			}
			if (!notice.toastId) continue;
			const many = members.length > 1 && notice.label !== null;
			updateToast(notice.toastId, {
				message: many ? notice.label!(undoGroupTotal(members)) : members[0]!.label,
				action: many ? notice.undoAll : notice.undoOne,
			});
			const hint =
				groupId !== newestGroup
					? undefined
					: many
						? t('shared.postbox.usePostboxTriageUndo.keyHintLast', { keys })
						: t('shared.postbox.usePostboxTriageUndo.keyHint', { keys });
			setToastShortcutHint(notice.toastId, hint);
		}
	}

	/** Called after every change to the stack: the notices and the binding follow it. */
	function sync() {
		if (import.meta.server) return;
		syncNotices();
		const wanted = entries.value.length > 0;
		if (wanted && !boundHotkey) {
			boundHotkey = onWindowKeydown;
			// oxlint-disable-next-line owlat/no-raw-keydown-listener -- postbox.undoChord, bound only while an undo is pending
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
		sync();
	}

	/** Drop expired entries — also called before every read of the stack. */
	function prune() {
		const { stack, expired } = pruneUndoStack(entries.value, Date.now());
		if (expired.length === 0) return;
		for (const entry of expired) releaseEntry(entry);
		entries.value = stack;
		sync();
	}

	/** Open a notice for an action that does not join the one before it. */
	function openNotice(groupId: string, label: string, group: UndoGroup | undefined) {
		const onAction = () => {
			void undoGroup(groupId);
		};
		const notice: UndoNotice = {
			toastId: null,
			label: group?.label ?? null,
			undoOne: { label: t('shared.postbox.usePostboxTriageUndo.undo'), onAction },
			undoAll: { label: t('shared.postbox.usePostboxTriageUndo.undoAll'), onAction },
		};
		notices.set(groupId, notice);
		// Sticky: the notice lives exactly as long as its entries, which this
		// module tracks (each with its own deadline), not as long as a toast timer.
		notice.toastId = showToast(label, 'success', {
			durationMs: 0,
			action: notice.undoOne,
			onDismiss: () => {
				notice.toastId = null;
			},
		});
	}

	/**
	 * Register a completed triage action's inverse on top of the stack. The
	 * oldest entry is evicted once the stack is full; nothing is ever refused.
	 * With a `group`, the action joins the notice of the action just before it
	 * when that one is of the same kind (see {@link UndoGroup}).
	 */
	function register(args: {
		/** This action's notice text, e.g. "Archived" / "Moved to Trash". */
		label: string;
		inverse: () => void | Promise<void>;
		windowMs?: number;
		group?: UndoGroup;
	}) {
		const windowMs = args.windowMs ?? POSTBOX_TRIAGE_UNDO_WINDOW_MS;
		const now = Date.now();
		const id = `undo-${++entrySeq}`;
		const group = args.group;
		const joined = joinableUndoGroup(
			entries.value,
			group?.key,
			now,
			(groupId) => notices.get(groupId)?.toastId != null
		);
		const groupId = joined ?? `notice-${id}`;
		if (joined && group) notices.get(joined)!.label = group.label;
		else openNotice(groupId, args.label, group);

		const entry: TriageUndoEntry = {
			id,
			label: args.label,
			expiresAt: now + windowMs,
			groupId,
			...(group ? { groupKey: group.key, count: Math.max(1, group.count ?? 1) } : {}),
		};
		inverses.set(id, args.inverse);
		const { stack, evicted } = pushUndoEntry(entries.value, entry, now);
		for (const gone of evicted) releaseEntry(gone);
		entries.value = stack;
		timers.set(
			id,
			setTimeout(() => prune(), windowMs)
		);
		sync();
	}

	/**
	 * Undo every action a notice still holds ("Undo all"), newest first. They
	 * leave the stack before the first inverse runs. Returns true when at least
	 * one was undone.
	 */
	async function undoGroup(groupId: string): Promise<boolean> {
		const { stack, entries: taken, expired } = takeUndoGroup(entries.value, groupId, Date.now());
		const list = taken.flatMap((entry) => {
			const inverse = inverses.get(entry.id);
			return inverse ? [inverse] : [];
		});
		for (const gone of [...expired, ...taken]) releaseEntry(gone);
		entries.value = stack;
		sync();
		if (list.length === 0) return false;
		await runInOrder(list);
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
		const inverse = entry ? inverses.get(entry.id) : undefined;
		if (entry) releaseEntry(entry);
		entries.value = stack;
		sync();
		if (!inverse) return false;
		await runInOrder([inverse]);
		return true;
	}

	/**
	 * Convenience for the dominant case: undo a move-family action by moving
	 * each message back to its source folder (grouped per folder), optionally
	 * preceded by a semantic inverse (e.g. notSpam) and followed by local
	 * cleanup (e.g. un-hiding optimistic rows).
	 *
	 * With a `kind`, consecutive actions of that kind share one notice that
	 * counts the messages ("Archived 8 messages"); a move also needs its
	 * target folder as `scope`, so moves to two folders stay apart.
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
		kind?: PostboxMoveUndoKind;
		scope?: string;
	}) {
		if (args.moved.length === 0) return;
		const kind = args.kind;
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
			...(kind
				? {
						group: {
							key: args.scope ? `postbox:${kind}:${args.scope}` : `postbox:${kind}`,
							count: args.moved.length,
							label: (total: number) =>
								t(`shared.postbox.usePostboxTriageUndo.grouped.${kind}`, { count: total }, total),
						},
					}
				: {}),
		});
	}

	/**
	 * Cmd/Ctrl+Z handler. Bound app-wide by this module while entries are
	 * pending (see `sync`) — surfaces do not bind it themselves. Inert while a
	 * composer/input/contenteditable has focus — the editor owns undo there —
	 * and when nothing is pending, so the browser default is untouched.
	 */
	function onWindowKeydown(event: KeyboardEvent) {
		if (event.defaultPrevented || !isTriageUndoPress(event)) return;
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
		undoGroup,
		dismiss,
		onWindowKeydown,
	};
}
