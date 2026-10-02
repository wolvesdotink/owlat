import { createHmac } from 'node:crypto';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { signMtaRequest } from '@owlat/mta-protocol/signer';
import schema from '../schema';
import { expectScheduledFailure } from './helpers/scheduledFailures';

/**
 * Every route that accepts the MTA's `X-MTA-Signature` / `X-MTA-Timestamp`
 * pair must give the same verdict for the same signed request under the window
 * that route states:
 *
 *   /webhooks/mta                  provider feedback registry, 300 s
 *   /webhooks/mta-mailbox          raw message route, 300 s
 *   /webhooks/mta-inbound          raw message route, 300 s
 *   /webhooks/mta-tls-report       TLS-RPT report, 60 s
 *   /webhooks/mta-verify-credential app-password check, 60 s
 *
 * Each request is signed correctly over its own timestamp string, so the
 * verdict is decided by the timestamp rule alone. A rejection is a 401; any
 * other status means the signature layer let the request through and the
 * route's own validation answered (the bodies are deliberately minimal).
 */

const modules = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).filter(
		([p]) =>
			!p.includes('sesActions') &&
			!p.includes('agentSecurity') &&
			!p.includes('agentContext') &&
			!p.includes('agentClassifier') &&
			!p.includes('agentDrafter') &&
			!p.includes('agentRouter') &&
			!p.includes('agent/walker') &&
			!p.includes('agent/steps/index') &&
			!p.includes('agent/steps/shared') &&
			!p.includes('agent/steps/classify') &&
			!p.includes('agent/steps/draft') &&
			!p.includes('knowledgeExtraction') &&
			!p.includes('semanticFileProcessing') &&
			!p.includes('visualizationAgent') &&
			!p.includes('llmProvider')
	)
);

const SECRET = 'mta-test-secret';
const SAVED_ENV = { ...process.env };

beforeEach(() => {
	expectScheduledFailure('agent/walker:start');
	process.env['MTA_WEBHOOK_SECRET'] = SECRET;
	delete process.env['RATE_LIMIT_TRUSTED_PROXY'];
});

afterEach(() => {
	vi.useRealTimers();
	process.env = { ...SAVED_ENV };
});

const ROUTES = [
	{ path: '/webhooks/mta', windowSeconds: 300, body: { event: 'unsupported.kind' } },
	{ path: '/webhooks/mta-mailbox', windowSeconds: 300, body: { event: 'unsupported.kind' } },
	{ path: '/webhooks/mta-inbound', windowSeconds: 300, body: { event: 'unsupported.kind' } },
	{ path: '/webhooks/mta-tls-report', windowSeconds: 60, body: { attachments: [] } },
	{ path: '/webhooks/mta-verify-credential', windowSeconds: 60, body: {} },
] as const;

type TimestampCase = {
	label: string;
	timestamp: (nowSeconds: number) => string;
	/** Accepted when the route's window is at least this many seconds; null = never. */
	acceptedFromWindow: number | null;
};

const TIMESTAMPS: readonly TimestampCase[] = [
	{ label: 'now', timestamp: (now) => String(now), acceptedFromWindow: 0 },
	{ label: 'now with trailing letters', timestamp: (now) => `${now}abc`, acceptedFromWindow: null },
	{ label: 'now with a fraction', timestamp: (now) => `${now}.0`, acceptedFromWindow: null },
	{
		label: 'a fixed past value with letters',
		timestamp: () => '1700000000abc',
		acceptedFromWindow: null,
	},
	{ label: 'a negative value', timestamp: () => '-5', acceptedFromWindow: null },
	{ label: 'now minus 90 seconds', timestamp: (now) => String(now - 90), acceptedFromWindow: 90 },
];

async function send(path: string, timestamp: string, body: string): Promise<number> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	const signature = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
	const res = await t.fetch(path, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-MTA-Timestamp': timestamp,
			'X-MTA-Signature': signature,
		},
		body,
	});
	return res.status;
}

describe('MTA-signed routes share one timestamp rule', () => {
	for (const route of ROUTES) {
		describe(`${route.path} (${route.windowSeconds}s window)`, () => {
			for (const tc of TIMESTAMPS) {
				const accepted =
					tc.acceptedFromWindow !== null && route.windowSeconds >= tc.acceptedFromWindow;
				it(`${accepted ? 'accepts' : 'rejects'} a timestamp of ${tc.label}`, async () => {
					const status = await send(
						route.path,
						tc.timestamp(Math.floor(Date.now() / 1000)),
						JSON.stringify(route.body)
					);
					if (accepted) {
						expect(status).not.toBe(401);
					} else {
						expect(status).toBe(401);
					}
				});
			}
		});
	}
});

describe('MTA-signed routes check the signature before spending the ingestion bucket', () => {
	const RATE_LIMITED_ROUTES = [
		{ path: '/webhooks/mta', body: { event: 'unsupported.kind' } },
		{ path: '/webhooks/mta-tls-report', body: { attachments: [] } },
		{ path: '/webhooks/mta-verify-credential', body: {} },
	] as const;

	for (const route of RATE_LIMITED_ROUTES) {
		it(`${route.path} answers a signed request after an unsigned burst`, async () => {
			const t = convexTest(schema, modules);
			rateLimiterTest.register(t);
			const body = JSON.stringify(route.body);

			// More unsigned requests than the bucket holds, sent at once.
			const unsigned = await Promise.all(
				Array.from({ length: 150 }, () =>
					t.fetch(route.path, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body,
					})
				)
			);
			expect(unsigned.every((res) => res.status === 401)).toBe(true);

			const timestamp = String(Math.floor(Date.now() / 1000));
			const signature = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
			const signed = await t.fetch(route.path, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-MTA-Timestamp': timestamp,
					'X-MTA-Signature': signature,
				},
				body,
			});
			expect([401, 429]).not.toContain(signed.status);
		});
	}
});

