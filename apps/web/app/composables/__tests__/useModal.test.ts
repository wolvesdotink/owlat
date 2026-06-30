import { describe, it, expect, vi } from 'vitest';
import { useModal, useConfirmModal } from '../useModal';

describe('useModal', () => {
	describe('initial state', () => {
		it('starts closed with no loading, error, or data', () => {
			const modal = useModal();

			expect(modal.isOpen.value).toBe(false);
			expect(modal.isLoading.value).toBe(false);
			expect(modal.error.value).toBe(null);
			expect(modal.data.value).toBe(null);
		});
	});

	describe('open', () => {
		it('sets isOpen to true', () => {
			const modal = useModal();
			modal.open();

			expect(modal.isOpen.value).toBe(true);
		});

		it('clears any existing error', () => {
			const modal = useModal();
			modal.setError('old error');
			modal.open();

			expect(modal.error.value).toBe(null);
		});

		it('sets data when provided', () => {
			const modal = useModal<{ name: string }>();
			modal.open({ name: 'Test' });

			expect(modal.data.value).toEqual({ name: 'Test' });
		});

		it('does not overwrite data when no argument is passed', () => {
			const modal = useModal<string>();
			modal.open('initial');
			modal.close();
			modal.open();

			expect(modal.data.value).toBe('initial');
		});

		it('calls onOpen callback', () => {
			const onOpen = vi.fn();
			const modal = useModal({ onOpen });
			modal.open();

			expect(onOpen).toHaveBeenCalledTimes(1);
		});
	});

	describe('close', () => {
		it('sets isOpen to false', () => {
			const modal = useModal();
			modal.open();
			modal.close();

			expect(modal.isOpen.value).toBe(false);
		});

		it('resets isLoading to false', () => {
			const modal = useModal();
			modal.setLoading(true);
			modal.close();

			expect(modal.isLoading.value).toBe(false);
		});

		it('clears error', () => {
			const modal = useModal();
			modal.setError('some error');
			modal.close();

			expect(modal.error.value).toBe(null);
		});

		it('calls onClose callback', () => {
			const onClose = vi.fn();
			const modal = useModal({ onClose });
			modal.open();
			modal.close();

			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('reset', () => {
		it('clears data, error, and isLoading', () => {
			const modal = useModal<string>();
			modal.open('some data');
			modal.setError('an error');
			modal.setLoading(true);

			modal.reset();

			expect(modal.data.value).toBe(null);
			expect(modal.error.value).toBe(null);
			expect(modal.isLoading.value).toBe(false);
		});
	});

	describe('setError / clearError', () => {
		it('setError sets the error message', () => {
			const modal = useModal();
			modal.setError('Something failed');

			expect(modal.error.value).toBe('Something failed');
		});

		it('clearError clears the error', () => {
			const modal = useModal();
			modal.setError('Something failed');
			modal.clearError();

			expect(modal.error.value).toBe(null);
		});
	});

	describe('setLoading', () => {
		it('sets isLoading to true', () => {
			const modal = useModal();
			modal.setLoading(true);

			expect(modal.isLoading.value).toBe(true);
		});

		it('sets isLoading to false', () => {
			const modal = useModal();
			modal.setLoading(true);
			modal.setLoading(false);

			expect(modal.isLoading.value).toBe(false);
		});
	});

	describe('execute', () => {
		it('sets loading during execution', async () => {
			const modal = useModal();
			let loadingDuringAction = false;

			await modal.execute(async () => {
				loadingDuringAction = modal.isLoading.value;
				return 'result';
			});

			expect(loadingDuringAction).toBe(true);
			expect(modal.isLoading.value).toBe(false);
		});

		it('clears error before execution', async () => {
			const modal = useModal();
			modal.setError('previous error');

			await modal.execute(async () => 'ok');

			expect(modal.error.value).toBe(null);
		});

		it('returns the action result', async () => {
			const modal = useModal();
			const result = await modal.execute(async () => 42);

			expect(result).toBe(42);
		});

		it('closes modal on success by default', async () => {
			const modal = useModal();
			modal.open();

			await modal.execute(async () => 'done');

			expect(modal.isOpen.value).toBe(false);
		});

		it('does not close when closeOnSuccess is false', async () => {
			const modal = useModal();
			modal.open();

			await modal.execute(async () => 'done', { closeOnSuccess: false });

			expect(modal.isOpen.value).toBe(true);
		});

		it('calls onSuccess callback with result', async () => {
			const modal = useModal();
			const onSuccess = vi.fn();

			await modal.execute(async () => 'result', { onSuccess });

			expect(onSuccess).toHaveBeenCalledWith('result');
		});

		it('sets error on failure', async () => {
			const modal = useModal();

			await modal.execute(async () => {
				throw new Error('Action failed');
			});

			expect(modal.error.value).toBe('Action failed');
		});

		it('returns undefined on failure', async () => {
			const modal = useModal();

			const result = await modal.execute(async () => {
				throw new Error('fail');
			});

			expect(result).toBeUndefined();
		});

		it('calls onError callback on failure', async () => {
			const modal = useModal();
			const onError = vi.fn();
			const thrownError = new Error('Action failed');

			await modal.execute(
				async () => {
					throw thrownError;
				},
				{ onError }
			);

			expect(onError).toHaveBeenCalledWith(thrownError);
		});

		it('handles non-Error throws gracefully', async () => {
			const modal = useModal();
			const onError = vi.fn();

			await modal.execute(
				async () => {
					throw 'string error';
				},
				{ onError }
			);

			expect(modal.error.value).toBe('An error occurred');
			expect(onError).toHaveBeenCalledWith(expect.any(Error));
		});

		it('always resets loading in finally block', async () => {
			const modal = useModal();

			await modal.execute(async () => {
				throw new Error('fail');
			});

			expect(modal.isLoading.value).toBe(false);
		});

		it('does not close modal on failure', async () => {
			const modal = useModal();
			modal.open();

			await modal.execute(async () => {
				throw new Error('fail');
			});

			expect(modal.isOpen.value).toBe(true);
		});
	});
});

describe('useConfirmModal', () => {
	it('returns all useModal properties', () => {
		const modal = useConfirmModal();

		expect(modal.isOpen).toBeDefined();
		expect(modal.isLoading).toBeDefined();
		expect(modal.error).toBeDefined();
		expect(modal.data).toBeDefined();
		expect(modal.open).toBeDefined();
		expect(modal.close).toBeDefined();
		expect(modal.reset).toBeDefined();
		expect(modal.confirm).toBeDefined();
	});

	describe('confirm', () => {
		it('delegates to execute with closeOnSuccess true', async () => {
			const modal = useConfirmModal();
			modal.open();

			await modal.confirm(async () => {});

			expect(modal.isOpen.value).toBe(false);
		});

		it('passes onSuccess callback', async () => {
			const modal = useConfirmModal();
			const onSuccess = vi.fn();

			await modal.confirm(async () => {}, { onSuccess });

			expect(onSuccess).toHaveBeenCalledTimes(1);
		});

		it('passes onError callback', async () => {
			const modal = useConfirmModal();
			const onError = vi.fn();

			await modal.confirm(
				async () => {
					throw new Error('confirm failed');
				},
				{ onError }
			);

			expect(onError).toHaveBeenCalledWith(expect.any(Error));
			expect(modal.error.value).toBe('confirm failed');
		});
	});
});
