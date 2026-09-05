import { describe, expect, it, vi } from 'vitest';
import { fireAndForget } from '../fireAndForget.js';

describe('fireAndForget', () => {
	it('resolves quietly when the operation succeeds', async () => {
		const logger = { warn: vi.fn() };

		await expect(
			fireAndForget(Promise.resolve('ok'), logger, 'heartbeat')
		).resolves.toBeUndefined();

		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('logs the rejection under the operation label and never rejects', async () => {
		const logger = { warn: vi.fn() };
		const failure = new Error('redis down');

		await expect(
			fireAndForget(Promise.reject(failure), logger, 'heartbeat')
		).resolves.toBeUndefined();

		expect(logger.warn).toHaveBeenCalledWith(
			{ err: failure, operation: 'heartbeat' },
			'Best-effort operation failed'
		);
	});
});
