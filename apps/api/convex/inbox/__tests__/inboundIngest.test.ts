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
 *   · a redelivered Message-ID is re-acknowledged, not duplicated;
 *   · a part the AI-ingest policy refuses — over the size ceiling, an
 *     executable under a safe-looking name, an unnamed leaf — is stored and
 *     listed but MARKED, so the thread view never renders an unread file as an
 *     indexed one;
 *   · a leaf the scan never opened is never ingested — ten `.exe` stubs ahead
 *     of a `.txt` used to spend the scanner's budget on the stubs and leave
 *     capture a free slot for the one file nobody had scanned;
 *   · a message whose only attachment is an INLINE signature logo is not
 *     reported as unscanned: there was nothing to scan;
 *   · a `.docx` is marked as name-only, because the extractor answers it with
 *     its own filename and a row that says `indexed` would claim otherwise;
 *   · a header name Convex cannot store (`$`-prefixed, non-ASCII) is dropped
 *     and the message is STORED — it used to 500 the route and dead-letter
 *     perfectly deliverable mail;
 *   · the staged blob is dropped on both exits that do not end in a row
 *     referencing it: the lost-race duplicate and a throwing `receiveMessage`;
 *   · degenerate MIME (a multipart with no closing delimiter, a base64 leaf of
 *     pure garbage, a zero-byte leaf) stores one row and throws nothing: a
 *     throw here is a 500 the MTA retries six times and then dead-letters.
 *
 * Every case asserts the message row exists. This path has a hard never-drop
 * invariant: there is no SMTP 5xx to fall back on once DATA was accepted.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import {
	ATTACHMENT_COMPOSE_LIMITS,
	MAX_AI_INGEST_ATTACHMENT_BYTES,
} from '@owlat/shared/attachments';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { getInboundChannelAdapter } from '../../webhooks/adapters/inboundRegistry';

/**
 * The two blob-drop branches are reachable only from OUTSIDE the action.
 *
 * `dropStagedBlob` runs when the cheap pre-check misses a row the
 * transactional check then finds, and when `receiveMessage` throws — and the
 * pre-check and the transactional check are deliberately the same query
 * (`findStoredDuplicate`), so no input makes them disagree. The only honest way
 * to drive the race is to make the pre-check answer `null` on demand, which is
 * what these hooks do: the real module, with `findIdByMessageId` and
 * `receiveMessage` wrapped.
 */
const hooks = vi.hoisted(() => ({ blindPreCheck: false, failReceive: false }));

/**
 * The real `inbox/messages` module with two seams.
 *
 * A registered Convex function is an object convex-test invokes through
 * `_handler`, so wrapping one means cloning it and swapping that field — the
 * validators, the `isMutation` flag and the return validator all stay the
 * originals, and with the hooks off both functions ARE the originals.
 */
function withHandler<T extends { _handler: (...args: never[]) => unknown }>(
	fn: T,
	handler: (...args: never[]) => unknown
): T {
	return { ...fn, _handler: handler } as T;
}

vi.mock('../messages', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../messages')>();
	const findIdByMessageId = actual.findIdByMessageId as unknown as {
		_handler: (...args: never[]) => unknown;
	};
	const receiveMessage = actual.receiveMessage as unknown as {
		_handler: (...args: never[]) => unknown;
	};
	return {
		...actual,
		// The action's cheap idempotency pre-check, blinded on demand so the
		// transactional check inside `receiveMessage` is the only thing left to
		// catch a redelivery — which is the race the blob drop exists for.
		findIdByMessageId: withHandler(findIdByMessageId, async (...args: never[]) =>
			hooks.blindPreCheck ? null : await findIdByMessageId._handler(...args)
		),
		// A mutation that throws AFTER the blob was sealed: a transient db error,
		// a scheduler failure. The bytes must not survive it.
		receiveMessage: withHandler(receiveMessage, async (...args: never[]) => {
			if (hooks.failReceive) throw new Error('receiveMessage exploded');
			return await receiveMessage._handler(...args);
		}),
	};
});

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
	hooks.blindPreCheck = false;
	hooks.failReceive = false;
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

/**
 * Stub `/scan/attachment` with a per-filename answer, so one message can have a
 * leaf the scanner cleared and a leaf it never answered for.
 *
 * A filename with no entry gets a clean verdict; an entry of `503` answers the
 * HTTP error the shared client fails open on.
 */
