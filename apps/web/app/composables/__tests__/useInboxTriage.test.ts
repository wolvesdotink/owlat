import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref, nextTick } from 'vue';

// --- Nuxt auto-import stubs (useState + the @owlat/ui useToast layer) that
// usePostboxTriageUndo reaches for; mirrors usePostboxTriageUndo's own test. ---

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

import { useInboxTriage } from '../useInboxTriage';
import { usePostboxTriageUndo } from '../postbox/usePostboxTriageUndo';

interface Row {
	_id: string;
}

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

const ids = (rows: readonly Row[]) => rows.map((r) => r._id);

describe('useInboxTriage', () => {
	it('hides the row immediately on a leaves-view action, then undo restores it', async () => {
		const rows = ref<Row[]>([{ _id: 'a' }, { _id: 'b' }]);
		const { visible, run } = useInboxTriage(rows);

		const mutate = vi.fn(async () => ({ success: true }));
		const inverse = vi.fn(async () => ({ success: true }));

		const ok = await run({ id: 'a', label: 'Resolved', leavesView: true, mutate, inverse });

		expect(ok).toBe(true);
		expect(mutate).toHaveBeenCalledTimes(1);
		// Row hidden the moment the mutation succeeds.
		expect(ids(visible.value)).toEqual(['b']);
		// A single undo toast was registered.
		expect(toasts).toHaveLength(1);
		expect(toasts[0]?.message).toBe('Resolved');

		// Undo via the toast action → inverse runs and the row comes back.
		toasts[0]?.action?.onAction();
		await nextTick();
		expect(inverse).toHaveBeenCalledTimes(1);
		expect(ids(visible.value)).toEqual(['a', 'b']);
	});

	it('rolls the row back and registers no undo when the mutation fails', async () => {
		const rows = ref<Row[]>([{ _id: 'a' }, { _id: 'b' }]);
		const { visible, run } = useInboxTriage(rows);

		// useBackendOperation returns `undefined` on failure (it toasts the error itself).
		const mutate = vi.fn(async () => undefined);
		const inverse = vi.fn();

		const ok = await run({ id: 'a', label: 'Resolved', leavesView: true, mutate, inverse });

		expect(ok).toBe(false);
		// The optimistically hidden row is restored.
		expect(ids(visible.value)).toEqual(['a', 'b']);
		// No undo offered for an action that never happened.
		expect(inverse).not.toHaveBeenCalled();
		expect(toasts).toHaveLength(0);
	});

	it('does not hide the row for a stays-in-view action but still offers undo', async () => {
		const rows = ref<Row[]>([{ _id: 'a' }, { _id: 'b' }]);
		const { visible, run } = useInboxTriage(rows);

		const mutate = vi.fn(async () => ({ success: true }));
		const inverse = vi.fn(async () => ({ success: true }));

		const ok = await run({ id: 'a', label: 'Assigned to you', leavesView: false, mutate, inverse });

		expect(ok).toBe(true);
		expect(ids(visible.value)).toEqual(['a', 'b']);
		expect(toasts[0]?.message).toBe('Assigned to you');
	});
});
