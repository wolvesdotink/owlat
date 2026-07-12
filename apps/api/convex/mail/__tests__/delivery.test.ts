/**
 * Inbound attachment malware scanning (PR-39) — verdict aggregation.
 *
 * ClamAV runs only in the MTA container, so inbound Postbox mail used to land in
 * the mailbox WITHOUT a malware scan — `virusVerdict` was always undefined and
 * the `infected → Spam` routing in `deliverToMailbox` could never fire. The fix
 * calls the MTA `/scan/attachment` endpoint on the inbound delivery path
 * (`ingestFromWebhook`) and records the aggregate verdict before delivery.
 *
 * This file pins the pure aggregation: `scanInboundAttachments` (fetch-spy) —
 * infected wins, a scanner outage fails open with 'skipped' + a scannerHealth
 * warning, clean otherwise. The end-to-end ingest path (EICAR → Spam folder, 503
 * → fail-open delivered) is exercised through `ingestFromWebhook` in
 * `__tests__/inboundAttachmentScan.integration.test.ts`.
 *
 * The EICAR test string is the industry-standard benign malware-scanner probe
 * (https://www.eicar.org/download-anti-malware-testfile/).
 *
 * It also pins the inbound content/spam scan for personal mailboxes (PR-40):
 * @owlat/email-scanner's scanContent previously only ran on the OUTBOUND path,
 * so mail delivered into a hosted (Postbox) mailbox arrived with no spam /
 * phishing scoring at all. deliverToMailbox now runs scanContent whenever the
 * inbound pipeline did not already supply a verdict, so personal inboxes get
 * the same keyword / phishing-URL / caps-abuse scoring outbound mail does.
 * A high-spam message (ALL-CAPS subject, advance-fee body, a pile of
 * URL-shortener links) is scored >= 40 and routed to the Spam folder; an
 * MTA-supplied verdict still wins.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scanInboundAttachments } from '../delivery';
import * as scannerHealth from '../../lib/scannerHealth';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { DatabaseWriter } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { modules } from './testModules';

// The standard EICAR anti-malware test signature (a real virus scanner reports
// it as malware; it is otherwise inert).
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** Build a multipart/mixed .eml carrying a base64 attachment. */
function emlWithAttachment(opts: { messageId: string; filename: string; body: string }): string {
	return [
		'From: sender@isp.example',
		'To: me@example.com',
		`Subject: has attachment`,
		`Message-ID: ${opts.messageId}`,
		'MIME-Version: 1.0',
		'Content-Type: multipart/mixed; boundary="B"',
		'',
		'--B',
		'Content-Type: text/plain; charset=utf-8',
		'',
		'see attached',
		'--B',
		`Content-Type: application/octet-stream; name="${opts.filename}"`,
		`Content-Disposition: attachment; filename="${opts.filename}"`,
		'Content-Transfer-Encoding: base64',
		'',
		Buffer.from(opts.body, 'utf-8').toString('base64'),
		'--B--',
		'',
	].join('\r\n');
}

interface ScanResponseBody {
	clean: boolean;
	virus?: string;
	reason?: string;
	skipped?: boolean;
}

/** Spy on fetch returning a canned `/scan/attachment` body (or an HTTP error). */
function mockScan(response: ScanResponseBody | { httpStatus: number }): {
	calls: Array<{ url: string; filename?: string; body: Buffer }>;
} {
	const calls: Array<{ url: string; filename?: string; body: Buffer }> = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
		const headers = (init as RequestInit | undefined)?.headers as
			| Record<string, string>
			| undefined;
		const rawBody = (init as RequestInit | undefined)?.body;
		calls.push({
			url: String(url),
			filename: headers?.['X-Filename'],
			body: rawBody ? Buffer.from(rawBody as ArrayBuffer) : Buffer.alloc(0),
		});
		if ('httpStatus' in response) {
			return new Response('scanner down', { status: response.httpStatus });
		}
		return new Response(JSON.stringify(response), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	});
	return { calls };
}

const MTA = { baseUrl: 'https://mta.test', apiKey: 'secret' };

