import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';

// --- Nuxt auto-import stubs (useState + the @owlat/ui useToast layer) ---

interface StubToast {
	id: string;
	message: string;
	type: string;
	action?: { label: string; onAction: () => void };
}

const toasts: StubToast[] = [];
let toastSeq = 0;

const showToast = vi.fn(
	(
		message: string,
		type: string = 'success',
		options?: { durationMs?: number; action?: { label: string; onAction: () => void } }
	): string => {
		const id = `toast-${++toastSeq}`;
		toasts.push({ id, message, type, ...(options?.action ? { action: options.action } : {}) });
		return id;
	}
);
const removeToast = vi.fn((id: string) => {
	const index = toasts.findIndex((t) => t.id === id);
	if (index > -1) toasts.splice(index, 1);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stateBuckets: Map<string, any>;
vi.stubGlobal('useState', (key: string, init: () => unknown) => {
	if (!stateBuckets.has(key)) stateBuckets.set(key, ref(init()));
	return stateBuckets.get(key);
});
vi.stubGlobal('useToast', () => ({ showToast, removeToast }));

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

	it('registerMoveBack with an empty moved list registers nothing', () => {
		const undoState = usePostboxTriageUndo();
		undoState.registerMoveBack({ label: 'Moved', moved: [], runMove: vi.fn() });
		expect(undoState.canUndo.value).toBe(false);
		expect(toasts).toHaveLength(0);
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
