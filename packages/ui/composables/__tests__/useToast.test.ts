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
