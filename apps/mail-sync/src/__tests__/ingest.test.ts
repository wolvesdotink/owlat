import * as mailMessage from '@owlat/mail-message';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ingestMessage, syntheticMessageId, type RawUploadConfig } from '../ingest.js';
import type { ConvexClient } from '../convex.js';

/** Build a mock Convex client that records the args of the single `action` call. */
function mockConvex() {
	const action = vi.fn().mockResolvedValue(undefined);
	return {
		client: { action } as unknown as ConvexClient,
		action,
		lastPayload: () => action.mock.calls[0]?.[1] as Record<string, unknown>,
	};
}

/** Where the raw `.eml` is PUT before the action is told its storage id. */
const UPLOAD: RawUploadConfig = { convexSiteUrl: 'http://convex:3210/http', apiKey: 'msk_test' };

/** Stub the out-of-band raw upload; returns the requests it received. */
function mockUpload(response: Partial<Response> = {}) {
	const calls: { url: string; init: RequestInit }[] = [];
	const fetchMock = vi.fn(async (url: string | URL, init: RequestInit) => {
		calls.push({ url: String(url), init });
		return {
			ok: true,
			status: 200,
			json: async () => ({ storageId: 'kg_raw_1', size: 1234 }),
			text: async () => '',
			...response,
		} as Response;
	});
	vi.stubGlobal('fetch', fetchMock);
	return { calls };
}

const RAW = [
	'From: Alice <alice@example.com>',
	'To: Bob <bob@example.com>, carol@example.com',
	'Cc: dave@example.com',
	'Subject: Hello there',
	'Message-ID: <msg-123@example.com>',
	'Date: Wed, 03 Jun 2026 10:00:00 +0000',
	'Content-Type: text/plain; charset=utf-8',
	'',
	'This is the body text.',
	'',
].join('\r\n');

