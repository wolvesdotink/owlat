import { describe, it, expect, vi } from 'vitest';
import { useAuthForm } from '../useAuthForm';

describe('useAuthForm', () => {
	it('starts not loading with no error', () => {
		const { isLoading, errorMessage } = useAuthForm();
		expect(isLoading.value).toBe(false);
		expect(errorMessage.value).toBe('');
	});

	it('flips loading during the action and clears it after', async () => {
		const { isLoading, submit } = useAuthForm();
		let loadingDuring = false;

		await submit(async () => {
			loadingDuring = isLoading.value;
		});

		expect(loadingDuring).toBe(true);
		expect(isLoading.value).toBe(false);
	});

	it('clears a previous error before running', async () => {
		const { errorMessage, submit } = useAuthForm();
		await submit(async () => {
			throw new Error('first');
		});
		expect(errorMessage.value).toBe('first');

		await submit(async () => {
			/* succeeds */
		});
		expect(errorMessage.value).toBe('');
	});

	it('surfaces a thrown Error message', async () => {
		const { errorMessage, submit } = useAuthForm();
		await submit(async () => {
			throw new Error('Invalid credentials');
		});
		expect(errorMessage.value).toBe('Invalid credentials');
	});

	it('uses the fallback message for non-Error throws', async () => {
		const { errorMessage, submit } = useAuthForm();
		await submit(async () => {
			throw 'nope';
		}, 'Custom fallback');
		expect(errorMessage.value).toBe('Custom fallback');
	});

	it('always clears loading even when the action throws', async () => {
		const { isLoading, submit } = useAuthForm();
		await submit(async () => {
			throw new Error('boom');
		});
		expect(isLoading.value).toBe(false);
	});

	it('does not set an error on success', async () => {
		const { errorMessage, submit } = useAuthForm();
		const action = vi.fn(async () => {});
		await submit(action);
		expect(action).toHaveBeenCalledTimes(1);
		expect(errorMessage.value).toBe('');
	});
});
