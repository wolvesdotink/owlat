import { afterEach, describe, expect, it, vi } from 'vitest';
import { sleep } from '../sleep';

describe('sleep', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('resolves once the requested time has elapsed on the global timer', async () => {
		vi.useFakeTimers();
		let resolved = false;
		const pending = sleep(50).then(() => {
			resolved = true;
		});
		await vi.advanceTimersByTimeAsync(49);
		expect(resolved).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await pending;
		expect(resolved).toBe(true);
	});
});
