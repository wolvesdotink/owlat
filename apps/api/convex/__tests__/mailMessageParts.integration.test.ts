/**
 * Attachment parts stored one blob per part (plan 3.5 / E6), end to end.
 *
 * Driven through the real MX ingest (`mail.delivery.ingestFromWebhook`), the
 * reader actions and the `/sealed-blob` route:
 *   - delivery cuts every attachment leaf and the first text/calendar leaf out
 *     into their own SEALED blobs, recorded against the raw blob;
 *   - the reader gets one part through a cacheable URL (private, max-age,
 *     immutable) while the raw `.eml` stays `no-store`;
 *   - the invite card gets the iCalendar text without the raw message, and a
 *     message with no stored parts says `unknown` so the client falls back;
 *   - an invite in a legacy charset is stored transcoded to UTF-8, so the
 *     `charset=utf-8` it is stored under is true (#1299);
 *   - the parts live exactly as long as the raw blob: an IMAP COPY sibling
 *     keeps them, the last purge frees them, and a duplicate delivery drops
 *     the parts it staged along with its raw blob;
 *   - a message with more leaves than are stored records no parts at all.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { SEALED_BLOB_PATH } from '../lib/sealedBlob';
import { isSealedBytesAtRest } from '../lib/atRestBodies';
import { deleteMessageRowAndBlobs } from '../mail/messagePurge';
import { MAX_STORED_PARTS } from '../mail/messageParts';
import { enableFeatures } from './factories';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
});

const modules = import.meta.glob('../**/*.*s');

