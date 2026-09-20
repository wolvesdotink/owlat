/**
 * `inbox.inboundIngest.ingestFromWebhook` — what the raw bytes buy, and what a
 * malware verdict costs.
 *
 * Proven here, with the MTA's `/scan/attachment` endpoint stubbed:
 *   · a confirmed-infected message is QUARANTINED, not dropped: the row exists,
 *     carries the verdict, starts no agent pipeline, and indexes nothing;
 *   · a clean message stores `virusVerdict: 'clean'` and captures its
 *     attachment into the file library;
 *   · with no MTA configured the verdict is UNDEFINED — explicitly not
 *     `'clean'` — and capture still runs, because "no scanner" is not a
 *     statement about the file;
 *   · a message with no attachment leaves makes no scan request at all and
 *     likewise asserts no verdict.
 *
 * Every case asserts the message row exists. This path has a hard never-drop
 * invariant: there is no SMTP 5xx to fall back on once DATA was accepted.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../../schema';
import { internal } from '../../_generated/api';

// See receiveMessageAuth.test.ts: the `../../**` glob omits the `inbox/` dir it
// climbed through, so merge a second glob rooted at `inbox/` and re-prefix its keys.
const rootGlob = import.meta.glob('../../**/*.*s');
const inboxGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../inbox/'),
		mod,
	])
);
const modules = { ...rootGlob, ...inboxGlob };

function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

const SAVED_ENV = { ...process.env };
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	process.env = { ...SAVED_ENV };
	vi.restoreAllMocks();
});

function configureMta(): void {
	process.env['MTA_INTERNAL_URL'] = 'https://mta.test.local';
	process.env['MTA_API_KEY'] = 'mta-test-key';
}

function unconfigureMta(): void {
	delete process.env['MTA_INTERNAL_URL'];
	delete process.env['MTA_API_URL'];
	delete process.env['MTA_API_KEY'];
}

/** Stub `/scan/attachment` with a fixed verdict and record the calls. */
function stubScanner(verdict: { clean: boolean; virus?: string }): { calls: () => number } {
	let calls = 0;
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (!url.includes('/scan/attachment')) throw new Error(`unexpected fetch: ${url}`);
		calls++;
		return new Response(JSON.stringify(verdict), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}) as unknown as typeof globalThis.fetch;
	return { calls: () => calls };
}

/** A two-part message: a text body plus one .txt attachment leaf. */
function buildEmlWithAttachment(messageId: string): string {
	return [
		'From: Bob <bob@example.com>',
		'To: inbox@example.com',
		'Subject: with attachment',
		`Message-ID: <${messageId}>`,
		'Content-Type: multipart/mixed; boundary="bb"',
		'',
		'--bb',
		'Content-Type: text/plain; charset=utf-8',
		'',
		'See the attached notes.',
		'',
		'--bb',
		'Content-Type: text/plain; name="notes.txt"',
		'Content-Disposition: attachment; filename="notes.txt"',
		'Content-Transfer-Encoding: base64',
		'',
		Buffer.from('a real document with enough words in it to summarise').toString('base64'),
		'',
		'--bb--',
		'',
	].join('\r\n');
}

function buildPlainEml(messageId: string): string {
	return [
		'From: Bob <bob@example.com>',
		'To: inbox@example.com',
		'Subject: plain',
		`Message-ID: <${messageId}>`,
		'Content-Type: text/plain; charset=utf-8',
		'',
		'Nothing attached here.',
		'',
	].join('\r\n');
}

async function ingest(
	t: ReturnType<typeof setupTest>,
	messageId: string,
	raw: string,
	attachments: Array<{ filename: string; contentType: string; size: number; partIndex: string }>
): Promise<void> {
	await t.action(internal.inbox.inboundIngest.ingestFromWebhook, {
		mail: {
			from: 'Bob <bob@example.com>',
			to: 'inbox@example.com',
			subject: 'subject',
			textBody: 'body',
			headers: {},
			messageId: `<${messageId}>`,
			attachments,
			timestamp: Date.now(),
		},
		rawBytesBase64: Buffer.from(raw, 'latin1').toString('base64'),
	});
}

const NOTES_META = [{ filename: 'notes.txt', contentType: 'text/plain', size: 52, partIndex: '1' }];

describe('inboundIngest — malware verdicts', () => {
	it('quarantines a confirmed-infected message without dropping it or indexing it', async () => {
		const t = setupTest();
		configureMta();
		stubScanner({ clean: false, virus: 'Eicar-Test-Signature' });

		await ingest(t, 'infected-1@example.com', buildEmlWithAttachment('infected-1@example.com'), [
			{ filename: 'notes.txt', contentType: 'text/plain', size: 52, partIndex: '1' },
		]);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		const row = rows[0]!;
		expect(row.virusVerdict).toBe('infected');
		expect(row.processingStatus).toBe('quarantined');
		// The raw blob deliberately survives so an operator can investigate.
		expect(row.rawStorageId).toBeTruthy();

		// Nothing was fed to a model, and the agent walker never started.
		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(0);
		const actions = await t.run((ctx) => ctx.db.query('agentActions').collect());
		expect(actions).toHaveLength(0);
	});

	it('stores a clean verdict and captures the attachment', async () => {
		const t = setupTest();
		configureMta();
		stubScanner({ clean: true });

		await ingest(
			t,
			'clean-1@example.com',
			buildEmlWithAttachment('clean-1@example.com'),
			NOTES_META
		);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]!.virusVerdict).toBe('clean');
		expect(rows[0]!.processingStatus).not.toBe('quarantined');

		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(1);
		expect(files[0]!.sourceType).toBe('email_attachment');
		expect(files[0]!.filename).toBe('notes.txt');
	});

	it('asserts no verdict when the scanner is not configured, and still captures', async () => {
		const t = setupTest();
		unconfigureMta();
		const scanner = stubScanner({ clean: true });

		await ingest(
			t,
			'noscanner-1@example.com',
			buildEmlWithAttachment('noscanner-1@example.com'),
			NOTES_META
		);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		// UNDEFINED, not 'clean'. "The scanner is not configured" and "the file is
		// safe" are different claims and only one of them is ours to make.
		expect(rows[0]!.virusVerdict).toBeUndefined();
		expect(scanner.calls()).toBe(0);

		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(1);
	});

	it('makes no scan request and asserts no verdict for a message with no attachments', async () => {
		const t = setupTest();
		configureMta();
		const scanner = stubScanner({ clean: true });

		await ingest(t, 'plain-1@example.com', buildPlainEml('plain-1@example.com'), []);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]!.virusVerdict).toBeUndefined();
		expect(rows[0]!.rawStorageId).toBeTruthy();
		expect(scanner.calls()).toBe(0);

		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(0);
	});
});

describe('inboundIngest — an MTA that sends no bytes', () => {
	it('stores the message with no raw blob rather than failing', async () => {
		const t = setupTest();
		configureMta();
		const scanner = stubScanner({ clean: true });

		await t.action(internal.inbox.inboundIngest.ingestFromWebhook, {
			mail: {
				from: 'Bob <bob@example.com>',
				to: 'inbox@example.com',
				subject: 'legacy',
				textBody: 'body',
				headers: {},
				messageId: '<legacy-1@example.com>',
				attachments: [],
				timestamp: Date.now(),
			},
		});

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]!.rawStorageId).toBeUndefined();
		expect(rows[0]!.rawRetained).toBeUndefined();
		expect(rows[0]!.virusVerdict).toBeUndefined();
		expect(scanner.calls()).toBe(0);
	});
});
