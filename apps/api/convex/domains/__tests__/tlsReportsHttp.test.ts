/**
 * `POST /webhooks/mta-tls-report` — the unauthenticated (HMAC-signed) inbound
 * TLS-RPT (RFC 8460) webhook (`domains/tlsReportsHttp.ts:handleTlsReportWebhook`).
 *
 * Exercises the route end-to-end through the HTTP router (convex-test `t.fetch`),
 * pinning the signature-verification contract the handler shares with the other
 * MTA webhooks and the decode/ingest fan-out through the `'use node'` action:
 *   - a fresh, correctly-signed request with a real gzip report → 200 ok:true,
 *     and a `tlsReports` row is persisted;
 *   - missing / wrong / stale signature → 401, and NOTHING is ingested;
 *   - a garbage (non-gzip) attachment on a valid signature → 200 ok:false, and
 *     nothing is ingested (acknowledged so the MTA stops retrying).
 *
 * Uses the same signing scheme as the handler, mirrored byte-for-byte below.
 */

import { readFileSync } from 'fs';
import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../../schema';

// Vite's `import.meta.glob` excludes the directory chain it climbed through, so
// `'../../**'` from `domains/__tests__` omits the sibling `domains/*` modules.
// Merge a second glob rooted at `domains/` and re-prefix its keys to the same
// `../../`-relative form so convex-test + the HTTP router resolve every entry.
const rootGlob = import.meta.glob('../../**/*.*s');
const domainsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../domains/'),
		mod,
	])
);
const modules = { ...rootGlob, ...domainsGlob };

const TLS_RPT_PATH = '/webhooks/mta-tls-report';
const SECRET = 'mta-test-secret';

const fixtureGzBase64 = readFileSync(
	new URL('../../../../../fixtures/sealed-mail/tls-report-sample.json.gz', import.meta.url)
).toString('base64');

// HMAC-SHA256 → lowercase hex, mirroring webhooks/security.ts:hmacSha256Hex.
async function hmacSha256Hex(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function setupTest() {
	const t = convexTest(schema, modules);
	// The handler rate-limits before signature verification, so the rate-limiter
	// component must be live.
	rateLimiterTest.register(t);
	return t;
}

interface Attachment {
	filename?: string;
	contentType?: string;
	content?: string;
}

function body(attachments: Attachment[]): string {
	return JSON.stringify({ attachments });
}

function signedHeaders(ts: number, sigHex: string): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		'x-mta-signature': sigHex,
		'x-mta-timestamp': String(ts),
	};
}

async function countReports(t: ReturnType<typeof setupTest>): Promise<number> {
	return t.run(async (ctx) => (await ctx.db.query('tlsReports').collect()).length);
}

const VALID_ATTACHMENTS: Attachment[] = [
	{ filename: 'report.json.gz', contentType: 'application/tlsrpt+gzip', content: fixtureGzBase64 },
];

const SAVED_ENV = { ...process.env };

beforeEach(() => {
	process.env['MTA_WEBHOOK_SECRET'] = SECRET;
	delete process.env['RATE_LIMIT_TRUSTED_PROXY'];
});

afterEach(() => {
	process.env = { ...SAVED_ENV };
});

