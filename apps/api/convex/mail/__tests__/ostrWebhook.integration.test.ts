/**
 * The OSTR fields on the inbound mailbox webhook (plan §12.2), end to end.
 *
 * Drives the REAL `POST /webhooks/mta-mailbox` route — HMAC verification, the
 * `ingestFromWebhook` action, `deliverToMailbox` — and asserts the wire contract
 * the MTA writes against:
 *   - a valid `ostrTier` is forwarded and lands on the message row;
 *   - `ostrScore` is IGNORED — nothing consumes a score, so nothing stores one;
 *   - `ostrDkimEvidence` never touches the message row, and with observer mode
 *     OFF (the shipped default) it is not retained at all; with it ON, the
 *     bundle lands in `ostrEvidence`, which is the only place it may live;
 *   - a garbage tier is dropped at the boundary and the message DELIVERS anyway,
 *     and — the property that matters most — a VALID tier still lands when the
 *     other OSTR fields are garbage. An advisory signal must never cost a
 *     delivery, and one bad field must never cost the good one.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../../schema';
import type { DatabaseWriter } from '../../_generated/server';
import { modules } from '../../__tests__/testModulesWithoutNodeActions';

const PATH = '/webhooks/mta-mailbox';
const SECRET = 'mta-test-secret';
const RECIPIENT = 'me@example.com';
const SAVED_ENV = { ...process.env };

beforeEach(() => {
	process.env['MTA_WEBHOOK_SECRET'] = SECRET;
	delete process.env['RATE_LIMIT_TRUSTED_PROXY'];
});

afterEach(() => {
	process.env = { ...SAVED_ENV };
});

type T = ReturnType<typeof convexTest>;

function setupTest(): T {
	const t = convexTest(schema, modules);
	// The route rate-limits before it verifies anything, so the component must
	// be live for the request to reach the handler at all.
	rateLimiterTest.register(t);
	return t;
}

async function seedMailbox(t: T): Promise<void> {
	await t.run(async (ctx: { db: DatabaseWriter }) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
			address: RECIPIENT,
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		for (const [name, role] of [
			['INBOX', 'inbox'],
			['Spam', 'spam'],
		] as const) {
			await ctx.db.insert('mailFolders', {
				mailboxId,
				name,
				role,
				uidValidity: now,
				uidNext: 1,
				highestModseq: 1,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
		}
	});
}

/**
 * Turn the `ostr` flag on (it ships OFF), with the `postbox` plane it requires.
 * Only the routing decision reads the flag; the tier is recorded either way.
 */
async function enableOstr(t: T): Promise<void> {
	await t.run(async (ctx: { db: DatabaseWriter }) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: { postbox: true, ostr: true },
			createdAt: Date.now(),
		});
	});
}

// HMAC-SHA256 → lowercase hex over `<timestamp>.<body>`, the scheme
// `webhooks/adapters/mta.ts:verifyMtaHeaders` checks.
async function sign(body: string, timestamp: number): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(`${timestamp}.${body}`)
	);
	return Array.from(new Uint8Array(signature))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

const RAW_EML = [
	`From: Alice <alice@sender.example>`,
	`To: ${RECIPIENT}`,
	'Subject: Quarterly update',
	'Message-ID: <m-1@sender.example>',
	'',
	'hi',
	'',
].join('\r\n');

/** A well-formed observer-mode evidence bundle (plan §7.1). */
const EVIDENCE = {
	signingDomain: 'sender.example',
	selector: 's1',
	algorithm: 'rsa-sha256',
	keyBits: 2048,
	usesBodyLengthTag: false,
	signedHeaderNames: ['from', 'date', 'message-id', 'subject'],
	rawSignedHeaders: [{ name: 'From', raw: 'From: Alice <alice@sender.example>' }],
	dkimSignatureHeader: 'DKIM-Signature: v=1; a=rsa-sha256; d=sender.example; s=s1',
	dnsKeyRecordTxt: 'v=DKIM1; k=rsa; p=MIIBIjANBg',
	verificationVerdict: 'pass',
	verifiedAt: '2026-08-20T09:00:01Z',
	messageId: '<m-1@sender.example>',
	bodyHash: 'uoq1oCgLlTqpdDX/iUbLy7J1Wic=',
};

async function post(t: T, ostr: Record<string, unknown>, messageId: string): Promise<Response> {
	const body = JSON.stringify({
		event: 'inbound.mailbox.received',
		timestamp: Date.now(),
		mailboxPayload: {
			deliveryId: `d-${messageId}`,
			recipientAddress: RECIPIENT,
			rawBytesBase64: Buffer.from(RAW_EML, 'utf8').toString('base64'),
			from: 'Alice <alice@sender.example>',
			to: [RECIPIENT],
			subject: 'Quarterly update',
			textBody: 'hi',
			messageId,
			spamVerdict: 'ham',
			spfResult: 'pass',
			dkimResult: 'pass',
			dmarcResult: 'pass',
			...ostr,
		},
	});
	const timestamp = Math.floor(Date.now() / 1000);
	return t.fetch(PATH, {
		method: 'POST',
		body,
		headers: {
			'Content-Type': 'application/json',
			'x-mta-signature': await sign(body, timestamp),
			'x-mta-timestamp': String(timestamp),
		},
	});
}