function stubScannerPerFile(answers: Record<string, { clean: boolean; stage?: string } | 503>): {
	scanned: () => string[];
} {
	const scanned: string[] = [];
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (!url.includes('/scan/attachment')) throw new Error(`unexpected fetch: ${url}`);
		const filename = String((init?.headers as Record<string, string>)['X-Filename']);
		scanned.push(filename);
		const answer = answers[filename] ?? { clean: true };
		if (answer === 503) return new Response('scanner down', { status: 503 });
		return new Response(JSON.stringify(answer), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}) as unknown as typeof globalThis.fetch;
	return { scanned: () => scanned };
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

/** A message whose single attachment leaf is whatever the caller describes. */
function buildEmlWithLeaf(messageId: string, leaf: { headers: string[]; body: string }): string {
	return [
		'From: Bob <bob@example.com>',
		'To: inbox@example.com',
		'Subject: crafted',
		`Message-ID: <${messageId}>`,
		'Content-Type: multipart/mixed; boundary="bb"',
		'',
		'--bb',
		'Content-Type: text/plain; charset=utf-8',
		'',
		'See attached.',
		'',
		'--bb',
		...leaf.headers,
		'',
		// A truly EMPTY leaf has no body line at all — an empty string here would
		// still be a line, and a CRLF is a byte.
		...(leaf.body === '' ? [] : [leaf.body, '']),
		'--bb--',
		'',
	].join('\r\n');
}

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

	it("stores a different sender's message that reuses the same Message-ID", async () => {
		const t = setupTest();
		configureMta();
		stubScanner({ clean: true });

		await ingest(
			t,
			'shared-id@example.com',
			encode(buildEmlWithAttachment('shared-id@example.com')),
			NOTES_META
		);

		// `Message-ID:` is free text the sender chose, and clients and ticketing
		// systems do reuse one across genuinely different mail. Matching on the
		// header alone answered 200 and stored nothing — a delivery the MTA logs
		// as successful that nobody ever sees, on a path whose whole invariant is
		// that mail is never dropped.
		const second = await t.action(internal.inbox.inboundIngest.ingestFromWebhook, {
			mail: {
				from: 'Carol <carol@other.example>',
				to: 'inbox@example.com',
				subject: 'a different message entirely',
				textBody: 'body',
				headers: {},
				messageId: '<shared-id@example.com>',
				attachments: [],
				timestamp: Date.now(),
			},
		});
		expect(second.isDuplicate).toBe(false);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.from).sort()).toEqual([
			'Bob <bob@example.com>',
			'Carol <carol@other.example>',
		]);
	});

	it('drops the blob it staged when it loses the race to a concurrent delivery', async () => {
		const t = setupTest();
		configureMta();
		stubScanner({ clean: true });
		const raw = encode(buildEmlWithAttachment('race-1@example.com'));

		await ingest(t, 'race-1@example.com', raw, NOTES_META);
		const storedAfterFirst = await t.run((ctx) => ctx.db.system.query('_storage').collect());

		// Losing the race means the cheap pre-check ran BEFORE the first attempt
		// inserted, so only the transactional check inside `receiveMessage` can
		// catch the duplicate — by which point this attempt has already sealed a
		// 10 MiB blob no row will ever reference. Blinding the pre-check is what
		// puts the action on that branch; the two checks are otherwise the same
		// query and no input makes them disagree.
		hooks.blindPreCheck = true;
		const second = await ingest(t, 'race-1@example.com', raw, NOTES_META);
		expect(second.isDuplicate).toBe(true);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		// THE ASSERTION THAT BITES: the second attempt sealed a blob and then
		// dropped it. Without the drop this is one higher, and the orphan is
		// unreachable forever — the retention sweep walks rows, and no row
		// points at it.
		const storedNow = await t.run((ctx) => ctx.db.system.query('_storage').collect());
		expect(storedNow).toHaveLength(storedAfterFirst.length);
	});

	it('drops the blob it staged when the receive mutation throws, and rethrows', async () => {
		const t = setupTest();
		configureMta();
		stubScanner({ clean: true });
		const before = await t.run((ctx) => ctx.db.system.query('_storage').collect());

		// A transient db error, a scheduler failure: anything that throws after
		// the blob is sealed and before a row references it.
		hooks.failReceive = true;
		await expect(
			ingest(
				t,
				'boom-1@example.com',
				encode(buildEmlWithAttachment('boom-1@example.com')),
				NOTES_META
			)
		).rejects.toThrow('receiveMessage exploded');

		// Nothing was stored, so nothing may be left behind — and the throw is
		// re-raised so the MTA retries into a clean slate rather than being told
		// the delivery succeeded.
		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(0);
		const after = await t.run((ctx) => ctx.db.system.query('_storage').collect());
		expect(after).toHaveLength(before.length);
	});
});

