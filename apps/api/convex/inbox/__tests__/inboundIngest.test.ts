/**
 * `inbox.inboundIngest.ingestFromWebhook` — what the raw bytes buy, and what a
 * malware verdict costs.
 *
 * Proven here, with the MTA's `/scan/attachment` endpoint stubbed:
 *   · a confirmed-infected message is QUARANTINED, not dropped: the row exists,
 *     carries the verdict, starts no agent pipeline, and indexes nothing;
 *   · a clean message stores `virusVerdict: 'clean'`, captures its attachment
 *     into the file library, and files it under the contact `receiveMessage`
 *     resolved for the sender — the branch nearly every real message takes;
 *   · a `'skipped'` verdict (scanner configured, unreachable) indexes NOTHING:
 *     unscanned attacker bytes must not reach summarise/embed on a route any
 *     sender can reach, and the row says so;
 *   · with no MTA configured the verdict is UNDEFINED — explicitly not
 *     `'clean'` — and capture likewise does not run;
 *   · a message with no attachment leaves makes no scan request at all,
 *     asserts no verdict and records no indexing marker;
 *   · an undecodable `rawBytesBase64` stores NO raw blob rather than sealing a
 *     zero-byte one the reader would then offer as a download;
 *   · a redelivered Message-ID is re-acknowledged, not duplicated.
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
	raw: string | undefined,
	attachments: Array<{ filename: string; contentType: string; size: number; partIndex: string }>
): Promise<{ isDuplicate: boolean }> {
	return await t.action(internal.inbox.inboundIngest.ingestFromWebhook, {
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
		rawBytesBase64: raw,
	});
}

/** The same call, with the raw MIME encoded the way the MTA encodes it. */
function encode(raw: string): string {
	return Buffer.from(raw, 'latin1').toString('base64');
}

const NOTES_META = [{ filename: 'notes.txt', contentType: 'text/plain', size: 52, partIndex: '1' }];

describe('inboundIngest — malware verdicts', () => {
	it('quarantines a confirmed-infected message without dropping it or indexing it', async () => {
		const t = setupTest();
		configureMta();
		stubScanner({ clean: false, virus: 'Eicar-Test-Signature' });

		await ingest(
			t,
			'infected-1@example.com',
			encode(buildEmlWithAttachment('infected-1@example.com')),
			[{ filename: 'notes.txt', contentType: 'text/plain', size: 52, partIndex: '1' }]
		);

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
			encode(buildEmlWithAttachment('clean-1@example.com')),
			NOTES_META
		);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]!.virusVerdict).toBe('clean');
		expect(rows[0]!.processingStatus).not.toBe('quarantined');

		expect(rows[0]!.attachmentIndexing).toBe('indexed');

		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(1);
		expect(files[0]!.sourceType).toBe('email_attachment');
		expect(files[0]!.filename).toBe('notes.txt');
		// Only team-inbox captures are in range of the inbound retention sweep.
		expect(files[0]!.captureSource).toBe('team_inbox');

		// CONTACT SCOPING, end to end. `receiveMessage` upserts the sender contact
		// BEFORE capture runs, so the "existing contact" branch is what nearly
		// every real message takes — and it only works if the address
		// `receiveMessage` normalised is the one `getByEmailForTeam` looks up.
		// Driving `captureAttachments` directly with a hand-seeded contact would
		// never catch a mismatch between the two.
		const contact = await t.run((ctx) =>
			ctx.db
				.query('contacts')
				.withIndex('by_email', (q) => q.eq('email', 'bob@example.com'))
				.first()
		);
		expect(contact).not.toBeNull();
		expect(files[0]!.contactIds).toEqual([contact!._id]);
		const junction = await t.run((ctx) => ctx.db.query('semanticFileContacts').collect());
		expect(junction.map((j) => j.contactId)).toEqual([contact!._id]);
	});

	it('indexes nothing when the scanner was configured but unreachable', async () => {
		const t = setupTest();
		configureMta();
		// Every /scan/attachment call fails — `scanInboundAttachments` fails OPEN
		// with a 'skipped' verdict, which is NOT a statement that the file is safe.
		globalThis.fetch = vi.fn(async () => {
			throw new Error('clamav unreachable');
		}) as unknown as typeof globalThis.fetch;

		await ingest(
			t,
			'skipped-1@example.com',
			encode(buildEmlWithAttachment('skipped-1@example.com')),
			NOTES_META
		);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]!.virusVerdict).toBe('skipped');
		// The message, its metadata and its downloadable `.eml` all survive.
		expect(rows[0]!.processingStatus).not.toBe('quarantined');
		expect(rows[0]!.rawStorageId).toBeTruthy();
		// But nothing unscanned was handed to a model, and the row says why, so
		// the reader can say it too.
		expect(rows[0]!.attachmentIndexing).toBe('skipped_unscanned');
		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(0);
	});

	it('asserts no verdict and indexes nothing when the scanner is not configured', async () => {
		const t = setupTest();
		unconfigureMta();
		const scanner = stubScanner({ clean: true });

		await ingest(
			t,
			'noscanner-1@example.com',
			encode(buildEmlWithAttachment('noscanner-1@example.com')),
			NOTES_META
		);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		// UNDEFINED, not 'clean'. "The scanner is not configured" and "the file is
		// safe" are different claims and only one of them is ours to make.
		expect(rows[0]!.virusVerdict).toBeUndefined();
		expect(scanner.calls()).toBe(0);
		expect(rows[0]!.attachmentIndexing).toBe('skipped_unscanned');

		// No scanner means no CLEAN verdict, and only a clean verdict feeds bytes
		// to summarise/embed. The attachment is still stored, listed and
		// downloadable out of the raw `.eml`.
		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(0);
	});

	it('makes no scan request and asserts no verdict for a message with no attachments', async () => {
		const t = setupTest();
		configureMta();
		const scanner = stubScanner({ clean: true });

		await ingest(t, 'plain-1@example.com', encode(buildPlainEml('plain-1@example.com')), []);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]!.virusVerdict).toBeUndefined();
		expect(rows[0]!.rawStorageId).toBeTruthy();
		expect(scanner.calls()).toBe(0);
		// No attachment leaves ⇒ nothing was skipped; the row stays unmarked.
		expect(rows[0]!.attachmentIndexing).toBeUndefined();

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
		expect(rows[0]!.isRawRetained).toBeUndefined();
		expect(rows[0]!.virusVerdict).toBeUndefined();
		expect(scanner.calls()).toBe(0);
	});
});

