/**
 * POST /sync: the user asked to check for mail now, so the worker runs a sync
 * cycle on each named account it holds a connection for. Same bearer gate as
 * the other Convex-facing routes.
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

function post(app: ReturnType<typeof createApp>, body: string, token = API_KEY) {
	return app.request('/sync', {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body,
	});
}

describe('POST /sync', () => {
	it('asks for a sync of the named accounts and says how many it holds', async () => {
		const requestSync = vi.fn(() => 1);
		const app = createApp(config, {} as ConvexClient, { requestSync });

		const res = await post(app, JSON.stringify({ accountIds: ['acc-1', 'acc-2'] }));

		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ accepted: 1 });
		expect(requestSync).toHaveBeenCalledWith(['acc-1', 'acc-2']);
	});

	it('refuses a body without a list of string ids', async () => {
		const requestSync = vi.fn(() => 0);
		const app = createApp(config, {} as ConvexClient, { requestSync });

		expect((await post(app, JSON.stringify({ accountIds: 'acc-1' }))).status).toBe(400);
		expect((await post(app, JSON.stringify({ accountIds: [5] }))).status).toBe(400);
		expect(requestSync).not.toHaveBeenCalled();
	});

	it('refuses a caller without the worker key', async () => {
		const requestSync = vi.fn(() => 0);
		const app = createApp(config, {} as ConvexClient, { requestSync });

		const res = await post(app, JSON.stringify({ accountIds: ['acc-1'] }), 'nope');

		expect(res.status).toBe(401);
		expect(requestSync).not.toHaveBeenCalled();
	});
});
