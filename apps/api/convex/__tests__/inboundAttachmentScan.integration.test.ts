/**
 * Inbound attachment malware scanning end-to-end (PR-39).
 *
 * ClamAV runs only in the MTA container; before this fix inbound Postbox mail
 * ingested into the mailbox WITHOUT a scan, so `virusVerdict` was always
 * undefined and the `infected → Spam` routing in `deliverToMailbox` could never
 * fire. `ingestFromWebhook` now POSTs each attachment leaf to the MTA
 * `/scan/attachment` endpoint and records the aggregate verdict before delivery.
 *
 * This pins the whole inbound path:
 *   - an EICAR-carrying .eml is actually scanned, lands `virusVerdict ===
 *     'infected'`, and is routed to the Spam folder (quarantine).
 *   - a scanner outage (HTTP 503) fails open: `virusVerdict === 'skipped'`, the
 *     message is still delivered to the inbox, and the skip is surfaced via
 *     `lib/scannerHealth.warnScanSkipped` (logged through runtimeLog.logWarn).
 *
 * The EICAR test string is the industry-standard benign malware-scanner probe
 * (https://www.eicar.org/download-anti-malware-testfile/).
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { DatabaseWriter } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import * as scannerHealth from '../lib/scannerHealth';
import * as runtimeLog from '../lib/runtimeLog';

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('llmProvider'),
	),
);

const MTA = { baseUrl: 'https://mta.test', apiKey: 'secret' };

// The standard EICAR anti-malware test signature.
const EICAR =
	'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** Build a multipart/mixed .eml carrying a base64 attachment. */
function emlWithAttachment(opts: {
	messageId: string;
	filename: string;
	body: string;
}): string {
	return [
		'From: sender@isp.example',
		'To: me@example.com',
		'Subject: has attachment',
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
	calls: Array<{ url: string; filename?: string }>;
} {
	const calls: Array<{ url: string; filename?: string }> = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
		const headers = (init as RequestInit | undefined)?.headers as
			| Record<string, string>
			| undefined;
		calls.push({ url: String(url), filename: headers?.['X-Filename'] });
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
	role: 'inbox' | 'spam',
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

describe('ingestFromWebhook — inbound EICAR scan + Spam routing (PR-39)', () => {
	const ORIG_URL = process.env['MTA_INTERNAL_URL'];
	const ORIG_KEY = process.env['MTA_API_KEY'];

	beforeEach(() => {
		scannerHealth._resetScannerWarnThrottle();
		process.env['MTA_INTERNAL_URL'] = MTA.baseUrl;
		process.env['MTA_API_KEY'] = MTA.apiKey;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (ORIG_URL === undefined) delete process.env['MTA_INTERNAL_URL'];
		else process.env['MTA_INTERNAL_URL'] = ORIG_URL;
		if (ORIG_KEY === undefined) delete process.env['MTA_API_KEY'];
		else process.env['MTA_API_KEY'] = ORIG_KEY;
	});

	async function setup(): Promise<{
		t: ReturnType<typeof convexTest>;
		inboxId: Id<'mailFolders'>;
		spamId: Id<'mailFolders'>;
	}> {
		const t = convexTest(schema, modules);
		let inboxId!: Id<'mailFolders'>;
		let spamId!: Id<'mailFolders'>;
		await t.run(async (ctx) => {
			const mailboxId = await insertMailbox(ctx);
			inboxId = await insertFolder(ctx, mailboxId, 'INBOX', 'inbox');
			spamId = await insertFolder(ctx, mailboxId, 'Spam', 'spam');
		});
		return { t, inboxId, spamId };
	}

	function ingest(
		t: ReturnType<typeof convexTest>,
		raw: string,
		messageId: string,
	): Promise<{ messageId: Id<'mailMessages'> } | { skipped: true }> {
		return t.action(internal.mail.delivery.ingestFromWebhook, {
			deliveryId: 'd1',
			rawBytesBase64: Buffer.from(raw).toString('base64'),
			recipientAddress: 'me@example.com',
			from: 'sender@isp.example',
			to: ['me@example.com'],
			cc: [],
			bcc: [],
			subject: 'has attachment',
			textBody: 'see attached',
			messageId,
			attachments: [],
		});
	}

	it('scans the EICAR attachment, records virusVerdict="infected", and routes to Spam', async () => {
		const { t, inboxId, spamId } = await setup();
		const { calls } = mockScan({ clean: false, virus: 'Eicar-Signature' });

		const raw = emlWithAttachment({
			messageId: '<eicar@isp.example>',
			filename: 'eicar.com',
			body: EICAR,
		});
		const result = await ingest(t, raw, '<eicar@isp.example>');

		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		// The inbound scan was actually invoked against the MTA endpoint.
		expect(calls.some((c) => c.url === 'https://mta.test/scan/attachment')).toBe(true);
		expect(calls.some((c) => c.filename === 'eicar.com')).toBe(true);

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const msg = await ctx.db.get(result.messageId);
			expect(msg?.virusVerdict).toBe('infected');
			// Infected → Spam/quarantine, not the inbox.
			expect(msg?.folderId).toBe(spamId);
			expect(msg?.folderId).not.toBe(inboxId);
		});
	});

	it('fails open (virusVerdict="skipped") and still delivers when the scanner is down (503)', async () => {
		const { t, inboxId } = await setup();
		const warnSpy = vi.spyOn(runtimeLog, 'logWarn');
		mockScan({ httpStatus: 503 });

		const raw = emlWithAttachment({
			messageId: '<down@isp.example>',
			filename: 'invoice.pdf',
			body: 'pretend pdf bytes',
		});
		const result = await ingest(t, raw, '<down@isp.example>');

		expect('messageId' in result).toBe(true);
		if (!('messageId' in result)) return;

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const msg = await ctx.db.get(result.messageId);
			expect(msg?.virusVerdict).toBe('skipped');
			// Fail-open: the message is still delivered to the inbox.
			expect(msg?.folderId).toBe(inboxId);
		});

		// The skip is surfaced in the backend logs the operator watches
		// (mirroring lib/scannerHealth.warnScanSkipped).
		expect(warnSpy).toHaveBeenCalled();
		expect(String(warnSpy.mock.calls[0]?.[0])).toContain('UNSCANNED');
	});
});
