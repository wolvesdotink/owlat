import { beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import type { MtaConfig } from '../../config.js';
import { isInboundTlsRequired } from '../../inbound/inboundTlsPolicy.js';
import { createMailboxRoutes } from '../mailboxes.js';

const API_KEY = 'test-master-key';
const config = { apiKey: API_KEY } as unknown as MtaConfig;

function authedPost(
	app: ReturnType<typeof createMailboxRoutes>,
	path: string,
	body: unknown
): Promise<Response> {
	return app.request(path, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	});
}

describe('mailbox cache control-plane routes', () => {
	let redis: RealRedis;
	let app: ReturnType<typeof createMailboxRoutes>;

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
		app = createMailboxRoutes(redis, config);
	});

	it('protects the inbound TLS policy with the master key', async () => {
		const response = await app.request('/inbound-tls-policy', { method: 'POST' });
		expect(response.status).toBe(401);
	});

	it('rejects a malformed inbound TLS policy', async () => {
		const response = await authedPost(app, '/inbound-tls-policy', { isRequired: 'false' });
		expect(response.status).toBe(400);
		expect(await isInboundTlsRequired(redis)).toBe(true);
	});

	it('applies an explicit owner/admin opt-out to the SMTP gate', async () => {
		const response = await authedPost(app, '/inbound-tls-policy', { isRequired: false });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true, isRequired: false });
		expect(await isInboundTlsRequired(redis)).toBe(false);
	});

	it('refreshes the policy alongside a mailbox cache write', async () => {
		await authedPost(app, '/inbound-tls-policy', { isRequired: false });
		const response = await authedPost(app, '/cache/alice@example.com', {
			mailboxId: 'mailbox-1',
			organizationId: 'organization-1',
			isInboundTlsRequired: true,
		});
		expect(response.status).toBe(200);
		expect(await isInboundTlsRequired(redis)).toBe(true);
	});
});
