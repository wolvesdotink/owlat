import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { verifyPostboxAppPassword } from '../postboxAuth.js';
import type { MtaConfig } from '../../config.js';

const config = {
	convexSiteUrl: 'https://convex.example.test',
	webhookSecret: 'mta-test-secret',
} as MtaConfig;

const fetchMock = vi.fn();

beforeEach(() => {
	fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ ok: false })));
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** The JSON body of the single verify request, after checking its signature. */
function signedBody(): Record<string, unknown> {
	expect(fetchMock).toHaveBeenCalledTimes(1);
	const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
	expect(url).toBe('https://convex.example.test/webhooks/mta-verify-credential');
	const headers = init.headers as Record<string, string>;
	const body = init.body as string;
	const expected = createHmac('sha256', config.webhookSecret)
		.update(`${headers['X-MTA-Timestamp']}.${body}`)
		.digest('hex');
	expect(headers['X-MTA-Signature']).toBe(expected);
	return JSON.parse(body) as Record<string, unknown>;
}

describe('verifyPostboxAppPassword', () => {
	it('carries the normalised client IP inside the signed body', async () => {
		await verifyPostboxAppPassword(config, 'Jane@Example.com', 'pw', 'smtp', {
			clientName: 'thunderbird.local',
			remoteIp: '::ffff:203.0.113.7',
		});
		expect(signedBody()).toEqual({
			address: 'jane@example.com',
			password: 'pw',
			scope: 'smtp',
			clientName: 'thunderbird.local',
			ip: '203.0.113.7',
		});
	});

	it('sends a canonical IPv6 client address', async () => {
		await verifyPostboxAppPassword(config, 'jane@example.com', 'pw', 'smtp', {
			remoteIp: '2001:0DB8:0:0::0001',
		});
		expect(signedBody()['ip']).toBe('2001:db8::1');
	});

	it('omits the ip field when the peer address is unknown', async () => {
		await verifyPostboxAppPassword(config, 'jane@example.com', 'pw', 'smtp', {
			remoteIp: 'unknown',
		});
		expect(signedBody()).not.toHaveProperty('ip');
	});
});