describe('inboundIngest — the set that was scanned is the set that is indexed', () => {
	it("never indexes a leaf the scanner's cap left unopened", async () => {
		const t = setupTest();
		configureMta();
		const scanner = stubScanner({ clean: true });

		// The craft: fill the scanner's per-message budget with leaves the
		// file-type allowlist will refuse, then append one it accepts. The
		// scanner opens the first ten in MIME order — the stubs — and capture
		// used to drop the stubs BEFORE counting, so it still had a slot for
		// `payload.txt`: a file that went to summarise, embed and knowledge
		// extraction without ever being scanned.
		const stubs = Array.from(
			{ length: ATTACHMENT_COMPOSE_LIMITS.maxCount },
			(_, i) => `stub${i}.exe`
		);
		const leaves = [...stubs, 'payload.txt'];
		const lines = [
			'From: Bob <bob@example.com>',
			'To: inbox@example.com',
			'Subject: crafted',
			'Message-ID: <craft-1@example.com>',
			'Content-Type: multipart/mixed; boundary="bb"',
			'',
			'--bb',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'See attached.',
			'',
		];
		for (const name of leaves) {
			lines.push(
				'--bb',
				`Content-Type: text/plain; name="${name}"`,
				`Content-Disposition: attachment; filename="${name}"`,
				'Content-Transfer-Encoding: base64',
				'',
				Buffer.from(`a document called ${name} with words in it`).toString('base64'),
				''
			);
		}
		lines.push('--bb--', '');

		await ingest(
			t,
			'craft-1@example.com',
			encode(lines.join('\r\n')),
			leaves.map((filename, i) => ({
				filename,
				contentType: 'text/plain',
				size: 40,
				partIndex: String(i + 1),
			}))
		);

		// Exactly the cap was scanned, and it was the stubs.
		expect(scanner.calls()).toBe(ATTACHMENT_COMPOSE_LIMITS.maxCount);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		// NOTHING was indexed: the ten scanned leaves are a refused type, and the
		// one leaf of an accepted type was never scanned.
		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files.map((f) => f.filename)).not.toContain('payload.txt');
		expect(files).toHaveLength(0);
		// And the verdict does not call a message we only partly opened clean.
		expect(rows[0]!.virusVerdict).toBe('skipped');
		expect(rows[0]!.rawStorageId).toBeTruthy();
	});

	it('marks a message whose leaves outran the cap, even where some were read', async () => {
		const t = setupTest();
		configureMta();
		stubScanner({ clean: true });

		// One readable file first, then enough refused leaves to outrun the
		// per-message cap. The scanner opens ten of the twelve, so two leaves are
		// never looked at — and the row has to say so, or the reader is shown
		// twelve rows that all look read.
		//
		// Shaped to stage ONE blob: convex-test mis-tracks transaction state
		// across an action's sub-operations, so a second `ctx.storage.store`
		// inside one action is unreliable (see captureAttachmentsScope.test.ts).
		// The ten-readable-files case is driven through `captureAttachments`
		// there, with a counting ctx.
		const leaves = ['notes.txt', ...Array.from({ length: 11 }, (_, i) => `stub${i}.exe`)];
		const lines = [
			'From: Bob <bob@example.com>',
			'To: inbox@example.com',
			'Subject: twelve leaves',
			'Message-ID: <cap-e2e@example.com>',
			'Content-Type: multipart/mixed; boundary="bb"',
			'',
			'--bb',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'See attached.',
			'',
		];
		for (const name of leaves) {
			lines.push(
				'--bb',
				`Content-Type: text/plain; name="${name}"`,
				`Content-Disposition: attachment; filename="${name}"`,
				'Content-Transfer-Encoding: base64',
				'',
				Buffer.from(`a document called ${name} with words in it`).toString('base64'),
				''
			);
		}
		lines.push('--bb--', '');

		await ingest(
			t,
			'cap-e2e@example.com',
			encode(lines.join('\r\n')),
			leaves.map((filename, i) => ({
				filename,
				contentType: 'text/plain',
				size: 40,
				partIndex: String(i + 1),
			}))
		);

		// The readable leaf was scanned and indexed...
		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files.map((f) => f.filename)).toEqual(['notes.txt']);
		// ...and the row still reports the cap, which outranks the type skip:
		// "more files than it processes" is the bigger thing the reader is
		// missing.
		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows[0]!.attachmentIndexing).toBe('skipped_cap');
	});
});