describe('scanInboundAttachments (pure verdict aggregation)', () => {
	beforeEach(() => {
		scannerHealth._resetScannerWarnThrottle();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns "infected" and short-circuits when an attachment is malware', async () => {
		const warnSpy = vi.spyOn(scannerHealth, 'warnScanSkipped');
		const { calls } = mockScan({ clean: false, virus: 'Eicar-Signature' });

		const raw = Buffer.from(
			emlWithAttachment({
				messageId: '<v1@isp.example>',
				filename: 'eicar.com',
				body: EICAR,
			})
		);
		const verdict = await scanInboundAttachments(MTA, raw);

		expect(verdict).toBe('infected');
		// The inbound scan was actually invoked against the MTA endpoint.
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe('https://mta.test/scan/attachment');
		expect(calls[0]!.filename).toBe('eicar.com');
		expect(calls[0]!.body.toString('utf-8')).toBe(EICAR);
		// Infected is not a "skipped" outage.
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('fails open to "skipped" and warns when the scanner returns HTTP 503', async () => {
		const warnSpy = vi.spyOn(scannerHealth, 'warnScanSkipped');
		mockScan({ httpStatus: 503 });

		const raw = Buffer.from(
			emlWithAttachment({
				messageId: '<v2@isp.example>',
				filename: 'report.pdf',
				body: 'pretend pdf',
			})
		);
		const verdict = await scanInboundAttachments(MTA, raw);

		expect(verdict).toBe('skipped');
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith('report.pdf', 'scanner returned HTTP 503');
	});

	it('fails open to "skipped" and warns on a network error', async () => {
		const warnSpy = vi.spyOn(scannerHealth, 'warnScanSkipped');
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

		const raw = Buffer.from(
			emlWithAttachment({
				messageId: '<v3@isp.example>',
				filename: 'doc.txt',
				body: 'hi',
			})
		);
		const verdict = await scanInboundAttachments(MTA, raw);

		expect(verdict).toBe('skipped');
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	it("honours the scanner's own skipped verdict (failed open inside the MTA)", async () => {
		const warnSpy = vi.spyOn(scannerHealth, 'warnScanSkipped');
		mockScan({ clean: true, skipped: true, reason: 'ClamAV unavailable' });

		const raw = Buffer.from(
			emlWithAttachment({
				messageId: '<v4@isp.example>',
				filename: 'doc.txt',
				body: 'hi',
			})
		);
		const verdict = await scanInboundAttachments(MTA, raw);

		expect(verdict).toBe('skipped');
		expect(warnSpy).toHaveBeenCalledWith('doc.txt', 'ClamAV unavailable');
	});

	it('returns "clean" when every attachment scans clean', async () => {
		const { calls } = mockScan({ clean: true });
		const raw = Buffer.from(
			emlWithAttachment({
				messageId: '<v5@isp.example>',
				filename: 'doc.txt',
				body: 'hi',
			})
		);
		expect(await scanInboundAttachments(MTA, raw)).toBe('clean');
		expect(calls).toHaveLength(1);
	});

	it('returns undefined (no verdict asserted) when the MTA is not configured', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const raw = Buffer.from(
			emlWithAttachment({
				messageId: '<v6@isp.example>',
				filename: 'doc.txt',
				body: 'hi',
			})
		);
		expect(await scanInboundAttachments(null, raw)).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('returns undefined when there are no attachments to scan', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const raw = Buffer.from(['Content-Type: text/plain', '', 'just text'].join('\r\n'));
		expect(await scanInboundAttachments(MTA, raw)).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

async function insertMailbox(ctx: { db: DatabaseWriter }): Promise<Id<'mailboxes'>> {
	const now = Date.now();
	return ctx.db.insert('mailboxes', {
		userId: 'test-user',
		organizationId: 'test-org',
		address: 'me@example.com',
		domain: 'example.com',
		status: 'active',
		usedBytes: 0,
		uidValidity: now,
		createdAt: now,
		updatedAt: now,
	});
}

async function insertFolder(
	ctx: { db: DatabaseWriter },
	mailboxId: Id<'mailboxes'>,
	name: string,
	role: 'inbox' | 'spam'
): Promise<Id<'mailFolders'>> {
	const now = Date.now();
	return ctx.db.insert('mailFolders', {
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

// A high-spam HTML body: advance-fee fraud language plus 20 URL-shortener links
// (each a medium-severity flag in @owlat/email-scanner).
const SPAM_HTML =
	'<html><body>' +
	'<p>YOU HAVE WON a million dollars! Send a wire transfer immediately to claim.</p>' +
	Array.from({ length: 20 }, (_, i) => `<a href="https://bit.ly/claim-${i}">click here</a>`).join(
		''
	) +
	'</body></html>';

describe('deliverToMailbox — inbound content/spam scan for personal mailboxes (PR-40)', () => {
	it('scores high-spam inbound mail and routes it to the Spam folder when the MTA gave no verdict', async () => {
		const t = convexTest(schema, modules);
		let inboxId!: Id<'mailFolders'>;
		let spamId!: Id<'mailFolders'>;
		let rawStorageId!: Id<'_storage'>;
		await t.run(async (ctx) => {
			const mailboxId = await insertMailbox(ctx);
			inboxId = await insertFolder(ctx, mailboxId, 'INBOX', 'inbox');
			spamId = await insertFolder(ctx, mailboxId, 'Spam', 'spam');
			rawStorageId = await ctx.storage.store(new Blob(['x']));
		});

		const result = await t.mutation(internal.mail.delivery.deliverToMailbox, {
			rawStorageId,
			rawSize: 1,
			recipientAddress: 'me@example.com',
			from: 'scammer@isp.example',
			to: ['me@example.com'],
			cc: [],
			bcc: [],
			subject: 'YOU HAVE WON A MILLION DOLLARS',
			htmlBodyInline: SPAM_HTML,
			snippet: 'YOU HAVE WON',
			messageId: '<spam-scan-1@isp.example>',
			receivedAt: Date.now(),
			attachments: [],
			// Deliberately NO spamScore / spamVerdict — this is the Postbox gap the
			// scanner now fills.
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const msg = await ctx.db.get(result.messageId);
			expect(msg?.spamScore).toBeGreaterThanOrEqual(40);
			expect(msg?.spamVerdict).toBe('spam');
			// Routed to Spam, not the inbox.
			expect(msg?.folderId).toBe(spamId);
			expect(msg?.folderId).not.toBe(inboxId);
		});
	});

	it('does not re-score a message the MTA already classified as ham (verdict wins)', async () => {
		const t = convexTest(schema, modules);
		let inboxId!: Id<'mailFolders'>;
		let rawStorageId!: Id<'_storage'>;
		await t.run(async (ctx) => {
			const mailboxId = await insertMailbox(ctx);
			inboxId = await insertFolder(ctx, mailboxId, 'INBOX', 'inbox');
			await insertFolder(ctx, mailboxId, 'Spam', 'spam');
			rawStorageId = await ctx.storage.store(new Blob(['x']));
		});

		// Same high-spam body, but the MTA already returned an explicit ham verdict.
		// The pre-supplied verdict must win — no re-score, stays in the inbox.
		const result = await t.mutation(internal.mail.delivery.deliverToMailbox, {
			rawStorageId,
			rawSize: 1,
			recipientAddress: 'me@example.com',
			from: 'scammer@isp.example',
			to: ['me@example.com'],
			cc: [],
			bcc: [],
			subject: 'YOU HAVE WON A MILLION DOLLARS',
			htmlBodyInline: SPAM_HTML,
			snippet: 'YOU HAVE WON',
			messageId: '<spam-scan-2@isp.example>',
			receivedAt: Date.now(),
			attachments: [],
			spamScore: 0,
			spamVerdict: 'ham',
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const msg = await ctx.db.get(result.messageId);
			expect(msg?.spamScore).toBe(0);
			expect(msg?.spamVerdict).toBe('ham');
			expect(msg?.folderId).toBe(inboxId);
		});
	});

	it('keeps a genuinely clean inbound message in the inbox with a low score', async () => {
		const t = convexTest(schema, modules);
		let inboxId!: Id<'mailFolders'>;
		let rawStorageId!: Id<'_storage'>;
		await t.run(async (ctx) => {
			const mailboxId = await insertMailbox(ctx);
			inboxId = await insertFolder(ctx, mailboxId, 'INBOX', 'inbox');
			await insertFolder(ctx, mailboxId, 'Spam', 'spam');
			rawStorageId = await ctx.storage.store(new Blob(['x']));
		});

		const result = await t.mutation(internal.mail.delivery.deliverToMailbox, {
			rawStorageId,
			rawSize: 1,
			recipientAddress: 'me@example.com',
			from: 'colleague@isp.example',
			to: ['me@example.com'],
			cc: [],
			bcc: [],
			subject: 'Lunch tomorrow?',
			htmlBodyInline: '<html><body><p>Want to grab lunch tomorrow at noon?</p></body></html>',
			snippet: 'Want to grab lunch',
			messageId: '<clean-scan-1@isp.example>',
			receivedAt: Date.now(),
			attachments: [],
		});
		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const msg = await ctx.db.get(result.messageId);
			expect(msg?.spamScore).toBeLessThan(15);
			expect(msg?.spamVerdict).toBe('ham');
			expect(msg?.folderId).toBe(inboxId);
		});
	});
});
