/**
 * `POST /webhooks/mta-dmarc-report` — the HMAC-signed webhook the MTA forwards
 * Owlat's DMARC report address to (`domains/dmarcReportsHttp.ts`).
 */

import { readFileSync } from 'fs';
import { gzipSync } from 'node:zlib';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../../schema';
import { createTestDomain } from '../../__tests__/factories';
import { isDmarcReportAttachment } from '../dmarcReportsHttp';

vi.mock('node:dns/promises', () => {
	const fail = vi.fn(async () => {
		throw new Error('ENOTFOUND');
	});
	return { default: { reverse: fail, resolve4: fail, resolve6: fail } };
});

const rootGlob = import.meta.glob('../../**/*.*s');
const domainsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../domains/'),
		mod,
	])
);
const modules = { ...rootGlob, ...domainsGlob };

const PATH = '/webhooks/mta-dmarc-report';
const SECRET = 'mta-test-secret';

const begin = Math.floor((Date.now() - 86_400_000) / 1000);
const reportGz = gzipSync(
	readFileSync(new URL('../../../fixtures/dmarc/google-aggregate.xml', import.meta.url), 'utf8')
		.replace('1790726400', String(begin))
		.replace('1790812799', String(begin + 86_399))
).toString('base64');

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

function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

const body = JSON.stringify({
	attachments: [
		{
			filename: 'google.com!example.com.xml.gz',
			contentType: 'application/gzip',
			content: reportGz,
		},
	],
});

const SAVED_ENV = { ...process.env };

beforeEach(() => {
	process.env['MTA_WEBHOOK_SECRET'] = SECRET;
	delete process.env['RATE_LIMIT_TRUSTED_PROXY'];
});

afterEach(() => {
	process.env = { ...SAVED_ENV };
});

describe('handleDmarcReportWebhook', () => {
	it('ingests a correctly signed report', async () => {
		const t = setupTest();
		await t.run(async (ctx) =>
			ctx.db.insert('domains', createTestDomain({ domain: 'example.com' }))
		);
		const ts = Math.floor(Date.now() / 1000);
		const res = await t.fetch(PATH, {
			method: 'POST',
			body,
			headers: {
				'Content-Type': 'application/json',
				'x-mta-signature': await hmacSha256Hex(SECRET, `${ts}.${body}`),
				'x-mta-timestamp': String(ts),
			},
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		const stored = await t.run(async (ctx) => ctx.db.query('dmarcReports').collect());
		expect(stored).toHaveLength(1);
	});

	it('refuses a wrong signature and stores nothing', async () => {
		const t = setupTest();
		const ts = Math.floor(Date.now() / 1000);
		const res = await t.fetch(PATH, {
			method: 'POST',
			body,
			headers: {
				'Content-Type': 'application/json',
				'x-mta-signature': await hmacSha256Hex('wrong', `${ts}.${body}`),
				'x-mta-timestamp': String(ts),
			},
		});
		expect(res.status).toBe(401);
		const stored = await t.run(async (ctx) => ctx.db.query('dmarcReports').collect());
		expect(stored).toHaveLength(0);
	});

	it('recognises report attachments by type or name', () => {
		expect(isDmarcReportAttachment({ contentType: 'application/zip' })).toBe(true);
		expect(isDmarcReportAttachment({ filename: 'report.XML' })).toBe(true);
		expect(isDmarcReportAttachment({ contentType: 'image/png', filename: 'logo.png' })).toBe(false);
	});
});
