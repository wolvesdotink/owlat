/**
 * The audit row `/webhooks/mta-mailbox` writes (`mail/webhookHttp.ts`).
 *
 * This route's body carries `rawBytesBase64`, the whole message, so retaining it
 * verbatim kept a SECOND full base64 copy of every email in the database for 90
 * days beside the `_storage` blob that already holds it — and for anything over
 * roughly 768 KiB raw the insert hit Convex's 1 MiB document cap and threw into
 * a bare `catch`, so the audit trail silently did not exist for exactly the
 * messages that carry attachments.
 *
 * What is pinned here: the row is a bounded summary (digest + sizes + envelope
 * identifiers, never the message bytes), it is written for a body we could not
 * even parse, and it stays far inside the document cap however big the delivery.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import schema from '../schema';

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
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

const MAILBOX_PATH = '/webhooks/mta-mailbox';
const SECRET = 'mailbox-audit-test-secret';
/** Convex's hard per-document limit — the cap the old row could cross. */
const CONVEX_DOCUMENT_MAX_BYTES = 1024 * 1024;
const savedEnv = { ...process.env };

function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return Array.from(new Uint8Array(signature))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

async function postSigned(t: ReturnType<typeof setupTest>, body: string): Promise<Response> {
	const ts = String(Math.floor(Date.now() / 1000));
	const sig = await hmacSha256Hex(SECRET, `${ts}.${body}`);
	return t.fetch(MAILBOX_PATH, {
		method: 'POST',
		body,
		headers: {
			'Content-Type': 'application/json',
			'x-mta-signature': sig,
			'x-mta-timestamp': ts,
		},
	});
}

async function auditRows(t: ReturnType<typeof setupTest>) {
	return t.run(async (ctx) => ctx.db.query('webhookPayloads').collect());
}

beforeEach(() => {
	process.env['MTA_WEBHOOK_SECRET'] = SECRET;
	delete process.env['RATE_LIMIT_TRUSTED_PROXY'];
});

afterEach(() => {
	process.env = { ...savedEnv };
});

