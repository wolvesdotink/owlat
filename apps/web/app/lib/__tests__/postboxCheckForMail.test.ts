import { describe, expect, it, vi } from 'vitest';
import type { ConvexClient } from 'convex/browser';
import { checkForMail, requestMailCheck } from '../postboxCheckForMail';

function client(answer: () => Promise<unknown>): ConvexClient {
	// `mutation` answers like a backend that only scheduled the worker call and
	// reported success whether or not mail-sync took it.
	return {
		action: vi.fn(answer),
		mutation: vi.fn(async () => ({ accounts: 1 })),
	} as unknown as ConvexClient;
}

describe('requestMailCheck', () => {
	it('names what the backend did with the request', async () => {
		expect(await requestMailCheck(client(async () => ({ status: 'checking' })))).toBe('checking');
		expect(await requestMailCheck(client(async () => ({ status: 'nothing_to_check' })))).toBe(
			'nothing'
		);
		expect(await requestMailCheck(client(async () => ({ status: 'rate_limited' })))).toBe('busy');
	});

	it('fails when mail-sync did not take the request', async () => {
		expect(await requestMailCheck(client(async () => ({ status: 'failed' })))).toBe('failed');
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

		await checkForMail({ client: client(async () => ({ status: 'checking' })), t, showToast });
		await checkForMail({ client: client(async () => ({ status: 'failed' })), t, showToast });
		await checkForMail({ client: null, t, showToast });

		expect(showToast.mock.calls).toEqual([
			['t:postbox.checkForMail.checking', 'info'],
			['t:postbox.checkForMail.failed', 'error'],
			['t:postbox.checkForMail.failed', 'error'],
		]);
	});
});