beforeEach(() => {
	mockUpload();
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('ingestMessage', () => {
	it('rejects oversized raw mail before parsing, uploading, or ingesting', async () => {
		const { calls } = mockUpload();
		const { client, action } = mockConvex();
		await expect(
			ingestMessage(client, UPLOAD, {
				accountId: 'acct_1',
				folderRole: 'inbox',
				remoteName: 'INBOX',
				remoteUid: 42,
				remoteUidValidity: 7,
				raw: Buffer.alloc(8 * 1024 * 1024 + 1),
				flags: new Set(),
				origin: 'backfill',
			})
		).rejects.toThrow('8 MiB raw message limit');
		expect(calls).toHaveLength(0);
		expect(action).not.toHaveBeenCalled();
	});

	it('repairs lone surrogates throughout parsed metadata without changing raw bytes', async () => {
		const malformed = 'before\ud83dafter\udc00😀';
		const repaired = 'before�after�😀';
		const parsed = mailMessage.parseMessage(Buffer.from(RAW));
		const address = { value: [{ address: malformed, name: malformed }], text: malformed };
		vi.spyOn(mailMessage, 'parseMessage').mockReturnValue({
			...parsed,
			from: address,
			to: address,
			cc: address,
			bcc: address,
			replyTo: address,
			subject: malformed,
			text: malformed,
			html: malformed,
			messageId: malformed,
			inReplyTo: malformed,
			references: [malformed],
			attachments: [
				{
					disposition: 'attachment',
					filename: malformed,
					contentType: malformed,
					contentId: malformed,
					size: 0,
					content: Buffer.alloc(0),
				},
			],
		});
		const { client, lastPayload } = mockConvex();
		const { calls } = mockUpload();
		await ingestMessage(client, UPLOAD, {
			accountId: 'acct_1',
			folderRole: 'inbox',
			remoteName: malformed,
			remoteUid: 42,
			remoteUidValidity: 7,
			raw: Buffer.from(RAW),
			flags: new Set(),
			origin: 'backfill',
		});
		expect(lastPayload()).toMatchObject({
			remoteName: repaired,
			from: repaired,
			to: [repaired],
			cc: [repaired],
			bcc: [repaired],
			replyTo: repaired,
			subject: repaired,
			textBodyInline: repaired,
			htmlBodyInline: repaired,
			messageId: repaired,
			inReplyTo: repaired,
			references: repaired,
			attachments: [{ filename: repaired, contentType: repaired, contentId: repaired }],
		});
		expect(Buffer.from(calls[0]!.init.body as Uint8Array).toString()).toBe(RAW);
	});

	it('parses headers + addresses and forwards them to ingestExternalRaw', async () => {
		const { client, action, lastPayload } = mockConvex();

		await ingestMessage(client, UPLOAD, {
			accountId: 'acct_1',
			folderRole: 'inbox',
			remoteName: 'INBOX',
			remoteUid: 42,
			remoteUidValidity: 7,
			raw: Buffer.from(RAW),
			flags: new Set(['\\Seen']),
			origin: 'sync',
		});

		expect(action).toHaveBeenCalledTimes(1);
		const payload = lastPayload();
		expect(payload.accountId).toBe('acct_1');
		expect(payload.folderRole).toBe('inbox');
		expect(payload.remoteUid).toBe(42);
		expect(payload.remoteUidValidity).toBe(7);
		expect(payload.subject).toBe('Hello there');
		expect(payload.from).toBe('alice@example.com');
		expect(payload.to).toEqual(['bob@example.com', 'carol@example.com']);
		expect(payload.cc).toEqual(['dave@example.com']);
		expect(payload.messageId).toBe('<msg-123@example.com>');
		// Forward sync tags the payload, which is what lets the server enqueue the
		// Reply Queue + category classification for this message.
		expect(payload.origin).toBe('sync');
		// Body is well under the 64 KiB inline threshold, so it is sent inline.
		expect(payload.textBodyInline).toContain('This is the body text.');
		// The raw `.eml` goes out of band; the call carries only its storage id,
		// its size, and the 64 KiB header block the action reads headers from.
		expect(payload.rawBytesBase64).toBeUndefined();
		expect(payload.rawStorageId).toBe('kg_raw_1');
		expect(payload.rawSize).toBe(1234);
		expect(Buffer.from(payload.headerBlockBase64 as string, 'base64').toString()).toContain(
			'Hello there'
		);
	});

	it('uploads the raw bytes out of band, authenticated, before referencing them', async () => {
		const { calls } = mockUpload();
		const { client } = mockConvex();

		await ingestMessage(client, UPLOAD, {
			accountId: 'acct_1',
			folderRole: 'inbox',
			remoteName: 'INBOX',
			remoteUid: 42,
			remoteUidValidity: 7,
			raw: Buffer.from(RAW),
			flags: new Set<string>(),
			origin: 'sync',
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe('http://convex:3210/http/mail-sync/raw-message');
		expect(calls[0]!.init.method).toBe('POST');
		expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe(
			'Bearer msk_test'
		);
		// The WHOLE message goes up, not a capped prefix — the size ceiling this
		// replaced is exactly what used to drop large mail.
		expect(Buffer.from(calls[0]!.init.body as Uint8Array).toString()).toBe(RAW);
	});

	it('throws when the raw upload fails, so the walk counts the message as failed', async () => {
		mockUpload({ ok: false, status: 413, text: async () => 'Message too large' });
		const { client, action } = mockConvex();

		await expect(
			ingestMessage(client, UPLOAD, {
				accountId: 'acct_1',
				folderRole: 'inbox',
				remoteName: 'INBOX',
				remoteUid: 42,
				remoteUidValidity: 7,
				raw: Buffer.from(RAW),
				flags: new Set<string>(),
				origin: 'sync',
			})
		).rejects.toThrow(/raw upload failed: HTTP 413/);
		// Never ingested: a row pointing at bytes that were never stored would be
		// worse than the message staying on the server.
		expect(action).not.toHaveBeenCalled();
	});

	it('reflects IMAP flags into flagSeen / flagFlagged', async () => {
		const { client, lastPayload } = mockConvex();
		await ingestMessage(client, UPLOAD, {
			accountId: 'a',
			folderRole: 'inbox',
			remoteName: 'INBOX',
			remoteUid: 1,
			remoteUidValidity: 1,
			raw: Buffer.from(RAW),
			flags: new Set(['\\Flagged']),
			origin: 'sync',
		});
		const payload = lastPayload();
		expect(payload.flagSeen).toBe(false);
		expect(payload.flagFlagged).toBe(true);
	});

	it('synthesises a messageId when the source has none', async () => {
		const { client, lastPayload } = mockConvex();
		const noId = RAW.replace('Message-ID: <msg-123@example.com>\r\n', '');
		await ingestMessage(client, UPLOAD, {
			accountId: 'a',
			folderRole: 'archive',
			remoteName: 'Archive',
			remoteUid: 99,
			remoteUidValidity: 3,
			raw: Buffer.from(noId),
			flags: new Set(),
			origin: 'sync',
		});
		expect(lastPayload().messageId).toMatch(/@owlat-mail-sync>$/);
	});

	it('synthesises a STABLE messageId across re-ingests of the same (uidvalidity, uid), so a re-fetched message dedups', async () => {
		const noId = RAW.replace('Message-ID: <msg-123@example.com>\r\n', '');
		const params = {
			accountId: 'a',
			folderRole: 'archive' as const,
			remoteName: 'Archive',
			remoteUid: 99,
			remoteUidValidity: 3,
			raw: Buffer.from(noId),
			flags: new Set<string>(),
			origin: 'sync' as const,
		};

		// First ingest run.
		const first = mockConvex();
		await ingestMessage(first.client, UPLOAD, params);
		// Second ingest run (simulates a mid-batch crash re-fetching the range,
		// where Date.now() would otherwise have advanced).
		const second = mockConvex();
		await ingestMessage(second.client, UPLOAD, params);

		const id1 = first.lastPayload().messageId;
		const id2 = second.lastPayload().messageId;
		// Deterministic from stable identity — NOT time-based.
		expect(id1).toBe(id2);
		expect(id1).toBe('<3.99.Archive@owlat-mail-sync>');
	});

	it('sanitises the folder name so the synthetic id stays a valid token', () => {
		expect(
			syntheticMessageId({ remoteUidValidity: 1, remoteUid: 2, remoteName: 'Sent Items/2026' })
		).toBe('<1.2.Sent_Items_2026@owlat-mail-sync>');
	});

	// NAMED TEST GATE (c): a non-UTF-8 real-shaped message ingests with the
	// CORRECT decoded body. IMAP delivers whatever the sender wrote; a legacy
	// ISO-8859-1 body must reach Convex decoded to Unicode, not mojibake. The
	// bytes 0xE9/0xFB/0xA3 decode identically under the WHATWG windows-1252 map
	// `@owlat/mail-message` resolves `iso-8859-1` to (I2 b — charset-correct).
	it('decodes a non-UTF-8 (ISO-8859-1) body and subject to Unicode', async () => {
		const { client, lastPayload } = mockConvex();
		const raw = [
			'From: =?ISO-8859-1?Q?Jos=E9?= <jose@example.com>',
			'To: Bob <bob@example.com>',
			'Subject: =?ISO-8859-1?Q?Caf=E9?=',
			'Message-ID: <nonutf8-1@example.com>',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'Content-Type: text/plain; charset=ISO-8859-1',
			'Content-Transfer-Encoding: quoted-printable',
			'',
			"Caf=E9 co=FBte 5=A3 aujourd'hui.",
			'',
		].join('\r\n');

		await ingestMessage(client, UPLOAD, {
			accountId: 'a',
			folderRole: 'inbox',
			remoteName: 'INBOX',
			remoteUid: 5,
			remoteUidValidity: 2,
			raw: Buffer.from(raw, 'latin1'),
			flags: new Set(),
			origin: 'sync',
		});

		const payload = lastPayload();
		expect(payload.subject).toBe('Café');
		expect(payload.from).toBe('jose@example.com');
		// The decoded high-bytes (é/û/£) reach Convex as Unicode, not mojibake.
		expect(payload.textBodyInline).toContain("Café coûte 5£ aujourd'hui.");
	});

	// The attachment metadata mapping is a thin passthrough over
	// `parseMessage`'s attachment leaves: partIndex is the document-order index
	// (`String(i)`), and an unnamed part reports the parse layer's `attachment`
	// default rather than a second ingest-side fallback (see PR body).
	it('maps attachment metadata with document-order partIndex', async () => {
		const { client, lastPayload } = mockConvex();
		const boundary = 'b0undary';
		const raw = [
			'From: Alice <alice@example.com>',
			'To: Bob <bob@example.com>',
			'Subject: With attachment',
			'Message-ID: <att-1@example.com>',
			'MIME-Version: 1.0',
			`Content-Type: multipart/mixed; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Body text.',
			`--${boundary}`,
			'Content-Type: image/png',
			'Content-Disposition: attachment; filename="pic.png"',
			'Content-Transfer-Encoding: base64',
			'',
			'iVBORw0KGgo=',
			`--${boundary}--`,
			'',
		].join('\r\n');

		await ingestMessage(client, UPLOAD, {
			accountId: 'a',
			folderRole: 'inbox',
			remoteName: 'INBOX',
			remoteUid: 6,
			remoteUidValidity: 2,
			raw: Buffer.from(raw),
			flags: new Set(),
			origin: 'sync',
		});

		const attachments = lastPayload().attachments as Array<Record<string, unknown>>;
		expect(attachments).toHaveLength(1);
		expect(attachments[0]?.filename).toBe('pic.png');
		expect(attachments[0]?.contentType).toBe('image/png');
		expect(attachments[0]?.partIndex).toBe('0');
	});

	// I2 pin for the two enumerated attachment-metadata deltas of this cutover, on
	// a single degenerate attachment leaf (Content-Disposition: attachment, no
	// filename parameter, no Content-Type header):
	//   (1) unnamed part -> the parse layer's `attachment` default, NOT the old
	//       ingest-side `attachment-${i+1}` (avoids a duplicated fallback layer);
	//   (2) type-less part -> the MIME `text/plain` default, NOT the old ingest-side
	//       `application/octet-stream`.
	// Both are display-only metadata on a degenerate part, deterministic, and
	// signed off — pinned here so the divergence is never claim-only.
	it('pins the unnamed/type-less attachment deltas (filename=attachment, contentType=text/plain)', async () => {
		const { client, lastPayload } = mockConvex();
		const boundary = 'b0undary';
		const raw = [
			'From: Alice <alice@example.com>',
			'To: Bob <bob@example.com>',
			'Subject: Degenerate attachment',
			'Message-ID: <att-2@example.com>',
			'MIME-Version: 1.0',
			`Content-Type: multipart/mixed; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Body text.',
			`--${boundary}`,
			// No filename parameter, no Content-Type header — only the disposition
			// marks this leaf as an attachment.
			'Content-Disposition: attachment',
			'Content-Transfer-Encoding: base64',
			'',
			'iVBORw0KGgo=',
			`--${boundary}--`,
			'',
		].join('\r\n');

		await ingestMessage(client, UPLOAD, {
			accountId: 'a',
			folderRole: 'inbox',
			remoteName: 'INBOX',
			remoteUid: 7,
			remoteUidValidity: 2,
			raw: Buffer.from(raw),
			flags: new Set(),
			origin: 'sync',
		});

		const attachments = lastPayload().attachments as Array<Record<string, unknown>>;
		expect(attachments).toHaveLength(1);
		// Delta (1): parse-layer default, not `attachment-1`.
		expect(attachments[0]?.filename).toBe('attachment');
		// Delta (2): MIME text/plain default, not application/octet-stream.
		expect(attachments[0]?.contentType).toBe('text/plain');
		expect(attachments[0]?.partIndex).toBe('0');
	});

	// A REPEATED `Reply-To:` is a `singleKey` for mailparser — it keeps only the
	// LAST instance (`mail-parser.js`: `headers.set(key, value[value.length - 1])`),
	// so the old ingest shipped `ben@example.org`. `parseMessage` mirrors that
	// collapse, so `replyTo` is a single object and `addrText` reads its `.text`.
	// This pins that last-wins parity (NOT a merge — mailparser never merges
	// repeated Reply-To) and exercises the shipped `replyTo` field.
	it('keeps the LAST instance of a repeated Reply-To header (mailparser singleKeys parity)', async () => {
		const { client, lastPayload } = mockConvex();
		const raw = [
			'From: Alice <alice@example.com>',
			'To: Bob <bob@example.com>',
			'Reply-To: Amy <amy@example.com>',
			'Reply-To: ben@example.org',
			'Subject: Repeated reply-to',
			'Message-ID: <rt-1@example.com>',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Body text.',
			'',
		].join('\r\n');

		await ingestMessage(client, UPLOAD, {
			accountId: 'a',
			folderRole: 'inbox',
			remoteName: 'INBOX',
			remoteUid: 8,
			remoteUidValidity: 2,
			raw: Buffer.from(raw),
			flags: new Set(),
			origin: 'sync',
		});

		expect(lastPayload().replyTo).toBe('ben@example.org');
	});

	// A REPEATED `From:` is likewise a mailparser `singleKey` — the old ingest
	// read the first address of the LAST `From:` header. `parseMessage` collapses
	// to that last instance, so `from` ships the last header's address.
	it('keeps the LAST instance of a repeated From header (mailparser singleKeys parity)', async () => {
		const { client, lastPayload } = mockConvex();
		const raw = [
			'From: First <first@example.org>',
			'From: Second <second@example.org>',
			'To: Bob <bob@example.com>',
			'Subject: Repeated from',
			'Message-ID: <from-1@example.com>',
			'Date: Wed, 03 Jun 2026 10:00:00 +0000',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Body text.',
			'',
		].join('\r\n');

		await ingestMessage(client, UPLOAD, {
			accountId: 'a',
			folderRole: 'inbox',
			remoteName: 'INBOX',
			remoteUid: 10,
			remoteUidValidity: 2,
			raw: Buffer.from(raw),
			flags: new Set(),
			origin: 'sync',
		});

		expect(lastPayload().from).toBe('second@example.org');
	});

	// A single Reply-To reads the object's `.text` directly (the non-array arm).
	it('exposes a single Reply-To header as its formatted text', async () => {
		const { client, lastPayload } = mockConvex();
		const raw = RAW.replace(
			'Subject: Hello there\r\n',
			'Reply-To: Amy <amy@example.com>\r\nSubject: Hello there\r\n'
		);

		await ingestMessage(client, UPLOAD, {
			accountId: 'a',
			folderRole: 'inbox',
			remoteName: 'INBOX',
			remoteUid: 9,
			remoteUidValidity: 2,
			raw: Buffer.from(raw),
			flags: new Set(),
			origin: 'sync',
		});

		expect(lastPayload().replyTo).toBe('Amy <amy@example.com>');
	});

	// The `origin` flag is the ONLY thing separating a forward-synced message
	// from an imported one on the server: `ingestExternalMessage` enqueues the
	// Reply Queue + category classification for 'sync' inbox mail and nothing
	// else, so a history import can never fan out background LLM work.
	it('ships the origin verbatim, so a backfill ingest is tagged as one', async () => {
		const { client, lastPayload } = mockConvex();
		await ingestMessage(client, UPLOAD, {
			accountId: 'a',
			folderRole: 'inbox',
			remoteName: 'INBOX',
			remoteUid: 11,
			remoteUidValidity: 2,
			raw: Buffer.from(RAW),
			flags: new Set(),
			origin: 'backfill',
		});
		expect(lastPayload().origin).toBe('backfill');
	});
});