describe('POST /webhooks/mta-mailbox audit row', () => {
	it('summarises a big delivery instead of storing a second copy of the message', async () => {
		const t = setupTest();
		// ~1.2 MiB of base64 — a perfectly ordinary message with an attachment,
		// and past the 1 MiB document cap once wrapped in the JSON envelope.
		const rawBytesBase64 = 'QUFB'.repeat(300_000);
		const body = JSON.stringify({
			event: 'inbound.mailbox.received',
			timestamp: Date.now(),
			mailboxPayload: {
				deliveryId: 'delivery-big',
				recipientAddress: 'inbox@acme.test',
				rawBytesBase64,
				from: 'sender@example.com',
				to: ['inbox@acme.test'],
				subject: 'quarterly report',
				messageId: '<big-1@example.com>',
				attachments: [
					{
						filename: 'report.pdf',
						contentType: 'application/pdf',
						size: 900_000,
						partIndex: '2',
					},
				],
			},
		});

		const res = await postSigned(t, body);
		expect(res.status).not.toBe(401);
		expect(res.status).not.toBe(503);

		const rows = await auditRows(t);
		expect(rows).toHaveLength(1);
		const row = rows[0];
		if (!row) throw new Error('no audit row');
		expect(row.source).toBe('mta-mailbox');

		// The message bytes are NOT in the audit row, and the row is nowhere near
		// the document cap no matter how large the delivery was.
		expect(row.rawPayload).not.toContain(rawBytesBase64);
		expect(new TextEncoder().encode(row.rawPayload).length).toBeLessThan(CONVEX_DOCUMENT_MAX_BYTES);
		expect(row.rawPayload.length).toBeLessThan(2_000);

		// What it keeps instead: proof of which bytes arrived, how big they were,
		// and who they were for.
		const summary = JSON.parse(row.rawPayload) as Record<string, unknown>;
		expect(summary['event']).toBe('inbound.mailbox.received');
		expect(summary['bodySha256']).toBe(await sha256Hex(body));
		expect(summary['bodyChars']).toBe(body.length);
		expect(summary['rawMessageBytes']).toBe(900_000);
		expect(summary['deliveryId']).toBe('delivery-big');
		expect(summary['messageId']).toBe('<big-1@example.com>');
		expect(summary['recipientAddress']).toBe('inbox@acme.test');
		expect(summary['from']).toBe('sender@example.com');
		expect(summary['attachmentCount']).toBe(1);
	});

	it('audits a body it could not parse rather than dropping the trail', async () => {
		const t = setupTest();
		const body = 'not json at all';

		const res = await postSigned(t, body);
		expect(res.status).toBe(400);

		const rows = await auditRows(t);
		expect(rows).toHaveLength(1);
		const row = rows[0];
		if (!row) throw new Error('no audit row');
		const summary = JSON.parse(row.rawPayload) as Record<string, unknown>;
		expect(summary['event']).toBe('unparseable');
		expect(summary['bodySha256']).toBe(await sha256Hex(body));
	});

	it('still audits a delivery whose rawBytesBase64 is not a string', async () => {
		const t = setupTest();
		// Nothing validates the parsed body's shape. A numeric `rawBytesBase64` is
		// truthy, so the byte-length helper used to throw a `TypeError` into
		// `auditDelivery`'s catch and the delivery went through with no audit row —
		// the exact silent gap the summary was written to close.
		const body = JSON.stringify({
			event: 'inbound.mailbox.received',
			timestamp: Date.now(),
			mailboxPayload: {
				deliveryId: 'delivery-odd',
				recipientAddress: 'inbox@acme.test',
				rawBytesBase64: 12345,
				from: 'sender@example.com',
				to: ['inbox@acme.test'],
				subject: 'odd',
				messageId: '<odd-1@example.com>',
			},
		});

		const res = await postSigned(t, body);
		expect(res.status).not.toBe(401);

		const rows = await auditRows(t);
		expect(rows).toHaveLength(1);
		const summary = JSON.parse(rows[0]!.rawPayload) as Record<string, unknown>;
		expect(summary['deliveryId']).toBe('delivery-odd');
		expect(summary['bodySha256']).toBe(await sha256Hex(body));
		// No number to report, and no exception either.
		expect(summary['rawMessageBytes']).toBeUndefined();
	});

	it('counts line-wrapped base64 as the bytes it decodes to', async () => {
		const t = setupTest();
		// MIME wraps base64 at 76 columns (RFC 2045 §6.8). 300 wrapped lines of
		// 'AAA' repeats decode to 17,100 bytes; counting the CRLFs as payload
		// over-reports by 448 against the `rawSize` this number is compared with.
		const rawBytesBase64 = Array.from({ length: 300 }, () => 'QUFB'.repeat(19)).join('\r\n');
		const body = JSON.stringify({
			event: 'inbound.mailbox.received',
			timestamp: Date.now(),
			mailboxPayload: {
				deliveryId: 'delivery-wrapped',
				recipientAddress: 'inbox@acme.test',
				rawBytesBase64,
				from: 'sender@example.com',
				to: ['inbox@acme.test'],
				subject: 'wrapped',
				messageId: '<wrapped-1@example.com>',
			},
		});

		await postSigned(t, body);

		const rows = await auditRows(t);
		const summary = JSON.parse(rows[0]!.rawPayload) as Record<string, unknown>;
		expect(summary['rawMessageBytes']).toBe(17_100);
	});

	it('does not call a parseable body unparseable just because its event is not a string', async () => {
		const t = setupTest();
		const body = JSON.stringify({ event: 42, timestamp: Date.now(), mailboxPayload: {} });

		await postSigned(t, body);

		const rows = await auditRows(t);
		const summary = JSON.parse(rows[0]!.rawPayload) as Record<string, unknown>;
		// 'unparseable' is the one label an operator reads as "the MTA sent us
		// bytes that are not JSON" — this body is JSON.
		expect(summary['event']).toBe('missing-event');
	});

	it('keeps a bounded head of a body it could not parse', async () => {
		const t = setupTest();
		const body = '<<<not json at all>>>';

		await postSigned(t, body);

		const rows = await auditRows(t);
		const summary = JSON.parse(rows[0]!.rawPayload) as Record<string, unknown>;
		// A digest of bytes nobody kept proves only that we could not read them.
		expect(summary['head']).toBe(body);
	});

	it('keeps no head of a body it COULD parse — the body is the message', async () => {
		const t = setupTest();
		const body = JSON.stringify({
			event: 'inbound.mailbox.received',
			timestamp: Date.now(),
			mailboxPayload: {
				deliveryId: 'delivery-headless',
				recipientAddress: 'inbox@acme.test',
				rawBytesBase64: 'QUFB',
				from: 'sender@example.com',
				to: ['inbox@acme.test'],
				subject: 'secret subject',
				textBody: 'secret body',
				messageId: '<headless-1@example.com>',
			},
		});

		await postSigned(t, body);

		const rows = await auditRows(t);
		const summary = JSON.parse(rows[0]!.rawPayload) as Record<string, unknown>;
		expect(summary['head']).toBeUndefined();
		expect(rows[0]!.rawPayload).not.toContain('secret body');
	});
});
