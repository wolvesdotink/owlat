import { createHmac } from 'node:crypto';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
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

describe('/webhooks/mta-verify-credential rate limit', () => {
	it('checks the signature before spending the ingestion bucket', async () => {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		const path = '/webhooks/mta-verify-credential';
		const body = JSON.stringify({});

		// More unsigned requests than the bucket holds, sent at once.
		const unsigned = await Promise.all(
			Array.from({ length: 150 }, () =>
				t.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
			)
		);
		expect(unsigned.every((res) => res.status === 401)).toBe(true);

		const timestamp = String(Math.floor(Date.now() / 1000));
		const signature = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
		const signed = await t.fetch(path, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-MTA-Timestamp': timestamp,
				'X-MTA-Signature': signature,
			},
			body,
		});
		expect(signed.status).toBe(400);
	});
});