describe('inboundIngest — what the row says about files nobody read', () => {
	it('scans an inline signature logo but never indexes it', async () => {
		const t = setupTest();
		configureMta();
		const scanner = stubScannerPerFile({});

		// Ordinary corporate mail. The logo IS scanned — the MTA lists it in
		// `attachments` and the thread view offers a download for it, so
		// `inline` must not be a way past ClamAV — but it is not a document
		// anyone attached, so nothing is indexed and nothing is claimed unread.
		// A warning here would be a warning about nothing, which is how a
		// warning stops being read.
		const raw = [
			'From: Bob <bob@example.com>',
			'To: inbox@example.com',
			'Subject: regards',
			'Message-ID: <sig-1@example.com>',
			'Content-Type: multipart/related; boundary="bb"',
			'',
			'--bb',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Best regards',
			'',
			'--bb',
			'Content-Type: image/png; name="logo.png"',
			'Content-Disposition: inline; filename="logo.png"',
			'Content-Transfer-Encoding: base64',
			'',
			Buffer.from('not really a png').toString('base64'),
			'',
			'--bb--',
			'',
		].join('\r\n');

		await ingest(t, 'sig-1@example.com', encode(raw), [
			{ filename: 'logo.png', contentType: 'image/png', size: 16, partIndex: '1' },
		]);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		expect(scanner.scanned()).toEqual(['logo.png']);
		expect(rows[0]!.virusVerdict).toBe('clean');
		expect(rows[0]!.attachmentIndexing).toBeUndefined();
		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(0);
	});

	it('quarantines an INLINE executable instead of offering it for download', async () => {
		const t = setupTest();
		configureMta();
		// The craft is one header word: `Content-Disposition: inline` on an
		// `invoice.pdf.exe`. The leaf used to be dropped before the scan, so the
		// message stored no verdict at all and the thread view rendered a normal
		// row with a live download beside it — the same file with `attachment`
		// would have been scanned and quarantined.
		const scanner = stubScannerPerFile({
			'invoice.pdf.exe': { clean: false },
		});

		await ingest(
			t,
			'inline-exe@example.com',
			encode(
				buildEmlWithLeaf('inline-exe@example.com', {
					headers: [
						'Content-Type: application/octet-stream; name="invoice.pdf.exe"',
						'Content-Disposition: inline; filename="invoice.pdf.exe"',
						'Content-Transfer-Encoding: base64',
					],
					body: Buffer.from('MZ this is an executable').toString('base64'),
				})
			),
			[
				{
					filename: 'invoice.pdf.exe',
					contentType: 'application/octet-stream',
					size: 24,
					partIndex: '1',
				},
			]
		);

		expect(scanner.scanned()).toEqual(['invoice.pdf.exe']);
		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows[0]!.virusVerdict).toBe('infected');
		expect(rows[0]!.processingStatus).toBe('quarantined');

		// And the signed-URL source refuses it, so the download the reader hides
		// is refused server-side too.
		const storageId = await t.run(async (ctx) => {
			const row = await ctx.db.get(rows[0]!._id);
			return row!.rawStorageId;
		});
		expect(storageId).toBeTruthy();
		await expect(
			t.query(internal.inbox.rawMessage.getInboundMessageRawStorageId, {
				messageId: rows[0]!._id,
			})
		).resolves.toBeNull();
	});

	it('marks an inline leaf the scanner could not answer for as unscanned', async () => {
		const t = setupTest();
		configureMta();
		stubScannerPerFile({ 'invoice.pdf.exe': 503 });

		await ingest(
			t,
			'inline-skip@example.com',
			encode(
				buildEmlWithLeaf('inline-skip@example.com', {
					headers: [
						'Content-Type: application/octet-stream; name="invoice.pdf.exe"',
						'Content-Disposition: inline; filename="invoice.pdf.exe"',
						'Content-Transfer-Encoding: base64',
					],
					body: Buffer.from('MZ this is an executable').toString('base64'),
				})
			),
			[
				{
					filename: 'invoice.pdf.exe',
					contentType: 'application/octet-stream',
					size: 24,
					partIndex: '1',
				},
			]
		);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows[0]!.virusVerdict).toBe('skipped');
		expect(rows[0]!.attachmentIndexing).toBe('skipped_unscanned');
	});

	it('says a leaf went UNSCANNED, not that the message outran the cap', async () => {
		const t = setupTest();
		configureMta();
		// Two files, ClamAV answered for one of them. Reporting this as the cap
		// ("this message has more attachments than it processes") on a
		// two-attachment message sends an operator to a limit instead of to the
		// scanner outage that is the thing to fix.
		const { scanned } = stubScannerPerFile({ 'broken.pdf': 503 });

		const lines = [
			'From: Bob <bob@example.com>',
			'To: inbox@example.com',
			'Subject: two files',
			'Message-ID: <partial-scan@example.com>',
			'Content-Type: multipart/mixed; boundary="bb"',
			'',
			'--bb',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'See attached.',
			'',
			'--bb',
			'Content-Type: application/pdf; name="broken.pdf"',
			'Content-Disposition: attachment; filename="broken.pdf"',
			'Content-Transfer-Encoding: base64',
			'',
			Buffer.from('%PDF-1.4 pretend').toString('base64'),
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

		await ingest(t, 'partial-scan@example.com', encode(lines), [
			{ filename: 'broken.pdf', contentType: 'application/pdf', size: 16, partIndex: '1' },
			{ filename: 'notes.txt', contentType: 'text/plain', size: 52, partIndex: '2' },
		]);

		expect(scanned()).toEqual(['broken.pdf', 'notes.txt']);
		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		// Only the leaf the scanner cleared reached a model...
		expect(files.map((f) => f.filename)).toEqual(['notes.txt']);
		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		// ...and the line the reader gets names the outage.
		expect(rows[0]!.attachmentIndexing).toBe('skipped_unscanned');
	});

	it('does not call a file-type refusal from the scanner malware', async () => {
		const t = setupTest();
		configureMta();
		// The MTA's `/scan/attachment` runs its file-type allowlist BEFORE
		// ClamAV and refuses with the same `clean: false` envelope a virus gets,
		// tagged `file_type_validation`. Read as malware, a customer's legacy
		// Word document quarantined the message, suppressed the reply draft and
		// told the operator malware had been found.
		stubScannerPerFile({
			'report.doc': { clean: false, stage: 'file_type_validation' },
		});

		await ingest(
			t,
			'legacy-doc@example.com',
			encode(
				buildEmlWithLeaf('legacy-doc@example.com', {
					headers: [
						'Content-Type: application/msword; name="report.doc"',
						'Content-Disposition: attachment; filename="report.doc"',
						'Content-Transfer-Encoding: base64',
					],
					body: Buffer.from('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1 an OLE2 document', 'latin1').toString(
						'base64'
					),
				})
			),
			[{ filename: 'report.doc', contentType: 'application/msword', size: 30, partIndex: '1' }]
		);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]!.virusVerdict).not.toBe('infected');
		expect(rows[0]!.processingStatus).not.toBe('quarantined');
		// Not read, but not malware either: the line says the type was not
		// processed.
		expect(rows[0]!.attachmentIndexing).toBe('skipped_unsupported');
	});

	it('marks a Word document as name-only rather than indexed', async () => {
		const t = setupTest();
		configureMta();
		stubScanner({ clean: true });

		// `.docx` passes the allowlist and reaches `semanticFiles.ingest`, but the
		// extractor answers it with `[Word document: contract.docx]` — so the
		// summary, the embedding and `[RELEVANT FILES]` all work from a filename.
		// `indexed` would tell the reader the assistant has the contract.
		await ingest(
			t,
			'docx-1@example.com',
			encode(
				buildEmlWithLeaf('docx-1@example.com', {
					headers: [
						'Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document; name="contract.docx"',
						'Content-Disposition: attachment; filename="contract.docx"',
						'Content-Transfer-Encoding: base64',
					],
					body: Buffer.from('PK a zip container, really').toString('base64'),
				})
			),
			[
				{
					filename: 'contract.docx',
					contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
					size: 26,
					partIndex: '1',
				},
			]
		);

		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(1);
		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows[0]!.attachmentIndexing).toBe('indexed_placeholder');
	});

	it('indexes nothing at all when DMARC failed the sender', async () => {
		const t = setupTest();
		configureMta();
		stubScanner({ clean: true });

		// There is no safe scope for a document from a sender nobody can verify:
		// under the claimed contact it joins that customer's retrieval, and
		// ORG-GENERAL — which is what this used to do — joins EVERY contact's.
		await t.action(internal.inbox.inboundIngest.ingestFromWebhook, {
			mail: {
				from: 'CEO <ceo@customer.example>',
				to: 'inbox@example.com',
				subject: 'urgent wire instructions',
				textBody: 'body',
				headers: {},
				messageId: '<spoof-e2e@example.com>',
				attachments: NOTES_META,
				timestamp: Date.now(),
				dmarcResult: 'fail',
			},
			rawBytesBase64: encode(buildEmlWithAttachment('spoof-e2e@example.com')),
		});

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		// Never dropped: the message, its metadata and its `.eml` all survive.
		expect(rows[0]!.rawStorageId).toBeTruthy();
		expect(rows[0]!.attachmentIndexing).toBe('skipped_unverified');
		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(0);
	});
});

