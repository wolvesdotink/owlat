import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useToast } from '../useToast';

beforeEach(() => {
	vi.useFakeTimers();
	useToast().clearToasts();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('useToast', () => {
	it('shows a success toast by default', () => {
		const { showToast, toasts } = useToast();
		showToast('Saved');
		expect(toasts.value).toHaveLength(1);
		expect(toasts.value[0]).toMatchObject({ message: 'Saved', type: 'success' });
	});

	it('shows an error toast when requested', () => {
		const { showToast, toasts } = useToast();
		showToast('Failed', 'error');
		expect(toasts.value[0]?.type).toBe('error');
	});

	it('shares state across composable instances (global toaster)', () => {
		useToast().showToast('From A');
		expect(useToast().toasts.value).toHaveLength(1);
	});

	it('auto-dismisses after 3 seconds', () => {
		const { showToast, toasts } = useToast();
		showToast('Ephemeral');
		expect(toasts.value).toHaveLength(1);
		vi.advanceTimersByTime(3001);
		expect(toasts.value).toHaveLength(0);
	});

	it('keeps error toasts on screen longer than success toasts', () => {
		const { showToast, toasts } = useToast();
		showToast('Saved', 'success');
		showToast('Failed', 'error');
		expect(toasts.value).toHaveLength(2);

		// Just past the success lifetime: the success is gone, the error remains.
		vi.advanceTimersByTime(3001);
		expect(toasts.value).toHaveLength(1);
		expect(toasts.value[0]?.type).toBe('error');

		// The error survives well beyond the success window before it clears.
		vi.advanceTimersByTime(5000);
		expect(toasts.value).toHaveLength(0);
	});

	it('treats a non-positive duration as sticky (never auto-dismisses)', () => {
		const { showToast, toasts } = useToast();
		showToast('Stay put', 'error', { durationMs: 0 });
		vi.advanceTimersByTime(60_000);
		expect(toasts.value).toHaveLength(1);
	});

	it('supports info and warning toast types', () => {
		const { showToast, toasts } = useToast();
		showToast('Heads up', 'info');
		showToast('Careful', 'warning');
		expect(toasts.value.map((t) => t.type)).toEqual(['info', 'warning']);
	});

	it('removes a specific toast without touching the others', () => {
		const { showToast, removeToast, toasts } = useToast();
		showToast('one');
		showToast('two');
		const first = toasts.value[0]!.id;
		removeToast(first);
		expect(toasts.value).toHaveLength(1);
		expect(toasts.value[0]?.message).toBe('two');
	});

	it('clearToasts empties the stack', () => {
		const { showToast, clearToasts, toasts } = useToast();
		showToast('one');
		showToast('two');
		clearToasts();
		expect(toasts.value).toHaveLength(0);
	});

	it('tolerates removing an already-dismissed toast', () => {
		const { showToast, removeToast, toasts } = useToast();
		showToast('one');
		const id = toasts.value[0]!.id;
		removeToast(id);
		expect(() => removeToast(id)).not.toThrow();
	});
});

/**
 * `onDismiss` exists for callers whose follow-up write means "the user has seen
 * this" — a once-ever nudge marking itself acknowledged. Firing it on display
 * would burn the notice on someone who never looked at the screen, and firing
 * it twice would double-write, so both are pinned here.
 */
describe('useToast — onDismiss', () => {
	it('fires when the toast auto-dismisses', () => {
		const { showToast } = useToast();
		const onDismiss = vi.fn();
		showToast('Ephemeral', 'success', { onDismiss });

		expect(onDismiss).not.toHaveBeenCalled();
		vi.advanceTimersByTime(3001);
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it('fires when the toast is dismissed manually', () => {
		const { showToast, removeToast, toasts } = useToast();
		const onDismiss = vi.fn();
		showToast('Sticky', 'success', { durationMs: 0, onDismiss });

		vi.advanceTimersByTime(60_000);
		expect(onDismiss).not.toHaveBeenCalled();

		removeToast(toasts.value[0]!.id);
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it('fires exactly once, however many times the toast is removed', () => {
		const { showToast, removeToast, toasts } = useToast();
		const onDismiss = vi.fn();
		showToast('Once', 'success', { durationMs: 0, onDismiss });

		const id = toasts.value[0]!.id;
		removeToast(id);
		removeToast(id);
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it('fires for every toast cleared by clearToasts', () => {
		const { showToast, clearToasts } = useToast();
		const first = vi.fn();
		const second = vi.fn();
		showToast('one', 'success', { durationMs: 0, onDismiss: first });
		showToast('two', 'success', { durationMs: 0, onDismiss: second });

		clearToasts();
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
	});

	it('leaves toasts without a callback alone', () => {
		const { showToast, removeToast, toasts } = useToast();
		showToast('plain');
		expect(() => removeToast(toasts.value[0]!.id)).not.toThrow();
	});
});
