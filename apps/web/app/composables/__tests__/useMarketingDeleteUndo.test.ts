/**
 * `useMarketingDeleteUndo`: a list delete runs at once and its toast names the
 * item and offers Undo, on the app's one undo stack. The button and Ctrl+Z
 * restore it exactly once; a focused text field keeps the key for its own
 * undo; a failed delete offers nothing to undo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';

interface StubToast {
	id: string;
	message: string;
	action?: { label: string; onAction: () => void };
	shortcutHint?: string;
}

const toasts: StubToast[] = [];
let toastSeq = 0;
const showToast = vi.fn(
	(message: string, _type?: string, options?: { action?: StubToast['action'] }): string => {
		const id = `toast-${++toastSeq}`;
		toasts.push({ id, message, ...(options?.action ? { action: options.action } : {}) });
		return id;
	}
);
const removeToast = vi.fn((id: string) => {
	const index = toasts.findIndex((t) => t.id === id);
	if (index > -1) toasts.splice(index, 1);
});
const setToastShortcutHint = (id: string, hint: string | undefined) => {
	const toast = toasts.find((t) => t.id === id);
	if (toast) toast.shortcutHint = hint;
};
const updateToast = (id: string, patch: { message?: string; action?: StubToast['action'] }) => {
	const toast = toasts.find((t) => t.id === id);
	if (!toast) return;
	if (patch.message !== undefined) toast.message = patch.message;
	if (patch.action) toast.action = patch.action;
};
vi.stubGlobal('useToast', () => ({ showToast, removeToast, setToastShortcutHint, updateToast }));

let stateBuckets = new Map<string, ReturnType<typeof ref>>();
vi.stubGlobal('useState', (key: string, init: () => unknown) => {
	if (!stateBuckets.has(key)) stateBuckets.set(key, ref(init()));
	return stateBuckets.get(key);
});

const i18n = createTestI18n();
vi.stubGlobal('useI18n', () => i18n.global);

const { useMarketingDeleteUndo } = await import('../useMarketingDeleteUndo');
const { usePostboxTriageUndo } = await import('../postbox/usePostboxTriageUndo');

function pressUndo(target: EventTarget = window) {
	const event = new KeyboardEvent('keydown', {
		key: 'z',
		ctrlKey: true,
		bubbles: true,
		cancelable: true,
	});
	target.dispatchEvent(event);
	return event;
}

beforeEach(() => {
	vi.useFakeTimers();
	stateBuckets = new Map();
	toasts.length = 0;
	usePostboxTriageUndo().dismiss();
});

afterEach(() => {
	usePostboxTriageUndo().dismiss();
	vi.useRealTimers();
});

describe('useMarketingDeleteUndo', () => {
	it('names the deleted item and restores it once from the Undo button', async () => {
		const { deleteWithUndo } = useMarketingDeleteUndo();
		const restore = vi.fn(async () => ({ ok: true }));

		const ok = await deleteWithUndo({ name: 'Autumn sale', remove: async () => true, restore });

		expect(ok).toBe(true);
		expect(toasts).toHaveLength(1);
		expect(toasts[0]!.message).toBe('Deleted Autumn sale');
		expect(toasts[0]!.action?.label).toBe('Undo');
		expect(toasts[0]!.shortcutHint).toMatch(/to undo/);

		const action = toasts[0]!.action!;
		action.onAction();
		action.onAction();
		await vi.advanceTimersByTimeAsync(0);
		expect(restore).toHaveBeenCalledTimes(1);
		expect(toasts).toHaveLength(0);
	});

	it('restores the newest delete on Ctrl+Z, once', async () => {
		const { deleteWithUndo } = useMarketingDeleteUndo();
		const restoreFirst = vi.fn(async () => undefined);
		const restoreSecond = vi.fn(async () => undefined);
		await deleteWithUndo({ name: 'First', remove: async () => true, restore: restoreFirst });
		await deleteWithUndo({ name: 'Second', remove: async () => true, restore: restoreSecond });

		const event = pressUndo();
		await vi.advanceTimersByTimeAsync(0);
		expect(event.defaultPrevented).toBe(true);
		expect(restoreSecond).toHaveBeenCalledTimes(1);
		expect(restoreFirst).not.toHaveBeenCalled();

		pressUndo();
		await vi.advanceTimersByTimeAsync(0);
		expect(restoreFirst).toHaveBeenCalledTimes(1);
		expect(restoreSecond).toHaveBeenCalledTimes(1);
	});

	it('leaves Ctrl+Z to a focused text field', async () => {
		const { deleteWithUndo } = useMarketingDeleteUndo();
		const restore = vi.fn(async () => undefined);
		await deleteWithUndo({ name: 'Autumn sale', remove: async () => true, restore });

		const input = document.createElement('input');
		document.body.append(input);
		const event = pressUndo(input);
		await vi.advanceTimersByTimeAsync(0);
		input.remove();

		expect(event.defaultPrevented).toBe(false);
		expect(restore).not.toHaveBeenCalled();
		expect(toasts).toHaveLength(1);
	});

	it('offers nothing to undo when the delete did not happen', async () => {
		const { deleteWithUndo } = useMarketingDeleteUndo();
		const restore = vi.fn(async () => undefined);

		const ok = await deleteWithUndo({ name: 'Autumn sale', remove: async () => false, restore });

		expect(ok).toBe(false);
		expect(toasts).toHaveLength(0);
		pressUndo();
		await vi.advanceTimersByTimeAsync(0);
		expect(restore).not.toHaveBeenCalled();
	});
});
