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
import { scanInboundAttachments } from '../deliveryPipeline/scan';
import { ATTACHMENT_COMPOSE_LIMITS } from '@owlat/shared/attachments';
import * as scannerHealth from '../../lib/scannerHealth';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { DatabaseWriter } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { modules } from '../../__tests__/testModulesWithoutNodeActions';

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
	/** Which gate answered — `'file_type_validation'` is the type allowlist, not ClamAV. */
	stage?: string;
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
		const scan = await scanInboundAttachments(MTA, raw.toString('latin1'));

		expect(scan.verdict).toBe('infected');
		// Nothing out of a quarantined message is cleared, so capture — which is
		// only ever given `cleanParts` — has nothing to feed a model.
		expect(scan.cleanParts).toHaveLength(0);
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
		const scan = await scanInboundAttachments(MTA, raw.toString('latin1'));

		expect(scan.verdict).toBe('skipped');
		expect(scan.cleanParts).toHaveLength(0);
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
		const scan = await scanInboundAttachments(MTA, raw.toString('latin1'));

		expect(scan.verdict).toBe('skipped');
		expect(scan.cleanParts).toHaveLength(0);
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
		const scan = await scanInboundAttachments(MTA, raw.toString('latin1'));

		expect(scan.verdict).toBe('skipped');
		expect(scan.cleanParts).toHaveLength(0);
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
		const scan = await scanInboundAttachments(MTA, raw.toString('latin1'));
		expect(scan.verdict).toBe('clean');
		// The cleared leaf comes BACK: it is what capture is allowed to ingest,
		// and handing it over is what stops a second selection from picking a
		// different file than the one that was scanned.
		expect(scan.cleanParts.map((p) => p.filename)).toEqual(['doc.txt']);
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
		const scan = await scanInboundAttachments(null, raw.toString('latin1'));
		expect(scan.verdict).toBeUndefined();
		expect(scan.cleanParts).toHaveLength(0);
		// It still counted the leaves: "there was nothing to scan" and "nothing
		// scanned it" are different sentences, and only this number tells them
		// apart for the reader.
		expect(scan.candidates).toHaveLength(1);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('returns undefined when there are no attachments to scan', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const raw = Buffer.from(['Content-Type: text/plain', '', 'just text'].join('\r\n'));
		const scan = await scanInboundAttachments(MTA, raw.toString('latin1'));
		expect(scan.verdict).toBeUndefined();
		expect(scan.candidates).toHaveLength(0);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

/**
 * The set the scanner cleared IS the set capture may ingest.
 *
 * The bug this pins: the scanner opened the first ten attachment leaves in MIME
 * order, while capture dropped the rejected types FIRST and then took ten of
 * what survived. Ten `.exe` stubs followed by one `payload.txt` therefore spent
 * the scanner's whole budget on the stubs, came back `'clean'`, and left capture
 * a free slot for the one leaf nobody had scanned — which then went to
 * summarise, embed and knowledge extraction. Craftable by any sender, on a
 * route any sender can reach.
 */
describe('scanInboundAttachments — the cap and the cleared set', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** A message whose attachment leaves are exactly the given filenames. */
	function emlWithLeaves(filenames: string[]): string {
		const lines = [
			'From: sender@isp.example',
			'To: me@example.com',
			'Subject: many leaves',
			'Message-ID: <many@isp.example>',
			'MIME-Version: 1.0',
			'Content-Type: multipart/mixed; boundary="B"',
			'',
			'--B',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'see attached',
		];
		for (const filename of filenames) {
			lines.push(
				'--B',
				`Content-Type: application/octet-stream; name="${filename}"`,
				`Content-Disposition: attachment; filename="${filename}"`,
				'Content-Transfer-Encoding: base64',
				'',
				Buffer.from(`bytes of ${filename}`, 'utf-8').toString('base64')
			);
		}
		lines.push('--B--', '');
		return lines.join('\r\n');
	}

	it('never clears a leaf the cap left unopened', async () => {
		const { calls } = mockScan({ clean: true });
		const stubs = Array.from(
			{ length: ATTACHMENT_COMPOSE_LIMITS.maxCount },
			(_, i) => `stub${i}.exe`
		);
		const raw = Buffer.from(emlWithLeaves([...stubs, 'payload.txt']));

		const scan = await scanInboundAttachments(MTA, raw.toString('latin1'));

		// Exactly the cap was opened, and in MIME order — the stubs.
		expect(calls).toHaveLength(ATTACHMENT_COMPOSE_LIMITS.maxCount);
		expect(calls.map((c) => c.filename)).toEqual(stubs);
		// The leaf past the cap is NOT in the cleared set. Capture is given this
		// array and nothing else, so it cannot reach `payload.txt` however its
		// own type and size filters happen to order things.
		expect(scan.cleanParts.map((p) => p.filename)).toEqual(stubs);
		expect(scan.cleanParts.map((p) => p.filename)).not.toContain('payload.txt');
		// And the verdict does not claim a message we only partly looked at is
		// clean.
		expect(scan.verdict).toBe('skipped');
		expect(scan.candidates).toHaveLength(ATTACHMENT_COMPOSE_LIMITS.maxCount + 1);
		// And it says WHY the rest went uncleared: the cap, not an outage.
		expect(scan.uncleared).toEqual({ capped: 1, unscanned: 0, refusedType: 0 });
	});

	/** A message whose only leaf is the given inline part. */
	function emlWithInlineLeaf(filename: string, contentType: string): string {
		return [
			'From: sender@isp.example',
			'To: me@example.com',
			'Subject: corporate signature',
			'Message-ID: <inline@isp.example>',
			'MIME-Version: 1.0',
			'Content-Type: multipart/related; boundary="B"',
			'',
			'--B',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'regards',
			'--B',
			`Content-Type: ${contentType}; name="${filename}"`,
			`Content-Disposition: inline; filename="${filename}"`,
			'Content-Transfer-Encoding: base64',
			'',
			Buffer.from(`bytes of ${filename}`).toString('base64'),
			'--B--',
			'',
		].join('\r\n');
	}

	it('scans an inline leaf, because the reader can download one', async () => {
		const { calls } = mockScan({ clean: true });
		const raw = Buffer.from(emlWithInlineLeaf('logo.png', 'image/png'));

		const scan = await scanInboundAttachments(MTA, raw.toString('latin1'));

		// The MTA lists any leaf carrying a filename whatever its disposition,
		// and the thread view puts a download button on each — so `inline` must
		// not be a way to route bytes past ClamAV.
		expect(calls.map((c) => c.filename)).toEqual(['logo.png']);
		expect(scan.candidates).toHaveLength(1);
		expect(scan.verdict).toBe('clean');
	});

	it('quarantines an inline executable instead of handing it over', async () => {
		// The craft: `Content-Disposition: inline` on an `invoice.pdf.exe`, which
		// used to skip the scan entirely and render as a normal row with a live
		// download beside it.
		const { calls } = mockScan({ clean: false, virus: 'Eicar-Signature' });
		const raw = Buffer.from(emlWithInlineLeaf('invoice.pdf.exe', 'application/octet-stream'));

		const scan = await scanInboundAttachments(MTA, raw.toString('latin1'));

		expect(calls.map((c) => c.filename)).toEqual(['invoice.pdf.exe']);
		expect(scan.verdict).toBe('infected');
		expect(scan.cleanParts).toHaveLength(0);
	});

	it('spends the scan budget on the attachments before the inline logos', async () => {
		const { calls } = mockScan({ clean: true });
		const logos = Array.from(
			{ length: ATTACHMENT_COMPOSE_LIMITS.maxCount },
			(_, i) => `logo${i}.png`
		);
		const lines = [
			'From: sender@isp.example',
			'To: me@example.com',
			'Subject: many logos then a payload',
			'Message-ID: <logos@isp.example>',
			'MIME-Version: 1.0',
			'Content-Type: multipart/mixed; boundary="B"',
			'',
		];
		for (const logo of logos) {
			lines.push(
				'--B',
				`Content-Type: image/png; name="${logo}"`,
				`Content-Disposition: inline; filename="${logo}"`,
				'',
				`bytes of ${logo}`
			);
		}
		lines.push(
			'--B',
			'Content-Type: application/octet-stream; name="payload.exe"',
			'Content-Disposition: attachment; filename="payload.exe"',
			'',
			'MZ payload',
			'--B--',
			''
		);
		const raw = Buffer.from(lines.join('\r\n'));

		const scan = await scanInboundAttachments(MTA, raw.toString('latin1'));

		// The budget is a COUNT, so ten logos in front of an executable must not
		// be a way to spend it before the one leaf worth scanning.
		expect(calls[0]!.filename).toBe('payload.exe');
		expect(calls).toHaveLength(ATTACHMENT_COMPOSE_LIMITS.maxCount);
		expect(scan.uncleared.capped).toBe(1);
	});

	it('separates a scanner outage on one leaf from the count cap', async () => {
		// One 503, one clean answer: two files, both well under the cap.
		const responses = new Map<string, { status: number; body: unknown }>([
			['broken.pdf', { status: 503, body: {} }],
			['fine.txt', { status: 200, body: { clean: true } }],
		]);
		vi.spyOn(globalThis, 'fetch').mockImplementation(
			async (_url: string | URL | Request, init?: RequestInit) => {
				const headers = (init?.headers ?? {}) as Record<string, string>;
				const filename = String(headers['X-Filename']);
				const answer = responses.get(filename)!;
				return new Response(JSON.stringify(answer.body), { status: answer.status });
			}
		);
		const raw = Buffer.from(emlWithLeaves(['broken.pdf', 'fine.txt']));

		const scan = await scanInboundAttachments(MTA, raw.toString('latin1'));

		expect(scan.verdict).toBe('skipped');
		expect(scan.cleanParts.map((p) => p.filename)).toEqual(['fine.txt']);
		// The whole point: the leaf ClamAV never answered for is counted as
		// UNSCANNED, not as something the cap withheld.
		expect(scan.uncleared).toEqual({ capped: 0, unscanned: 1, refusedType: 0 });
	});

	it("counts the endpoint's file-type refusal apart from a virus", async () => {
		mockScan({
			clean: false,
			reason: 'Dangerous file type detected',
			stage: 'file_type_validation',
		});
		const raw = Buffer.from(emlWithLeaves(['report.doc']));

		const scan = await scanInboundAttachments(MTA, raw.toString('latin1'));

		// A refusal from the type gate is not a malware finding: the message is
		// NOT quarantined, the leaf is simply not cleared for indexing.
		expect(scan.verdict).toBe('clean');
		expect(scan.cleanParts).toHaveLength(0);
		expect(scan.uncleared).toEqual({ capped: 0, unscanned: 0, refusedType: 1 });
	});

	it("clears every leaf on an upstream 'clean' when there is no scanner here", async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const raw = Buffer.from(emlWithLeaves(['a.txt', 'b.txt']));

		// The MTA scanned before it forwarded; its verdict is about the whole
		// message, so every leaf is covered by it.
		const scan = await scanInboundAttachments(null, raw.toString('latin1'), 'clean');

		expect(scan.verdict).toBe('clean');
		expect(scan.cleanParts.map((p) => p.filename)).toEqual(['a.txt', 'b.txt']);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('clears nothing on an upstream infected verdict', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const raw = Buffer.from(emlWithLeaves(['a.txt']));

		const scan = await scanInboundAttachments(null, raw.toString('latin1'), 'infected');

		expect(scan.verdict).toBe('infected');
		expect(scan.cleanParts).toHaveLength(0);
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