describe('inboundIngest — a payload whose bytes do not decode', () => {
	it('stores the message with NO raw blob rather than sealing a zero-byte one', async () => {
		const t = setupTest();
		configureMta();
		const scanner = stubScanner({ clean: true });

		// `base64ToBytes` answers undecodable input with zero bytes instead of
		// throwing (it ignores characters outside the alphabet, so a body of pure
		// punctuation decodes to nothing). A sealed 0-byte blob would still set
		// `rawStorageId`, so the reader would render an ENABLED download that
		// extracts nothing and can never be retried into working — "Try again"
		// for something that will never succeed.
		await ingest(t, 'garbage-1@example.com', '%%%% !!!! ????', [
			{ filename: 'invoice.pdf', contentType: 'application/pdf', size: 10, partIndex: '0' },
		]);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]!.rawStorageId).toBeUndefined();
		expect(rows[0]!.rawSize).toBeUndefined();
		expect(rows[0]!.isRawRetained).toBeUndefined();
		expect(rows[0]!.virusVerdict).toBeUndefined();
		// Nothing was sealed, so nothing is in storage and nothing was scanned.
		expect(scanner.calls()).toBe(0);
		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(0);
	});
});

describe('inboundIngest — idempotency', () => {
	it('re-acknowledges a redelivered Message-ID instead of duplicating it', async () => {
		const t = setupTest();
		configureMta();
		stubScanner({ clean: true });
		const raw = encode(buildEmlWithAttachment('retry-1@example.com'));

		const first = await ingest(t, 'retry-1@example.com', raw, NOTES_META);
		expect(first.isDuplicate).toBe(false);

		// The MTA aborts at 10 s and retries; aborting its fetch does not stop the
		// action, so the identical delivery arrives again.
		const second = await ingest(t, 'retry-1@example.com', raw, NOTES_META);
		expect(second.isDuplicate).toBe(true);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		// One row, one capture, one thread bump — not two of each.
		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(1);
		const threads = await t.run((ctx) => ctx.db.query('conversationThreads').collect());
		expect(threads).toHaveLength(1);
		expect(threads[0]!.messageCount).toBe(1);
	});

	it('drops the blob it staged when the transactional check finds the row first', async () => {
		const t = setupTest();
		configureMta();
		stubScanner({ clean: true });
		const raw = encode(buildEmlWithAttachment('race-1@example.com'));

		await ingest(t, 'race-1@example.com', raw, NOTES_META);
		const storedAfterFirst = await t.run((ctx) => ctx.db.system.query('_storage').collect());

		// Losing the race means the action's cheap pre-check ran before the first
		// attempt inserted, so only the transactional half can catch it. Drive
		// `receiveMessage` directly — that IS the transactional half — and assert
		// it refuses rather than inserting a second row.
		const dup = await t.mutation(internal.inbox.messages.receiveMessage, {
			from: 'Bob <bob@example.com>',
			to: 'inbox@example.com',
			subject: 'subject',
			textBody: 'body',
			headers: '{}',
			messageId: '<race-1@example.com>',
			timestamp: Date.now(),
		});
		expect(dup.isDuplicate).toBe(true);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		// No second sealed `.eml` was added by the refused write.
		const storedNow = await t.run((ctx) => ctx.db.system.query('_storage').collect());
		expect(storedNow).toHaveLength(storedAfterFirst.length);
	});
});
