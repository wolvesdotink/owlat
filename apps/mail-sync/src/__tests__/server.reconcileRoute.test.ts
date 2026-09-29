/**
 * POST /reconcile — Convex pokes the worker after a mailbox is connected, so
 * the new account's IMAP connection opens now instead of on the next reconcile
 * tick (plan 3.6). Same bearer gate as /send and /test.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ConvexClient } from '../convex.js';
import type { MailSyncConfig } from '../config.js';

vi.mock('../logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createApp } = await import('../server.js');

const API_KEY = 'test-api-key';
const config = { apiKey: API_KEY, allowedFetchOrigins: [] } as unknown as MailSyncConfig;

describe('POST /reconcile', () => {
	it('starts a reconcile pass and answers 202 without waiting for it', async () => {
		const requestReconcile = vi.fn();
		const app = createApp(config, {} as ConvexClient, { requestReconcile });

		const res = await app.request('/reconcile', {
			method: 'POST',
			headers: { Authorization: `Bearer ${API_KEY}` },
		});

		expect(res.status).toBe(202);
		expect(requestReconcile).toHaveBeenCalledTimes(1);
	});

	it('refuses a caller without the worker key', async () => {
		const requestReconcile = vi.fn();
		const app = createApp(config, {} as ConvexClient, { requestReconcile });

		const missing = await app.request('/reconcile', { method: 'POST' });
		const wrong = await app.request('/reconcile', {
			method: 'POST',
			headers: { Authorization: 'Bearer nope' },
		});

		expect(missing.status).toBe(401);
		expect(wrong.status).toBe(401);
		expect(requestReconcile).not.toHaveBeenCalled();
	});
});
