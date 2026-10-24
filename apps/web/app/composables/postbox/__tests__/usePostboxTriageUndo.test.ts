import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';

// --- Nuxt auto-import stubs (useState + the @owlat/ui useToast layer) ---

interface StubToast {
	id: string;
	message: string;
	type: string;
	action?: { label: string; onAction: () => void };
	shortcutHint?: string;
}

const toasts: StubToast[] = [];
const dismissHandlers = new Map<string, () => void>();
let toastSeq = 0;

const showToast = vi.fn(
	(
		message: string,
		type: string = 'success',
		options?: {
			durationMs?: number;
			action?: { label: string; onAction: () => void };
			onDismiss?: () => void;
		}
	): string => {
		const id = `toast-${++toastSeq}`;
		toasts.push({ id, message, type, ...(options?.action ? { action: options.action } : {}) });
		if (options?.onDismiss) dismissHandlers.set(id, options.onDismiss);
		return id;
	}
);
// Like the real store: removal (by the module or the close button) runs onDismiss once.
const removeToast = vi.fn((id: string) => {
	const index = toasts.findIndex((t) => t.id === id);
	if (index > -1) toasts.splice(index, 1);
	const onDismiss = dismissHandlers.get(id);
	dismissHandlers.delete(id);
	onDismiss?.();
});
const updateToast = (
	id: string,
	patch: { message?: string; action?: { label: string; onAction: () => void } }
) => {
	const toast = toasts.find((t) => t.id === id);
	if (!toast) return;
	if (patch.message !== undefined) toast.message = patch.message;
	if (patch.action) toast.action = patch.action;
};

let stateBuckets: Map<string, any>;
vi.stubGlobal('useState', (key: string, init: () => unknown) => {
	if (!stateBuckets.has(key)) stateBuckets.set(key, ref(init()));
	return stateBuckets.get(key);
});
const setToastShortcutHint = (id: string, hint: string | undefined) => {
	const toast = toasts.find((t) => t.id === id);
	if (!toast) return;
	if (hint) toast.shortcutHint = hint;
	else delete toast.shortcutHint;
};
vi.stubGlobal('useToast', () => ({ showToast, removeToast, setToastShortcutHint, updateToast }));

// The undo action's own label is a translated string, so the real catalog sits
// behind the `useI18n` auto-import and the toast carries the English a user reads.
const i18n = createTestI18n();
vi.stubGlobal('useI18n', () => i18n.global);

import {
	usePostboxTriageUndo,
	groupMovedBySourceFolder,
	POSTBOX_TRIAGE_UNDO_WINDOW_MS,
	POSTBOX_UNDO_STACK_LIMIT,
} from '../usePostboxTriageUndo';
import type { TriageMovedEntry } from '../usePostboxTriageUndo';

const asMoved = (entries: Array<{ messageId: string; sourceFolderId: string }>) =>
	entries as unknown as TriageMovedEntry[];

// The Cmd+Z listener is installed app-wide by the composable itself, so the
// binding is part of the contract under test.
const addSpy = vi.fn();
const removeSpy = vi.fn();