describe('inboundIngest — header names a sender chose', () => {
	it('stores a message carrying header names Convex cannot hold', async () => {
		const t = setupTest();
		configureMta();
		stubScanner({ clean: true });

		// `$x: y` is a valid RFC 5322 field name, and Convex reserves a leading
		// `$` in an object key — so forwarding the parsed map threw inside the
		// route's try/catch, answered 500, and the MTA read that as retryable:
		// six attempts and then the Redis DLQ, where nobody is looking. On a path
		// whose whole invariant is that mail is never dropped.
		await t.action(internal.inbox.inboundIngest.ingestFromWebhook, {
			mail: getInboundChannelAdapter('mta').parseInbound({
				event: 'inbound.received',
				timestamp: Date.now(),
				inboundPayload: {
					from: 'Bob <bob@example.com>',
					to: 'inbox@example.com',
					subject: 'crafted headers',
					textBody: 'body',
					headers: {
						'x-ordinary': 'kept',
						$weird: 'reserved prefix',
						'x-Ünicode': 'non-ascii name',
						'x-control\u0001': 'control character',
						['x-'.padEnd(2000, 'a')]: 'over the field-name length cap',
						'x-not-a-string': 42 as unknown as string,
					},
					messageId: '<headers-1@example.com>',
					attachments: [],
				},
			}),
			rawBytesBase64: encode(buildPlainEml('headers-1@example.com')),
		});

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		// THE ROW EXISTS. That is the whole assertion: the message arrived.
		expect(rows).toHaveLength(1);
		const stored = JSON.parse(rows[0]!.headers ?? '{}') as Record<string, string>;
		// The storable header survived; the ones Convex would have thrown on did
		// not, and their loss is a logged drop rather than a dead-lettered
		// message.
		expect(stored['x-ordinary']).toBe('kept');
		expect(Object.keys(stored)).toEqual(['x-ordinary']);
	});
});