const SITE = 'https://deploy.convex.site';
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', 'message-parts-integration-secret-32-chars-min');
	vi.stubEnv('CONVEX_SITE_URL', SITE);
	vi.stubEnv('ALLOWED_ORIGINS', 'https://app.example.com');
	originalFetch = globalThis.fetch;
	// ClamAV answering clean; anything else is a bug in the test.
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (!url.includes('/scan/attachment')) throw new Error(`unexpected fetch: ${url}`);
		return new Response(JSON.stringify({ clean: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const ICS = [
	'BEGIN:VCALENDAR',
	'METHOD:REQUEST',
	'BEGIN:VEVENT',
	'SUMMARY:Planning',
	'DTSTART:20261001T090000Z',
	'END:VEVENT',
	'END:VCALENDAR',
].join('\r\n');

function part(headers: string[], body: string): string[] {
	return ['--mix', ...headers, 'Content-Transfer-Encoding: base64', '', b64(body), ''];
}

function b64(text: string): string {
	return Buffer.from(text, 'utf8').toString('base64');
}

/** Body + inline invite (no filename) + a PDF-ish file + the same invite as .ics. */
function buildRawEml(messageId: string, extraLeaves = 0): string {
	const extras: string[] = [];
	for (let i = 0; i < extraLeaves; i++) {
		extras.push(
			...part(
				[`Content-Type: text/plain; name="x${i}.txt"`, `Content-Disposition: attachment`],
				`extra ${i}`
			)
		);
	}
	return [
		'From: Bob <bob@example.com>',
		'To: alice@example.com',
		'Subject: planning',
		`Message-ID: ${messageId}`,
		'Content-Type: multipart/mixed; boundary="mix"',
		'',
		...part(['Content-Type: text/plain; charset=utf-8'], 'See you there.'),
		...part(['Content-Type: text/calendar; method=REQUEST; charset=utf-8'], ICS),
		...part(
			['Content-Type: application/pdf; name="agenda.pdf"', 'Content-Disposition: attachment'],
			'%PDF-1.4 agenda bytes'
		),
		...part(
			['Content-Type: text/calendar; name="invite.ics"', 'Content-Disposition: attachment'],
			ICS
		),
		...extras,
		'--mix--',
		'',
	].join('\r\n');
}

function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

async function seedInbox(t: ReturnType<typeof convexTest>): Promise<void> {
	await enableFeatures(t, ['mail.external']);
	await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
			address: 'alice@example.com',
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			role: 'inbox',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 0,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
	});
}

async function drain(t: ReturnType<typeof convexTest>): Promise<void> {
	for (let i = 0; i < 3; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await t.finishInProgressScheduledFunctions();
	}
}

async function deliver(
	t: ReturnType<typeof convexTest>,
	messageId: string,
	extraLeaves = 0,
	raw = buildRawEml(messageId, extraLeaves)
): Promise<Id<'mailMessages'>> {
	const result = await t.action(internal.mail.delivery.ingestFromWebhook, {
		deliveryId: `d-${messageId}`,
		rawBytesBase64: Buffer.from(raw, 'latin1').toString('base64'),
		recipientAddress: 'alice@example.com',
		from: 'Bob <bob@example.com>',
		to: ['alice@example.com'],
		cc: [],
		bcc: [],
		subject: 'planning',
		textBody: 'See you there.',
		messageId,
		attachments: [
			{ filename: 'agenda.pdf', contentType: 'application/pdf', size: 21, partIndex: '0' },
			{ filename: 'invite.ics', contentType: 'text/calendar', size: 120, partIndex: '1' },
		],
	});
	await drain(t);
	if (!('messageId' in result)) throw new Error('delivery skipped');
	return result.messageId;
}

async function partsRows(t: ReturnType<typeof convexTest>): Promise<Doc<'mailMessageParts'>[]> {
	return await t.run((ctx) => ctx.db.query('mailMessageParts').collect());
}

async function blobExists(t: ReturnType<typeof convexTest>, id: Id<'_storage'>): Promise<boolean> {
	return await t.run(async (ctx) => (await ctx.storage.get(id)) !== null);
}

describe('stored attachment parts (plan 3.5)', () => {
	it('cuts every attachment leaf and the invite out of a delivered message, sealed', async () => {
		const t = setupTest();
		await seedInbox(t);
		await deliver(t, '<parts-1@example.com>');

		const rows = await partsRows(t);
		expect(rows).toHaveLength(1);
		const row = rows[0]!;
		expect(row.status).toBe('stored');
		expect(row.parts.map((p) => [p.filename, p.contentType])).toEqual([
			['agenda.pdf', 'application/pdf'],
			['invite.ics', 'text/calendar'],
		]);
		expect(row.calendarStorageId).toBeDefined();

		// At rest, a part is ciphertext like the raw message it came from.
		const stored = new Uint8Array(
			await t.run(async (ctx) => {
				const blob = await ctx.storage.get(row.parts[0]!.storageId);
				return await blob!.arrayBuffer();
			})
		);
		expect(isSealedBytesAtRest(stored)).toBe(true);
	});

	it('serves one part through a privately cacheable URL, and the raw message stays no-store', async () => {
		const t = setupTest();
		await seedInbox(t);
		const messageId = await deliver(t, '<parts-2@example.com>');

		const url = await t.action(api.mail.mailbox.parts.getMessagePartUrl, {
			messageId,
			partIndex: '0',
			filename: 'agenda.pdf',
		});
		expect(url).toBeTruthy();
		const res = await t.fetch(SEALED_BLOB_PATH + new URL(url!).search);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/pdf');
		expect(res.headers.get('Cache-Control')).toMatch(/^private, max-age=\d+, immutable$/);
		expect(await res.text()).toBe('%PDF-1.4 agenda bytes');

		const rawUrl = await t.action(api.mail.mailbox.messages.getMessageRawUrl, { messageId });
		const raw = await t.fetch(SEALED_BLOB_PATH + new URL(rawUrl!).search);
		expect(raw.headers.get('Cache-Control')).toBe('no-store');
	});

	it('picks a part the way the client-side extractor does when the index drifted', async () => {
		const t = setupTest();
		await seedInbox(t);
		const messageId = await deliver(t, '<parts-3@example.com>');

		const url = await t.action(api.mail.mailbox.parts.getMessagePartUrl, {
			messageId,
			partIndex: '0',
			filename: 'invite.ics',
		});
		const res = await t.fetch(SEALED_BLOB_PATH + new URL(url!).search);
		expect(await res.text()).toBe(ICS);
		expect(
			await t.action(api.mail.mailbox.parts.getMessagePartUrl, {
				messageId,
				partIndex: '9',
				filename: 'missing.bin',
			})
		).toBeNull();
	});

	it('hands the invite card the iCalendar text, and says unknown for mail without parts', async () => {
		const t = setupTest();
		await seedInbox(t);
		const messageId = await deliver(t, '<parts-4@example.com>');

		expect(await t.action(api.mail.mailbox.parts.getMessageCalendar, { messageId })).toEqual({
			status: 'found',
			ics: ICS,
		});

		// Older mail: no parts row, so the client reads the raw .eml instead.
		await t.run(async (ctx) => {
			for (const row of await ctx.db.query('mailMessageParts').collect()) {
				await ctx.db.delete(row._id);
			}
		});
		expect(await t.action(api.mail.mailbox.parts.getMessageCalendar, { messageId })).toEqual({
			status: 'unknown',
		});
		expect(
			await t.action(api.mail.mailbox.parts.getMessagePartUrl, { messageId, partIndex: '0' })
		).toBeNull();
	});

	it('stores an 8-bit ISO-8859-1 invite as UTF-8 text, so the card reads it intact', async () => {
		const t = setupTest();
		await seedInbox(t);
		const messageId = '<parts-latin1@example.com>';
		// One char per byte, so `deliver` sends ü as the single byte 0xFC.
		const latin1Ics = ICS.replace(
			'SUMMARY:Planning',
			'SUMMARY:Besprechung über Q4\r\nLOCATION:Büro München'
		);
		const raw = [
			'From: Bob <bob@example.com>',
			'To: alice@example.com',
			'Subject: planning',
			`Message-ID: ${messageId}`,
			'Content-Type: multipart/alternative; boundary="alt"',
			'',
			'--alt',
			'Content-Type: text/plain; charset=iso-8859-1',
			'Content-Transfer-Encoding: 8bit',
			'',
			'Bis dann.',
			'--alt',
			'Content-Type: text/calendar; method=REQUEST; charset=iso-8859-1',
			'Content-Transfer-Encoding: 8bit',
			'',
			latin1Ics,
			'--alt--',
			'',
		].join('\r\n');
		const id = await deliver(t, messageId, 0, raw);

		const calendar = await t.action(api.mail.mailbox.parts.getMessageCalendar, { messageId: id });
		// An 8-bit body comes out of the MIME walker with LF line ends.
		expect(calendar).toEqual({ status: 'found', ics: latin1Ics.replace(/\r\n/g, '\n') });
		const ics = (calendar as { ics: string }).ics;
		expect(ics).toContain('SUMMARY:Besprechung über Q4');
		expect(ics).toContain('LOCATION:Büro München');
		expect(ics).not.toContain('\uFFFD');
	});

	it('keeps a declared ISO-8859-1 invite ISO-8859-1 when it starts with a UTF-8 BOM', async () => {
		const t = setupTest();
		await seedInbox(t);
		const messageId = '<parts-latin1-bom@example.com>';
		const ics = ICS.replace('SUMMARY:Planning', 'SUMMARY:Besprechung über Q4');
		const raw = [
			'From: Bob <bob@example.com>',
			'To: alice@example.com',
			'Subject: planning',
			`Message-ID: ${messageId}`,
			'Content-Type: text/calendar; method=REQUEST; charset=iso-8859-1',
			'Content-Transfer-Encoding: 8bit',
			'',
			// EF BB BF, then Latin-1 octets: the BOM must not switch the decoder.
			`\xef\xbb\xbf${ics}`,
			'',
		].join('\r\n');
		const id = await deliver(t, messageId, 0, raw);

		const calendar = await t.action(api.mail.mailbox.parts.getMessageCalendar, { messageId: id });
		const text = (calendar as { ics: string }).ics;
		expect(text).toContain('SUMMARY:Besprechung über Q4');
		expect(text).not.toContain('\uFFFD');
	});

	it('keeps the parts while an IMAP COPY sibling shares the raw blob and frees them with the last row', async () => {
		const t = setupTest();
		await seedInbox(t);
		const messageId = await deliver(t, '<parts-5@example.com>');
		const [row] = await partsRows(t);
		const blobs = [...row!.parts.map((p) => p.storageId), row!.calendarStorageId!];

		const copyId = await t.run(async (ctx) => {
			const original = (await ctx.db.get(messageId))!;
			const { _id, _creationTime, ...fields } = original;
			return await ctx.db.insert('mailMessages', { ...fields, uid: original.uid + 1 });
		});

		await t.run(async (ctx) => deleteMessageRowAndBlobs(ctx, (await ctx.db.get(messageId))!));
		expect(await partsRows(t)).toHaveLength(1);
		for (const id of blobs) expect(await blobExists(t, id)).toBe(true);

		await t.run(async (ctx) => deleteMessageRowAndBlobs(ctx, (await ctx.db.get(copyId))!));
		expect(await partsRows(t)).toHaveLength(0);
		for (const id of blobs) expect(await blobExists(t, id)).toBe(false);
	});

	it('drops the staged parts with the rest when delivery skips a duplicate', async () => {
		const t = setupTest();
		await seedInbox(t);
		await deliver(t, '<parts-6@example.com>');
		const storedBlobs = async () =>
			await t.run(async (ctx) => (await ctx.db.system.query('_storage').collect()).length);
		const before = await storedBlobs();

		// The MTA re-POSTs on a timeout: the second copy is a duplicate.
		await deliver(t, '<parts-6@example.com>').catch(() => undefined);

		expect(await partsRows(t)).toHaveLength(1);
		expect(await storedBlobs()).toBe(before);
	});

	it('stores no parts for a message with more leaves than one extraction keeps', async () => {
		const t = setupTest();
		await seedInbox(t);
		const messageId = await deliver(t, '<parts-7@example.com>', MAX_STORED_PARTS);

		const [row] = await partsRows(t);
		expect(row!.status).toBe('too_many_parts');
		expect(row!.parts).toEqual([]);
		// The invite is still cut out: the card never needed the part list.
		expect(row!.calendarStorageId).toBeDefined();
		expect(
			await t.action(api.mail.mailbox.parts.getMessagePartUrl, { messageId, partIndex: '0' })
		).toBeNull();
	});
});
