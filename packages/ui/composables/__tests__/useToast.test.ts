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