describe('inboundIngest — parts the assistant will not read', () => {
	it('marks a part over the AI-ingest ceiling instead of leaving the row silent', async () => {
		const t = setupTest();
		configureMta();
		stubScanner({ clean: true });

		// One leaf just over the per-attachment ceiling. It is a real, deliverable
		// size (the listener accepts messages up to MAX_INBOUND_MESSAGE_BYTES), so
		// this is a state a sender can actually reach.
		const oversized = Buffer.from('x'.repeat(MAX_AI_INGEST_ATTACHMENT_BYTES + 1)).toString(
			'base64'
		);
		await ingest(
			t,
			'toobig-1@example.com',
			encode(
				buildEmlWithLeaf('toobig-1@example.com', {
					headers: [
						'Content-Type: application/pdf; name="huge.pdf"',
						'Content-Disposition: attachment; filename="huge.pdf"',
						'Content-Transfer-Encoding: base64',
					],
					body: oversized,
				})
			),
			[
				{
					filename: 'huge.pdf',
					contentType: 'application/pdf',
					size: MAX_AI_INGEST_ATTACHMENT_BYTES + 1,
					partIndex: '1',
				},
			]
		);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		// The bytes arrived, were scanned and are downloadable...
		expect(rows[0]!.virusVerdict).toBe('clean');
		expect(rows[0]!.rawStorageId).toBeTruthy();
		// ...but nothing was indexed, and the row SAYS SO. Without the marker the
		// thread view renders this exactly like a file the assistant read.
		expect(rows[0]!.attachmentIndexing).toBe('skipped_too_large');
		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(0);
	});

	it('keeps an executable out of the file library even under a document name', async () => {
		const t = setupTest();
		configureMta();
		stubScanner({ clean: true });

		// The double-extension trick, plus a null byte before the real one — the
		// two shapes a filename allowlist has to survive.
		await ingest(
			t,
			'exe-1@example.com',
			encode(
				buildEmlWithLeaf('exe-1@example.com', {
					headers: [
						'Content-Type: application/pdf; name="invoice.pdf\u0000.exe"',
						'Content-Disposition: attachment; filename="invoice.pdf.exe"',
						'Content-Transfer-Encoding: base64',
					],
					body: Buffer.from('MZ not really a document').toString('base64'),
				})
			),
			[{ filename: 'invoice.pdf.exe', contentType: 'application/pdf', size: 24, partIndex: '1' }]
		);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		// Never dropped: an operator can still see what was sent and download it.
		expect(rows[0]!.rawStorageId).toBeTruthy();
		expect(rows[0]!.attachmentIndexing).toBe('skipped_unsupported');
		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(0);
	});

	it('does not index a leaf with no filename at all', async () => {
		const t = setupTest();
		configureMta();
		stubScanner({ clean: true });

		// `extractAttachments` names an anonymous leaf "attachment", which has no
		// extension — and the allowlist blocks by default rather than guessing.
		await ingest(
			t,
			'noname-1@example.com',
			encode(
				buildEmlWithLeaf('noname-1@example.com', {
					headers: ['Content-Type: application/pdf', 'Content-Disposition: attachment'],
					body: 'some bytes',
				})
			),
			[{ filename: '', contentType: 'application/pdf', size: 10, partIndex: '1' }]
		);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]!.attachmentIndexing).toBe('skipped_unsupported');
		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(0);
	});
});

