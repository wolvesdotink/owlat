import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref } from 'vue';

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

import {
	usePostboxTriageUndo,
	groupMovedBySourceFolder,
	POSTBOX_TRIAGE_UNDO_WINDOW_MS,
} from '../usePostboxTriageUndo';
import type { TriageMovedEntry } from '../usePostboxTriageUndo';

const asMoved = (entries: Array<{ messageId: string; sourceFolderId: string }>) =>
	entries as unknown as TriageMovedEntry[];

beforeEach(() => {
	vi.useFakeTimers();
	stateBuckets = new Map();
	toasts.length = 0;
	showToast.mockClear();
	removeToast.mockClear();
	// The pending inverse lives at module scope — drop any leftover entry.
	usePostboxTriageUndo().dismiss();
	stateBuckets = new Map();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('usePostboxTriageUndo', () => {
	it('registering a new action replaces the prior entry (single-slot, no stack)', async () => {
		const undoState = usePostboxTriageUndo();
		const firstInverse = vi.fn();
		const secondInverse = vi.fn();

		undoState.register({ label: 'Archived', inverse: firstInverse });
		expect(toasts).toHaveLength(1);
		expect(toasts[0]?.message).toBe('Archived');

		undoState.register({ label: 'Moved to Trash', inverse: secondInverse });
		// The prior toast is gone; only the newest entry remains undoable.
		expect(toasts).toHaveLength(1);
		expect(toasts[0]?.message).toBe('Moved to Trash');

		expect(await undoState.undo()).toBe(true);
		expect(firstInverse).not.toHaveBeenCalled();
		expect(secondInverse).toHaveBeenCalledTimes(1);
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
		expect(undoState.state.value.active).toBe(false);
	});

	it('expiry clears the entry: the toast disappears and undo becomes a no-op', async () => {
		const undoState = usePostboxTriageUndo();
		const inverse = vi.fn();
		undoState.register({ label: 'Archived', inverse });
		expect(undoState.state.value.active).toBe(true);

		vi.advanceTimersByTime(POSTBOX_TRIAGE_UNDO_WINDOW_MS + 1);

		expect(undoState.state.value.active).toBe(false);
		expect(toasts).toHaveLength(0);
		expect(await undoState.undo()).toBe(false);
		expect(inverse).not.toHaveBeenCalled();
	});

	it('the toast action button triggers the inverse', () => {
		const undoState = usePostboxTriageUndo();
		const inverse = vi.fn();
		undoState.register({ label: 'Archived', inverse });

		expect(toasts[0]?.action?.label).toBe('Undo');
		toasts[0]?.action?.onAction();
		expect(inverse).toHaveBeenCalledTimes(1);
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

	it('registerMoveBack runs before → grouped move-backs → after', async () => {
		const undoState = usePostboxTriageUndo();
		const calls: string[] = [];
		const runMove = vi.fn(
			async (a: { messageIds: unknown[]; targetFolderId: unknown }) => {
				calls.push(`move:${String(a.targetFolderId)}:${a.messageIds.length}`);
			}
		);

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
		expect(undoState.state.value.active).toBe(false);
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