beforeEach(() => {
	vi.useFakeTimers();
	stateBuckets = new Map();
	toasts.length = 0;
	dismissHandlers.clear();
	showToast.mockClear();
	removeToast.mockClear();
	// The inverses + the window binding live at module scope — drop leftovers.
	usePostboxTriageUndo().dismiss();
	stateBuckets = new Map();
	addSpy.mockClear();
	removeSpy.mockClear();
	vi.spyOn(window, 'addEventListener').mockImplementation((...args) => {
		addSpy(...args);
	});
	vi.spyOn(window, 'removeEventListener').mockImplementation((...args) => {
		removeSpy(...args);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('usePostboxTriageUndo', () => {
	it('stacks registrations and undoes them newest-first (repeated Cmd+Z)', async () => {
		const undoState = usePostboxTriageUndo();
		const firstInverse = vi.fn();
		const secondInverse = vi.fn();

		undoState.register({ label: 'Archived', inverse: firstInverse });
		undoState.register({ label: 'Moved to Trash', inverse: secondInverse });
		// Both actions stay reversible, each with its own toast.
		expect(undoState.depth.value).toBe(2);
		expect(toasts.map((t) => t.message)).toEqual(['Archived', 'Moved to Trash']);

		expect(await undoState.undo()).toBe(true);
		expect(secondInverse).toHaveBeenCalledTimes(1);
		expect(firstInverse).not.toHaveBeenCalled();

		expect(await undoState.undo()).toBe(true);
		expect(firstInverse).toHaveBeenCalledTimes(1);
		expect(undoState.depth.value).toBe(0);
		expect(await undoState.undo()).toBe(false);
	});

	it('caps the stack at ten entries, evicting the oldest with its toast', async () => {
		const undoState = usePostboxTriageUndo();
		const inverses = Array.from({ length: POSTBOX_UNDO_STACK_LIMIT + 1 }, () => vi.fn());
		inverses.forEach((inverse, i) => undoState.register({ label: `a${i}`, inverse }));

		expect(undoState.depth.value).toBe(POSTBOX_UNDO_STACK_LIMIT);
		expect(toasts).toHaveLength(POSTBOX_UNDO_STACK_LIMIT);
		expect(toasts.some((t) => t.message === 'a0')).toBe(false);

		// Walk the whole stack back; the evicted entry is unreachable.
		for (let i = 0; i < POSTBOX_UNDO_STACK_LIMIT; i++) {
			expect(await undoState.undo()).toBe(true);
		}
		expect(inverses[0]).not.toHaveBeenCalled();
		for (const inverse of inverses.slice(1)) expect(inverse).toHaveBeenCalledTimes(1);
	});

	it('undo invokes the inverse callback exactly once', async () => {
		const undoState = usePostboxTriageUndo();
		const inverse = vi.fn();
		undoState.register({ label: 'Archived', inverse });

		expect(await undoState.undo()).toBe(true);
		expect(await undoState.undo()).toBe(false);
		expect(inverse).toHaveBeenCalledTimes(1);
		// Undoing also dismissed the toast.
		expect(toasts).toHaveLength(0);
		expect(undoState.canUndo.value).toBe(false);
	});

	it('expiry clears the entry: the toast disappears and undo becomes a no-op', async () => {
		const undoState = usePostboxTriageUndo();
		const inverse = vi.fn();
		undoState.register({ label: 'Archived', inverse });
		expect(undoState.canUndo.value).toBe(true);

		vi.advanceTimersByTime(POSTBOX_TRIAGE_UNDO_WINDOW_MS + 1);

		expect(undoState.canUndo.value).toBe(false);
		expect(toasts).toHaveLength(0);
		expect(await undoState.undo()).toBe(false);
		expect(inverse).not.toHaveBeenCalled();
	});

	it('expires entries independently — the newer one survives the older deadline', async () => {
		const undoState = usePostboxTriageUndo();
		const older = vi.fn();
		const newer = vi.fn();
		undoState.register({ label: 'Archived', inverse: older });
		vi.advanceTimersByTime(POSTBOX_TRIAGE_UNDO_WINDOW_MS / 2);
		undoState.register({ label: 'Moved to Trash', inverse: newer });

		// Past the first entry's deadline, before the second's.
		vi.advanceTimersByTime(POSTBOX_TRIAGE_UNDO_WINDOW_MS / 2 + 1);
		expect(undoState.depth.value).toBe(1);
		expect(await undoState.undo()).toBe(true);
		expect(newer).toHaveBeenCalledTimes(1);
		expect(older).not.toHaveBeenCalled();
	});

	it('each toast action button undoes its OWN entry, not the newest', async () => {
		const undoState = usePostboxTriageUndo();
		const first = vi.fn();
		const second = vi.fn();
		undoState.register({ label: 'Archived', inverse: first });
		undoState.register({ label: 'Moved to Trash', inverse: second });

		expect(toasts[0]?.action?.label).toBe('Undo');
		toasts[0]?.action?.onAction();
		await Promise.resolve();
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).not.toHaveBeenCalled();
		expect(undoState.depth.value).toBe(1);
	});

	it('Cmd/Ctrl+Z runs the pending undo but stays inert in text-entry surfaces', () => {
		const undoState = usePostboxTriageUndo();
		const inverse = vi.fn();
		undoState.register({ label: 'Archived', inverse });

		// Focus inside an input: the editor owns Cmd+Z.
		const input = document.createElement('input');
		const inputEvent = new KeyboardEvent('keydown', { key: 'z', metaKey: true });
		Object.defineProperty(inputEvent, 'target', { value: input });
		undoState.onWindowKeydown(inputEvent);
		expect(inverse).not.toHaveBeenCalled();

		// Shift+Cmd+Z (redo) must not trigger it either.
		const redoEvent = new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true });
		Object.defineProperty(redoEvent, 'target', { value: document.body });
		undoState.onWindowKeydown(redoEvent);
		expect(inverse).not.toHaveBeenCalled();

		// Plain Cmd+Z outside any editable surface performs the undo.
		const event = new KeyboardEvent('keydown', { key: 'z', metaKey: true, cancelable: true });
		Object.defineProperty(event, 'target', { value: document.body });
		undoState.onWindowKeydown(event);
		expect(inverse).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
	});

	it('binds the window listener only while entries are pending', async () => {
		const undoState = usePostboxTriageUndo();
		expect(addSpy).not.toHaveBeenCalled();
		undoState.register({ label: 'Archived', inverse: vi.fn() });
		undoState.register({ label: 'Moved to Trash', inverse: vi.fn() });
		// One binding however many entries (two would undo twice per keypress).
		expect(addSpy).toHaveBeenCalledTimes(1);
		expect(removeSpy).not.toHaveBeenCalled();

		await undoState.undo();
		expect(removeSpy).not.toHaveBeenCalled();
		await undoState.undo();
		expect(removeSpy).toHaveBeenCalledTimes(1);
	});

	it('registerMoveBack runs before \u2192 grouped move-backs \u2192 after', async () => {
		const undoState = usePostboxTriageUndo();
		const calls: string[] = [];
		const runMove = vi.fn(async (a: { messageIds: unknown[]; targetFolderId: unknown }) => {
			calls.push(`move:${String(a.targetFolderId)}:${a.messageIds.length}`);
		});

		undoState.registerMoveBack({
			label: 'Marked as spam',
			moved: asMoved([
				{ messageId: 'm1', sourceFolderId: 'inbox' },
				{ messageId: 'm2', sourceFolderId: 'inbox' },
				{ messageId: 'm3', sourceFolderId: 'newsletters' },
			]),
			before: () => {
				calls.push('before');
			},
			runMove,
		});

		expect(await undoState.undo()).toBe(true);
		expect(calls).toEqual(['before', 'move:inbox:2', 'move:newsletters:1']);
	});

	it('hints the undo chord on the newest toast only, and moves the hint as the stack shrinks', async () => {
		const undoState = usePostboxTriageUndo();
		undoState.register({ label: 'Archived', inverse: vi.fn() });
		expect(toasts.map((t) => t.shortcutHint)).toEqual(['Ctrl+Z to undo']);

		// The keyboard takes the newest entry, so the older toast stops offering it.
		undoState.register({ label: 'Moved to Trash', inverse: vi.fn() });
		expect(toasts.map((t) => [t.message, t.shortcutHint])).toEqual([
			['Archived', undefined],
			['Moved to Trash', 'Ctrl+Z to undo'],
		]);

		// Undone by keyboard: the remaining toast is the newest again.
		await undoState.undo();
		expect(toasts.map((t) => [t.message, t.shortcutHint])).toEqual([
			['Archived', 'Ctrl+Z to undo'],
		]);
	});

	it('moves the hint when the newest entry is taken by its own button', async () => {
		const undoState = usePostboxTriageUndo();
		undoState.register({ label: 'Archived', inverse: vi.fn() });
		undoState.register({ label: 'Moved to Trash', inverse: vi.fn() });
		toasts[1]!.action!.onAction();
		await Promise.resolve();
		expect(toasts.map((t) => [t.message, t.shortcutHint])).toEqual([
			['Archived', 'Ctrl+Z to undo'],
		]);
	});

	it('names ⌘Z on a Mac', () => {
		Object.defineProperty(window.navigator, 'userAgent', {
			value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
			configurable: true,
		});
		try {
			usePostboxTriageUndo().register({ label: 'Archived', inverse: vi.fn() });
			expect(toasts[0]?.shortcutHint).toBe('⌘Z to undo');
		} finally {
			delete (window.navigator as { userAgent?: string }).userAgent;
		}
	});

	it('registerMoveBack with an empty moved list registers nothing', () => {
		const undoState = usePostboxTriageUndo();
		undoState.registerMoveBack({ label: 'Moved', moved: [], runMove: vi.fn() });
		expect(undoState.canUndo.value).toBe(false);
		expect(toasts).toHaveLength(0);
	});
});

describe('usePostboxTriageUndo — coalesced notices', () => {
	const runMove = () => Promise.resolve();
	const archive = (
		undoState: ReturnType<typeof usePostboxTriageUndo>,
		messageIds: string[],
		after?: () => void
	) =>
		undoState.registerMoveBack({
			label: messageIds.length > 1 ? `Archived ${messageIds.length} messages` : 'Archived',
			kind: 'archived',
			moved: asMoved(messageIds.map((messageId) => ({ messageId, sourceFolderId: 'inbox' }))),
			runMove,
			...(after ? { after } : {}),
		});
	const view = () => toasts.map((t) => [t.message, t.shortcutHint, t.action?.label]);

	it('counts consecutive actions of one kind up in one notice', () => {
		const undoState = usePostboxTriageUndo();
		archive(undoState, ['m1']);
		expect(view()).toEqual([['Archived', 'Ctrl+Z to undo', 'Undo']]);

		archive(undoState, ['m2', 'm3', 'm4']);
		archive(undoState, ['m5']);
		expect(undoState.depth.value).toBe(3);
		expect(view()).toEqual([['Archived 5 messages', 'Ctrl+Z undoes the last', 'Undo all']]);
		expect(showToast).toHaveBeenCalledTimes(1);
	});

	it('keeps other kinds and other move targets in notices of their own', () => {
		const undoState = usePostboxTriageUndo();
		archive(undoState, ['m1']);
		undoState.registerMoveBack({
			label: 'Moved to trash',
			kind: 'trashed',
			moved: asMoved([{ messageId: 'm2', sourceFolderId: 'inbox' }]),
			runMove,
		});
		// Not consecutive with the first archive: a new notice.
		archive(undoState, ['m3']);
		for (const scope of ['f1', 'f2']) {
			undoState.registerMoveBack({
				label: 'Moved',
				kind: 'moved',
				scope,
				moved: asMoved([{ messageId: `m-${scope}`, sourceFolderId: 'inbox' }]),
				runMove,
			});
		}
		// An action without a group never coalesces, even after its own kind.
		undoState.register({ label: 'Deleted Autumn sale', inverse: vi.fn() });
		undoState.register({ label: 'Deleted Autumn sale', inverse: vi.fn() });
		expect(view()).toEqual([
			['Archived', undefined, 'Undo'],
			['Moved to trash', undefined, 'Undo'],
			['Archived', undefined, 'Undo'],
			['Moved', undefined, 'Undo'],
			['Moved', undefined, 'Undo'],
			['Deleted Autumn sale', undefined, 'Undo'],
			['Deleted Autumn sale', 'Ctrl+Z to undo', 'Undo'],
		]);
	});

	it('takes one action per Cmd+Z and counts the notice down', async () => {
		const undoState = usePostboxTriageUndo();
		const undone: string[] = [];
		archive(undoState, ['m1'], () => undone.push('m1'));
		archive(undoState, ['m2'], () => undone.push('m2'));
		archive(undoState, ['m3'], () => undone.push('m3'));

		await undoState.undo();
		expect(undone).toEqual(['m3']);
		expect(view()).toEqual([['Archived 2 messages', 'Ctrl+Z undoes the last', 'Undo all']]);

		await undoState.undo();
		expect(view()).toEqual([['Archived', 'Ctrl+Z to undo', 'Undo']]);
		await undoState.undo();
		expect(undone).toEqual(['m3', 'm2', 'm1']);
		expect(toasts).toHaveLength(0);
	});

	it('Undo all reverses only its own notice, newest first, once each', async () => {
		const undoState = usePostboxTriageUndo();
		const undone: string[] = [];
		const trashInverse = vi.fn();
		undoState.register({ label: 'Moved to trash', inverse: trashInverse });
		archive(undoState, ['m1'], () => undone.push('m1'));
		archive(undoState, ['m2'], () => undone.push('m2'));
		archive(undoState, ['m3'], () => undone.push('m3'));

		const undoAll = toasts[1]!.action!;
		expect(undoAll.label).toBe('Undo all');
		undoAll.onAction();
		undoAll.onAction();
		await vi.advanceTimersByTimeAsync(0);

		expect(undone).toEqual(['m3', 'm2', 'm1']);
		expect(trashInverse).not.toHaveBeenCalled();
		expect(undoState.depth.value).toBe(1);
		// The remaining notice holds the newest action now, so it names the chord.
		expect(view()).toEqual([['Moved to trash', 'Ctrl+Z to undo', 'Undo']]);
	});

	it('runs a keypress after an Undo all that is still in flight, never beside it', async () => {
		const undoState = usePostboxTriageUndo();
		const events: string[] = [];
		let releaseMove!: () => void;
		undoState.register({
			label: 'Moved to trash',
			inverse: () => {
				events.push('trash');
			},
		});
		undoState.registerMoveBack({
			label: 'Archived',
			kind: 'archived',
			moved: asMoved([{ messageId: 'm1', sourceFolderId: 'inbox' }]),
			runMove: () =>
				new Promise<void>((resolve) => {
					events.push('archive:start');
					releaseMove = () => {
						events.push('archive:end');
						resolve();
					};
				}),
		});

		toasts[1]!.action!.onAction();
		const keypress = undoState.undo();
		await vi.advanceTimersByTimeAsync(0);
		expect(events).toEqual(['archive:start']);

		releaseMove();
		expect(await keypress).toBe(true);
		expect(events).toEqual(['archive:start', 'archive:end', 'trash']);
	});

	it('gives each action its own deadline: the notice counts down, then goes', () => {
		const undoState = usePostboxTriageUndo();
		archive(undoState, ['m1']);
		vi.advanceTimersByTime(POSTBOX_TRIAGE_UNDO_WINDOW_MS / 2);
		archive(undoState, ['m2', 'm3']);
		expect(view()).toEqual([['Archived 3 messages', 'Ctrl+Z undoes the last', 'Undo all']]);

		vi.advanceTimersByTime(POSTBOX_TRIAGE_UNDO_WINDOW_MS / 2 + 1);
		expect(view()).toEqual([['Archived 2 messages', 'Ctrl+Z to undo', 'Undo']]);

		vi.advanceTimersByTime(POSTBOX_TRIAGE_UNDO_WINDOW_MS / 2);
		expect(toasts).toHaveLength(0);
		expect(undoState.canUndo.value).toBe(false);
	});

	it('drops evicted actions from the count', () => {
		const undoState = usePostboxTriageUndo();
		for (let i = 0; i < POSTBOX_UNDO_STACK_LIMIT + 2; i++) archive(undoState, [`m${i}`]);
		expect(undoState.depth.value).toBe(POSTBOX_UNDO_STACK_LIMIT);
		expect(view()).toEqual([
			[`Archived ${POSTBOX_UNDO_STACK_LIMIT} messages`, 'Ctrl+Z undoes the last', 'Undo all'],
		]);
	});

	it('never adds to a notice the user closed, while its actions stay on the keyboard', async () => {
		const undoState = usePostboxTriageUndo();
		const undone: string[] = [];
		archive(undoState, ['m1'], () => undone.push('m1'));
		removeToast(toasts[0]!.id);

		archive(undoState, ['m2'], () => undone.push('m2'));
		expect(view()).toEqual([['Archived', 'Ctrl+Z to undo', 'Undo']]);
		expect(undoState.depth.value).toBe(2);

		await undoState.undo();
		await undoState.undo();
		expect(undone).toEqual(['m2', 'm1']);
	});
});

describe('groupMovedBySourceFolder', () => {
	it('groups messages per source folder preserving order', () => {
		const groups = groupMovedBySourceFolder(
			asMoved([
				{ messageId: 'a', sourceFolderId: 'f1' },
				{ messageId: 'b', sourceFolderId: 'f2' },
				{ messageId: 'c', sourceFolderId: 'f1' },
			])
		);
		expect(groups).toEqual([
			{ targetFolderId: 'f1', messageIds: ['a', 'c'] },
			{ targetFolderId: 'f2', messageIds: ['b'] },
		]);
	});
});
