import { describe, it, expect, vi } from 'vitest';
import { ingestMessage, syntheticMessageId } from '../ingest.js';
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

describe('ingestMessage', () => {
	it('parses headers + addresses and forwards them to ingestExternalRaw', async () => {
		const { client, action, lastPayload } = mockConvex();

		await ingestMessage(client, {
			accountId: 'acct_1',
			folderRole: 'inbox',
			remoteName: 'INBOX',
			remoteUid: 42,
			remoteUidValidity: 7,
			raw: Buffer.from(RAW),
			flags: new Set(['\\Seen']),
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
		// Body is well under the 64 KiB inline threshold, so it is sent inline.
		expect(payload.textBodyInline).toContain('This is the body text.');
		// Raw bytes are shipped base64-encoded.
		expect(typeof payload.rawBytesBase64).toBe('string');
		expect(Buffer.from(payload.rawBytesBase64 as string, 'base64').toString()).toContain(
			'Hello there'
		);
	});

	it('reflects IMAP flags into flagSeen / flagFlagged', async () => {
		const { client, lastPayload } = mockConvex();
		await ingestMessage(client, {
			accountId: 'a',
			folderRole: 'inbox',
			remoteName: 'INBOX',
			remoteUid: 1,
			remoteUidValidity: 1,
			raw: Buffer.from(RAW),
			flags: new Set(['\\Flagged']),
		});
		const payload = lastPayload();
		expect(payload.flagSeen).toBe(false);
		expect(payload.flagFlagged).toBe(true);
	});

	it('synthesises a messageId when the source has none', async () => {
		const { client, lastPayload } = mockConvex();
		const noId = RAW.replace('Message-ID: <msg-123@example.com>\r\n', '');
		await ingestMessage(client, {
			accountId: 'a',
			folderRole: 'archive',
			remoteName: 'Archive',
			remoteUid: 99,
			remoteUidValidity: 3,
			raw: Buffer.from(noId),
			flags: new Set(),
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
		};

		// First ingest run.
		const first = mockConvex();
		await ingestMessage(first.client, params);
		// Second ingest run (simulates a mid-batch crash re-fetching the range,
		// where Date.now() would otherwise have advanced).
		const second = mockConvex();
		await ingestMessage(second.client, params);

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
});
