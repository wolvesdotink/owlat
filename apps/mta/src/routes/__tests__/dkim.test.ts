/**
 * Behaviour of the DKIM management routes — specifically the rotation safety
 * fix (PR-29).
 *
 * The old `/rotate` swapped the ACTIVE signing key immediately, which is
 * reachable on a LIVE domain and hard-breaks DKIM on ALL outbound mail until
 * the new public key propagates in DNS (RFC 6376 §3.6). The fix makes `/rotate`
 * delegate to the publish-then-switch overlap workflow whenever a key already
 * exists, and only set the key immediately for a brand-new domain. It also
 * exposes the overlap workflow directly via `/rotation`, `/rotation/activate`,
 * and `DELETE /rotation`.
 *
 * We drive the real Hono app over an ioredis-mock so every gate runs end to
 * end. The DNS-gated activation (which the route reaches with the production
 * resolver) is exercised directly against `activatePendingKey` with a stubbed
 * `TxtResolver`, since the resolver is the activation seam.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The rotation routes fire a `dkim.rotated` webhook back to Convex. Stub the
// notifier so the routes never make a real network call (which would retry for
// minutes against an unreachable Convex) — propagation wiring is covered by the
// dkimRotation + Convex adapter/dispatcher tests.
const notifyConvex = vi.fn(async () => true);
vi.mock('../../webhooks/convexNotifier.js', () => ({
	notifyConvex: (...args: unknown[]) => notifyConvex(...args),
}));

const { createDkimRoutes } = await import('../dkim.js');
const dkimStore = await import('../../smtp/dkimStore.js');
const dkimRotation = await import('../../smtp/dkimRotation.js');

import type { MtaConfig } from '../../config.js';

const API_KEY = 'test-master-key';
const config = { apiKey: API_KEY } as unknown as MtaConfig;

function authedRequest(
	app: ReturnType<typeof createDkimRoutes>,
	method: string,
	path: string,
	body?: unknown,
): Promise<Response> {
	return app.request(path, {
		method,
		headers: {
			Authorization: `Bearer ${API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

describe('DKIM rotation routes (PR-29)', () => {
	let redis: RealRedis;
	let app: ReturnType<typeof createDkimRoutes>;

	beforeEach(() => {
		redis = new Redis() as unknown as RealRedis;
		dkimStore.clearCache();
		app = createDkimRoutes(redis, config);
	});

	afterEach(async () => {
		dkimStore.clearCache();
		await redis.flushall();
		notifyConvex.mockClear();
		vi.restoreAllMocks();
	});

	describe('POST /:domain/rotate on a LIVE domain', () => {
		beforeEach(async () => {
			// Seed an existing, active key for the domain.
			await dkimStore.setDkimKey(redis, 'example.com', 's1', '-----BEGIN PRIVATE KEY-----\nseed\n-----END PRIVATE KEY-----');
			dkimStore.clearCache();
		});

		it('does NOT swap the active key — it initiates an overlap rotation instead', async () => {
			const res = await authedRequest(app, 'POST', '/example.com/rotate');
			expect(res.status).toBe(200);
			const json = (await res.json()) as {
				rotation: string;
				selector: string;
				dnsRecord: string;
				activateAfter: string;
			};
			expect(json.rotation).toBe('initiated');
			expect(json.selector).not.toBe('s1');
			expect(json.dnsRecord).toMatch(/^v=DKIM1; k=rsa; p=/);
			expect(typeof json.activateAfter).toBe('string');

			// The ACTIVE signing key is still s1 — outbound mail keeps signing
			// with the published selector until activation.
			dkimStore.clearCache();
			const active = await dkimStore.getDkimConfig(redis, 'example.com');
			expect(active?.selector).toBe('s1');
		});
	});

	describe('POST /:domain/rotation (initiate)', () => {
		beforeEach(async () => {
			await dkimStore.setDkimKey(redis, 'example.com', 's1', '-----BEGIN PRIVATE KEY-----\nseed\n-----END PRIVATE KEY-----');
			dkimStore.clearCache();
		});

		it('returns { selector, dnsRecord, activateAfter } and keeps signing with s1', async () => {
			const res = await authedRequest(app, 'POST', '/example.com/rotation');
			expect(res.status).toBe(200);
			const json = (await res.json()) as {
				selector: string;
				dnsRecord: string;
				activateAfter: string;
			};
			expect(json.selector).toBeTruthy();
			expect(json.selector).not.toBe('s1');
			expect(json.dnsRecord).toMatch(/^v=DKIM1; k=rsa; p=/);
			expect(typeof json.activateAfter).toBe('string');
			expect(Number.isNaN(Date.parse(json.activateAfter))).toBe(false);

			dkimStore.clearCache();
			const active = await dkimStore.getDkimConfig(redis, 'example.com');
			expect(active?.selector).toBe('s1');

			// The route propagated the new selector to Convex (RFC 6376 §3.6.1).
			expect(notifyConvex).toHaveBeenCalledTimes(1);
			const [event] = notifyConvex.mock.calls[0] as [Record<string, unknown>];
			expect(event).toMatchObject({
				event: 'dkim.rotated',
				domain: 'example.com',
				selector: json.selector,
				dnsRecord: json.dnsRecord,
				phase: 'pending',
			});
		});
	});

	describe('POST /:domain/rotation/activate before DNS publish', () => {
		beforeEach(async () => {
			await dkimStore.setDkimKey(redis, 'example.com', 's1', '-----BEGIN PRIVATE KEY-----\nseed\n-----END PRIVATE KEY-----');
			dkimStore.clearCache();
		});

		it('does not activate while the new selector record is unpublished', async () => {
			// Initiate via the route, then try to activate immediately. The
			// production resolver cannot resolve the freshly-minted selector, so
			// activation must be refused (and the active key stays s1).
			const initRes = await authedRequest(app, 'POST', '/example.com/rotation');
			expect(initRes.status).toBe(200);

			const res = await authedRequest(app, 'POST', '/example.com/rotation/activate');
			expect(res.status).toBe(200);
			const json = (await res.json()) as { activated: boolean };
			expect(json.activated).toBe(false);

			dkimStore.clearCache();
			const active = await dkimStore.getDkimConfig(redis, 'example.com');
			expect(active?.selector).toBe('s1');
		});
	});

	describe('activatePendingKey gated on a published DNS record (the activation seam)', () => {
		it('activates and serves the NEW selector once the record is published', async () => {
			await dkimStore.setDkimKey(redis, 'pub.example.com', 's1', '-----BEGIN PRIVATE KEY-----\nseed\n-----END PRIVATE KEY-----');
			dkimStore.clearCache();

			// Initiate directly so we capture the pending selector + dns record to
			// feed back through the stubbed resolver. overlapHours:0 removes the
			// timer wait so the DNS gate is the only thing under test.
			const init = await dkimRotation.initiateRotation(redis, 'pub.example.com', { overlapHours: 0 });
			const pubP = /p=([A-Za-z0-9+/=]+)/.exec(init.dnsRecord)![1]!;

			// While the record is unpublished, activation is refused.
			const emptyResolver = vi.fn().mockResolvedValue([]);
			const before = await dkimRotation.activatePendingKey(redis, 'pub.example.com', false, emptyResolver);
			expect(before.activated).toBe(false);
			dkimStore.clearCache();
			expect((await dkimStore.getDkimConfig(redis, 'pub.example.com'))?.selector).toBe('s1');

			// Now the resolver returns the published TXT record (chunked as DNS does).
			const resolver = vi.fn().mockResolvedValue([[`v=DKIM1; k=rsa; p=${pubP}`]]);
			const result = await dkimRotation.activatePendingKey(redis, 'pub.example.com', false, resolver);
			expect(result.activated).toBe(true);
			expect(result.selector).toBe(init.selector);

			dkimStore.clearCache();
			const active = await dkimStore.getDkimConfig(redis, 'pub.example.com');
			expect(active?.selector).toBe(init.selector);
			expect(active?.selector).not.toBe('s1');
		});

		it('refuses activation when the published record carries a different key', async () => {
			await dkimStore.setDkimKey(redis, 'wrong.example.com', 's1', '-----BEGIN PRIVATE KEY-----\nseed\n-----END PRIVATE KEY-----');
			dkimStore.clearCache();
			const init = await dkimRotation.initiateRotation(redis, 'wrong.example.com', { overlapHours: 0 });

			// Resolver returns a record with a mismatched public key.
			const resolver = vi.fn().mockResolvedValue([['v=DKIM1; k=rsa; p=SOMEOTHERKEY']]);
			const result = await dkimRotation.activatePendingKey(redis, 'wrong.example.com', false, resolver);
			expect(result.activated).toBe(false);

			dkimStore.clearCache();
			const active = await dkimStore.getDkimConfig(redis, 'wrong.example.com');
			expect(active?.selector).toBe('s1');
			expect(init.selector).not.toBe('s1');
		});
	});

	describe('POST /:domain/rotate on a BRAND-NEW domain', () => {
		it('sets the key immediately (nothing to break — no active key yet)', async () => {
			const res = await authedRequest(app, 'POST', '/new.example.com/rotate', { selector: 'fresh1' });
			expect(res.status).toBe(200);
			const json = (await res.json()) as { rotation: string; selector: string };
			expect(json.rotation).toBe('immediate');
			expect(json.selector).toBe('fresh1');

			dkimStore.clearCache();
			const active = await dkimStore.getDkimConfig(redis, 'new.example.com');
			expect(active?.selector).toBe('fresh1');
		});
	});

	describe('DELETE /:domain/rotation (cancel)', () => {
		it('cancels a pending rotation', async () => {
			await dkimStore.setDkimKey(redis, 'example.com', 's1', '-----BEGIN PRIVATE KEY-----\nseed\n-----END PRIVATE KEY-----');
			dkimStore.clearCache();
			await authedRequest(app, 'POST', '/example.com/rotation');

			const res = await authedRequest(app, 'DELETE', '/example.com/rotation');
			expect(res.status).toBe(200);

			// A second cancel finds nothing pending.
			const res2 = await authedRequest(app, 'DELETE', '/example.com/rotation');
			expect(res2.status).toBe(404);
		});
	});

	describe('auth', () => {
		it('rejects an unauthenticated rotation request', async () => {
			const res = await app.request('/example.com/rotation', { method: 'POST' });
			expect(res.status).toBe(401);
		});
	});
});