describe('MTA raw routes keep a separate bucket for bodies read before verification', () => {
	for (const path of ['/webhooks/mta-inbound', '/webhooks/mta-mailbox'] as const) {
		it(`${path} answers a small signed request after a burst of undeclared-length requests`, async () => {
			// Hold the clock still so the bucket cannot refill between the burst and
			// the signed request.
			vi.useFakeTimers({ toFake: ['Date'] });
			const t = convexTest(schema, modules);
			rateLimiterTest.register(t);
			const body = JSON.stringify({ event: 'unsupported.kind' });
			const timestamp = String(Math.floor(Date.now() / 1000));

			// Signature headers present but wrong, and no Content-Length: these are
			// charged before their body is read.
			const unverified = await Promise.all(
				Array.from({ length: 150 }, () =>
					t.fetch(path, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'X-MTA-Timestamp': timestamp,
							'X-MTA-Signature': '0'.repeat(64),
						},
						body,
					})
				)
			);
			expect(unverified.some((res) => res.status === 429)).toBe(true);

			const signature = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
			const signed = await t.fetch(path, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': String(Buffer.byteLength(body)),
					'X-MTA-Timestamp': timestamp,
					'X-MTA-Signature': signature,
				},
				body,
			});
			expect([401, 429]).not.toContain(signed.status);
		});
	}
});

describe('MTA raw routes keep large signed deliveries off the unverified key', () => {
	for (const path of ['/webhooks/mta-inbound', '/webhooks/mta-mailbox'] as const) {
		it(`${path} answers a large signed request after the unverified key is exhausted`, async () => {
			vi.useFakeTimers({ toFake: ['Date'] });
			const t = convexTest(schema, modules);
			rateLimiterTest.register(t);
			const timestamp = String(Math.floor(Date.now() / 1000));
			const junk = JSON.stringify({ event: 'unsupported.kind' });

			const unverified = await Promise.all(
				Array.from({ length: 150 }, () =>
					t.fetch(path, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'X-MTA-Timestamp': timestamp,
							'X-MTA-Signature': '0'.repeat(64),
						},
						body: junk,
					})
				)
			);
			expect(unverified.some((res) => res.status === 429)).toBe(true);

			// Over the 256 KiB free-verification size, signed the way the MTA signs.
			const body = JSON.stringify({ event: 'unsupported.kind', padding: 'x'.repeat(300 * 1024) });
			const large = (headers: Record<string, string>) =>
				t.fetch(path, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Content-Length': String(Buffer.byteLength(body)),
						...headers,
					},
					body,
				});

			// Without a valid length signature it still shares the unverified key.
			const signedHeaders = signMtaRequest(SECRET, body);
			const forgedLength = await large({
				...signedHeaders,
				'X-MTA-Length-Signature': '0'.repeat(64),
			});
			expect(forgedLength.status).toBe(429);

			const signed = await large(signedHeaders);
			expect([401, 429]).not.toContain(signed.status);
		});

		it(`${path} charges the unverified key when a length-signed body does not verify`, async () => {
			vi.useFakeTimers({ toFake: ['Date'] });
			const t = convexTest(schema, modules);
			rateLimiterTest.register(t);
			const body = JSON.stringify({ event: 'unsupported.kind', padding: 'x'.repeat(300 * 1024) });
			const other = body.replace('unsupported', 'unsupporteX');
			const headers = {
				'Content-Type': 'application/json',
				'Content-Length': String(Buffer.byteLength(other)),
				...signMtaRequest(SECRET, body),
			};

			// More failed length-signed deliveries than the unverified key holds.
			const failed = await Promise.all(
				Array.from({ length: 110 }, () => t.fetch(path, { method: 'POST', headers, body: other }))
			);
			// Each is refused; once the key is empty the refusal is the 429 itself.
			expect(failed.every((res) => res.status === 401 || res.status === 429)).toBe(true);
			expect(failed.some((res) => res.status === 429)).toBe(true);

			// A request that pays the unverified key up front now finds it empty.
			const junk = JSON.stringify({ event: 'unsupported.kind' });
			const unverified = await t.fetch(path, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-MTA-Timestamp': String(Math.floor(Date.now() / 1000)),
					'X-MTA-Signature': '0'.repeat(64),
				},
				body: junk,
			});
			expect(unverified.status).toBe(429);
		});

		it(`${path} refuses a length-signed request whose body does not verify`, async () => {
			const t = convexTest(schema, modules);
			rateLimiterTest.register(t);
			const body = JSON.stringify({ event: 'unsupported.kind', padding: 'x'.repeat(300 * 1024) });
			const other = body.replace('unsupported', 'unsupporteX');
			const res = await t.fetch(path, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': String(Buffer.byteLength(other)),
					...signMtaRequest(SECRET, body),
				},
				body: other,
			});
			expect(res.status).toBe(401);
		});
	}
});

describe('the credential-check route keys its ingestion bucket on the signed client IP', () => {
	it('answers one client after a burst from many others', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const check = (clientIp: string) => {
			const body = JSON.stringify({
				address: 'nobody@example.com',
				password: 'wrong-password',
				scope: 'smtp',
				ip: clientIp,
			});
			return t.fetch('/webhooks/mta-verify-credential', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...signMtaRequest(SECRET, body) },
				body,
			});
		};

		// More signed checks than one bucket holds, each for a different client.
		const burst = await Promise.all(
			Array.from({ length: 150 }, (_, i) => check(`203.0.${Math.floor(i / 250)}.${(i % 250) + 1}`))
		);
		expect(burst.every((res) => res.status === 200)).toBe(true);

		expect((await check('192.0.2.44')).status).toBe(200);
	});
});
