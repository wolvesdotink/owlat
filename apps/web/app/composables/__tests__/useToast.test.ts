import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useToast } from '../useToast';

describe('useToast', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		const { clearToasts } = useToast();
		clearToasts();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('showToast', () => {
		it('adds a toast with correct message and type', () => {
			const { showToast, toasts } = useToast();
			showToast('Hello', 'success');

			expect(toasts.value).toHaveLength(1);
			expect(toasts.value[0]!.message).toBe('Hello');
			expect(toasts.value[0]!.type).toBe('success');
			expect(toasts.value[0]!.id).toBeTruthy();
		});

		it('defaults type to success', () => {
			const { showToast, toasts } = useToast();
			showToast('Default type');

			expect(toasts.value).toHaveLength(1);
			expect(toasts.value[0]!.type).toBe('success');
		});

		it('supports error type', () => {
			const { showToast, toasts } = useToast();
			showToast('Something went wrong', 'error');

			expect(toasts.value).toHaveLength(1);
			expect(toasts.value[0]!.type).toBe('error');
			expect(toasts.value[0]!.message).toBe('Something went wrong');
		});
	});

	describe('auto-dismiss', () => {
		it('removes toast after 3000ms', () => {
			const { showToast, toasts } = useToast();
			showToast('Temporary');

			expect(toasts.value).toHaveLength(1);

			vi.advanceTimersByTime(2999);
			expect(toasts.value).toHaveLength(1);

			vi.advanceTimersByTime(1);
			expect(toasts.value).toHaveLength(0);
		});
	});

	describe('removeToast', () => {
		it('removes a specific toast by id', () => {
			const { showToast, removeToast, toasts } = useToast();
			showToast('First');
			showToast('Second');

			const idToRemove = toasts.value[0]!.id;
			removeToast(idToRemove);

			expect(toasts.value).toHaveLength(1);
			expect(toasts.value[0]!.message).toBe('Second');
		});

		it('does nothing for a non-existent id', () => {
			const { showToast, removeToast, toasts } = useToast();
			showToast('Only one');

			removeToast('non-existent-id');
			expect(toasts.value).toHaveLength(1);
		});
	});

	describe('clearToasts', () => {
		it('removes all toasts', () => {
			const { showToast, clearToasts, toasts } = useToast();
			showToast('First');
			showToast('Second');
			showToast('Third');

			expect(toasts.value).toHaveLength(3);

			clearToasts();
			expect(toasts.value).toHaveLength(0);
		});
	});

	describe('multiple toasts', () => {
		it('accumulates toasts', () => {
			const { showToast, toasts } = useToast();
			showToast('One');
			showToast('Two');
			showToast('Three');

			expect(toasts.value).toHaveLength(3);
			expect(toasts.value[0]!.message).toBe('One');
			expect(toasts.value[1]!.message).toBe('Two');
			expect(toasts.value[2]!.message).toBe('Three');
		});
	});

	describe('shared state', () => {
		it('shares toasts between instances', () => {
			const instance1 = useToast();
			const instance2 = useToast();

			instance1.showToast('From instance 1');

			expect(instance2.toasts.value).toHaveLength(1);
			expect(instance2.toasts.value[0]!.message).toBe('From instance 1');
		});
	});
});