describe('handleTlsReportWebhook (/webhooks/mta-tls-report)', () => {
	it('rejects (503) when MTA_WEBHOOK_SECRET is unset', async () => {
		delete process.env['MTA_WEBHOOK_SECRET'];
		const t = setupTest();
		const reqBody = body(VALID_ATTACHMENTS);
		const ts = nowSeconds();
		const sig = await hmacSha256Hex('whatever', `${ts}.${reqBody}`);
		const res = await t.fetch(TLS_RPT_PATH, {
			method: 'POST',
			body: reqBody,
			headers: signedHeaders(ts, sig),
		});
		expect(res.status).toBe(503);
		expect(await countReports(t)).toBe(0);
	});

	it('rejects (401) when signature headers are missing', async () => {
		const t = setupTest();
		const res = await t.fetch(TLS_RPT_PATH, {
			method: 'POST',
			body: body(VALID_ATTACHMENTS),
			headers: { 'Content-Type': 'application/json' },
		});
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({
			error: { category: 'unauthenticated', message: 'Missing signature' },
		});
		expect(await countReports(t)).toBe(0);
	});

	it('rejects (401) when the signature is wrong (and ingests nothing)', async () => {
		const t = setupTest();
		const reqBody = body(VALID_ATTACHMENTS);
		const ts = nowSeconds();
		const res = await t.fetch(TLS_RPT_PATH, {
			method: 'POST',
			body: reqBody,
			headers: signedHeaders(ts, 'deadbeef'),
		});
		expect(res.status).toBe(401);
		expect(await countReports(t)).toBe(0);
	});

	it('stops before authentication when Content-Length exceeds the body cap', async () => {
		const t = setupTest();
		const reqBody = body(VALID_ATTACHMENTS);
		const ts = nowSeconds();
		const sig = await hmacSha256Hex(SECRET, `${ts}.${reqBody}`);
		const res = await t.fetch(TLS_RPT_PATH, {
			method: 'POST',
			body: reqBody,
			headers: {
				...signedHeaders(ts, sig),
				'content-length': String(30 * 1024 * 1024),
			},
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: false, reason: 'payload-too-large' });
		expect(await countReports(t)).toBe(0);
	});

	it('rejects (401) when the timestamp is stale (>60s)', async () => {
		const t = setupTest();
		const reqBody = body(VALID_ATTACHMENTS);
		const staleTs = nowSeconds() - 120;
		const sig = await hmacSha256Hex(SECRET, `${staleTs}.${reqBody}`);
		const res = await t.fetch(TLS_RPT_PATH, {
			method: 'POST',
			body: reqBody,
			headers: signedHeaders(staleTs, sig),
		});
		expect(res.status).toBe(401);
		expect(await countReports(t)).toBe(0);
	});

	it('accepts (200) a fresh, correctly-signed report and persists a row', async () => {
		const t = setupTest();
		const reqBody = body(VALID_ATTACHMENTS);
		const ts = nowSeconds();
		const sig = await hmacSha256Hex(SECRET, `${ts}.${reqBody}`);
		const res = await t.fetch(TLS_RPT_PATH, {
			method: 'POST',
			body: reqBody,
			headers: signedHeaders(ts, sig),
		});
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.ok).toBe(true);
		expect(await countReports(t)).toBe(1);
	});

	it('acknowledges (200 ok:false) a garbage attachment without ingesting', async () => {
		const t = setupTest();
		// A `.gz`-named attachment whose bytes are not valid gzip — the shared
		// parser rejects it, the handler acks so the MTA stops retrying.
		const garbage = [
			{
				filename: 'junk.json.gz',
				contentType: 'application/tlsrpt+gzip',
				content: btoa('not gzip'),
			},
		];
		const reqBody = body(garbage);
		const ts = nowSeconds();
		const sig = await hmacSha256Hex(SECRET, `${ts}.${reqBody}`);
		const res = await t.fetch(TLS_RPT_PATH, {
			method: 'POST',
			body: reqBody,
			headers: signedHeaders(ts, sig),
		});
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.ok).toBe(false);
		expect(await countReports(t)).toBe(0);
	});

	it('acknowledges (200 ok:false) a payload with no report attachment', async () => {
		const t = setupTest();
		const reqBody = body([]);
		const ts = nowSeconds();
		const sig = await hmacSha256Hex(SECRET, `${ts}.${reqBody}`);
		const res = await t.fetch(TLS_RPT_PATH, {
			method: 'POST',
			body: reqBody,
			headers: signedHeaders(ts, sig),
		});
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.ok).toBe(false);
		expect(await countReports(t)).toBe(0);
	});
});