/** The stored tier of the single delivered message, and the folder it is in. */
async function delivered(t: T): Promise<{ role?: string; ostrTier?: string; count: number }> {
	return t.run(async (ctx: { db: DatabaseWriter }) => {
		const messages = await ctx.db.query('mailMessages').collect();
		const message = messages[0];
		if (!message) return { count: messages.length };
		const folder = await ctx.db.get(message.folderId);
		return { role: folder?.role, ostrTier: message.ostrTier, count: messages.length };
	});
}

describe('POST /webhooks/mta-mailbox — OSTR fields', () => {
	it('forwards a valid tier onto the delivered message', async () => {
		const t = setupTest();
		await seedMailbox(t);

		const response = await post(
			t,
			{ ostrTier: 'warned', ostrScore: 31 },
			'<ostr-w@sender.example>'
		);
		expect(response.status).toBe(200);

		const row = await delivered(t);
		expect(row.count).toBe(1);
		expect(row.ostrTier).toBe('warned');
		// `warned` is a signal only — it changes nothing about where mail lands.
		expect(row.role).toBe('inbox');
	});

	it('ignores a score and retains no evidence with observer mode off', async () => {
		const t = setupTest();
		await seedMailbox(t);

		const response = await post(
			t,
			{ ostrTier: 'trusted', ostrScore: 88, ostrDkimEvidence: EVIDENCE },
			'<ostr-e@sender.example>'
		);
		expect(response.status).toBe(200);

		const row = await delivered(t);
		expect(row.ostrTier).toBe('trusted');
		// The tier is the ONLY OSTR value on the row: no score column, no bundle,
		// nothing named after either. And with observer mode off — the shipped
		// default — the bundle is discarded rather than filed: an instance that
		// will never contribute keeps no signed headers.
		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const message = (await ctx.db.query('mailMessages').collect())[0];
			expect(Object.keys(message ?? {}).filter((key) => key.startsWith('ostr'))).toEqual([
				'ostrTier',
			]);
			expect(JSON.stringify(message)).not.toContain('dnsKeyRecordTxt');
			expect(await ctx.db.query('ostrEvidence').collect()).toEqual([]);
		});
	});

	it('files the evidence bundle under observer mode, and still not on the row', async () => {
		process.env['OSTR_OBSERVER_ENABLED'] = 'true';
		const t = setupTest();
		await seedMailbox(t);

		const response = await post(
			t,
			{ ostrTier: 'trusted', ostrDkimEvidence: EVIDENCE },
			'<ostr-observed@sender.example>'
		);
		expect(response.status).toBe(200);

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const message = (await ctx.db.query('mailMessages').collect())[0];
			// Still not on the message: the bundle holds the signed Subject and To
			// headers, and the row is read by every mail surface there is.
			expect(Object.keys(message ?? {}).filter((key) => key.startsWith('ostr'))).toEqual([
				'ostrTier',
			]);
			const evidence = await ctx.db.query('ostrEvidence').collect();
			expect(evidence).toHaveLength(1);
			expect(evidence[0]!.messageId).toBe(message?._id);
			expect(evidence[0]!.evidence.signingDomain).toBe(EVIDENCE.signingDomain);
			// Captured now because it cannot be captured later: the DNS key record
			// and the verification instant are gone once the sender rotates.
			expect(evidence[0]!.evidence.dnsKeyRecordTxt).toBe(EVIDENCE.dnsKeyRecordTxt);
		});
	});

	it('drops a garbage tier and still delivers the message', async () => {
		const t = setupTest();
		await seedMailbox(t);

		const response = await post(t, { ostrTier: 'BANNED' }, '<ostr-bad@sender.example>');
		expect(response.status).toBe(200);

		const row = await delivered(t);
		expect(row.count).toBe(1);
		expect(row.ostrTier).toBeUndefined();
		expect(row.role).toBe('inbox');
	});

	it('keeps a VALID tier when the other OSTR fields are garbage', async () => {
		const t = setupTest();
		await seedMailbox(t);
		await enableOstr(t);

		// The fields are independent: a mis-shaped evidence bundle and an
		// out-of-range score must not take the one field that IS well-formed down
		// with them. With the flag on, `flagged` still does the only thing a tier
		// is ever allowed to do — file the message under Spam.
		const response = await post(
			t,
			{ ostrTier: 'flagged', ostrScore: 900, ostrDkimEvidence: { signingDomain: 42 } },
			'<ostr-mixed@sender.example>'
		);
		expect(response.status).toBe(200);

		const row = await delivered(t);
		expect(row.count).toBe(1);
		expect(row.ostrTier).toBe('flagged');
		expect(row.role).toBe('spam');
	});

	it('delivers an OSTR-free payload exactly as before', async () => {
		const t = setupTest();
		await seedMailbox(t);

		const response = await post(t, {}, '<ostr-absent@sender.example>');
		expect(response.status).toBe(200);

		const row = await delivered(t);
		expect(row.count).toBe(1);
		expect(row.ostrTier).toBeUndefined();
		expect(row.role).toBe('inbox');
	});
});