describe('inboundIngest — degenerate MIME', () => {
	it('stores a message whose multipart has no closing delimiter', async () => {
		const t = setupTest();
		configureMta();
		stubScanner({ clean: true });

		const truncated = [
			'From: Bob <bob@example.com>',
			'To: inbox@example.com',
			'Subject: truncated',
			'Message-ID: <trunc-1@example.com>',
			'Content-Type: multipart/mixed; boundary="bb"',
			'',
			'--bb',
			'Content-Type: text/plain; name="notes.txt"',
			'Content-Disposition: attachment; filename="notes.txt"',
			'Content-Transfer-Encoding: base64',
			'',
			'!!!! not base64 at all ????',
			// No `--bb--`: the message ends mid-part.
		].join('\r\n');

		// The MIME walker runs on attacker-supplied bytes BEFORE the row is
		// written. A throw here would 500 a delivery the MTA already accepted over
		// SMTP — six retries, then the DLQ, where nobody looks.
		await expect(
			ingest(t, 'trunc-1@example.com', encode(truncated), [
				{ filename: 'notes.txt', contentType: 'text/plain', size: 10, partIndex: '0' },
			])
		).resolves.toEqual({ inboundMessageId: expect.anything(), isDuplicate: false });

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]!.rawStorageId).toBeTruthy();
	});

	it('asserts no verdict and indexes nothing for a zero-byte attachment leaf', async () => {
		const t = setupTest();
		configureMta();
		const scanner = stubScanner({ clean: true });

		await ingest(
			t,
			'empty-1@example.com',
			encode(
				buildEmlWithLeaf('empty-1@example.com', {
					headers: [
						'Content-Type: text/plain; name="empty.txt"',
						'Content-Disposition: attachment; filename="empty.txt"',
					],
					body: '',
				})
			),
			[{ filename: 'empty.txt', contentType: 'text/plain', size: 0, partIndex: '1' }]
		);

		const rows = await t.run((ctx) => ctx.db.query('inboundMessages').collect());
		expect(rows).toHaveLength(1);
		// An empty leaf is not an attachment: nothing to scan, nothing to index,
		// and no verdict to assert about bytes that are not there.
		expect(scanner.calls()).toBe(0);
		expect(rows[0]!.virusVerdict).toBeUndefined();
		const files = await t.run((ctx) => ctx.db.query('semanticFiles').collect());
		expect(files).toHaveLength(0);
	});
});
