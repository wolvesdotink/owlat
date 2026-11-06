import { describe, expect, it, vi } from 'vitest';
import type { ConvexClient } from 'convex/browser';
import { checkForMail, requestMailCheck } from '../postboxCheckForMail';

function client(answer: () => Promise<unknown>): ConvexClient {
	return { mutation: vi.fn(answer) } as unknown as ConvexClient;
}

describe('requestMailCheck', () => {
	it('names what the backend did with the request', async () => {
		expect(await requestMailCheck(client(async () => ({ accounts: 2 })))).toBe('checking');
		expect(await requestMailCheck(client(async () => ({ accounts: 0 })))).toBe('nothing');
		expect(await requestMailCheck(client(async () => ({ accounts: 1, throttled: true })))).toBe(
			'busy'
		);
	});

	it('fails without a client or when the request throws', async () => {
		expect(await requestMailCheck(null)).toBe('failed');
		expect(
			await requestMailCheck(
				client(async () => {
					throw new Error('offline');
				})
			)
		).toBe('failed');
	});
});

describe('checkForMail', () => {
	it('tells the user the outcome, as an error only when it failed', async () => {
		const showToast = vi.fn();
		const t = (key: string) => `t:${key}`;

		await checkForMail({ client: client(async () => ({ accounts: 1 })), t, showToast });
		await checkForMail({ client: null, t, showToast });

		expect(showToast.mock.calls).toEqual([
			['t:postbox.checkForMail.checking', 'info'],
			['t:postbox.checkForMail.failed', 'error'],
		]);
	});
});
