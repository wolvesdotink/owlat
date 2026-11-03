/**
 * Read receipts (RFC 8098) on sent Postbox mail: a receipt that answers a sent
 * message which asked for one is recorded on the Sent copy and kept out of the
 * Inbox; every other receipt is delivered as ordinary mail.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { DatabaseWriter } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { modules } from '../../__tests__/testModulesWithoutNodeActions';
import { foldReturnedReceipt, requestedReadReceipt } from '../readReceipts';

const SENT_ID = 'm1.abc@example.com';

/** A receipt as Thunderbird sends one. */
function receiptEml(opts: { from: string; finalRecipient: string; disposition?: string }): string {
	return [
		`From: ${opts.from}`,
		'To: me@example.com',
		'Subject: Read: Quarterly numbers',
		'Message-ID: <rcpt-1@example.org>',
		'MIME-Version: 1.0',
		'Content-Type: multipart/report; report-type=disposition-notification; boundary="R"',
		'',
		'--R',
		'Content-Type: text/plain; charset=utf-8',
		'',
		'This is a receipt for the mail you sent.',
		'--R',
		'Content-Type: message/disposition-notification',
		'',
		'Reporting-UA: example.org; Thunderbird',
		`Final-Recipient: rfc822;${opts.finalRecipient}`,
		`Original-Message-ID: <${SENT_ID}>`,
		`Disposition: manual-action/MDN-sent-manually; ${opts.disposition ?? 'displayed'}`,
		'',
		'--R--',
		'',
	].join('\r\n');
}

async function insertFolder(
	ctx: { db: DatabaseWriter },
	mailboxId: Id<'mailboxes'>,
	role: 'inbox' | 'sent'
): Promise<Id<'mailFolders'>> {
	const now = Date.now();
	return ctx.db.insert('mailFolders', {
		mailboxId,
		name: role === 'inbox' ? 'INBOX' : 'Sent',
		role,
		uidValidity: now,
		uidNext: 2,
		highestModseq: 1,
		totalCount: 0,
		unseenCount: 0,
		subscribed: true,
		createdAt: now,
		updatedAt: now,
	});
}

async function setup(opts: { isRequested: boolean }) {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	const ids = await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
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
		const inboxId = await insertFolder(ctx, mailboxId, 'inbox');
		const sentFolderId = await insertFolder(ctx, mailboxId, 'sent');
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'quarterly numbers',
			participants: ['me@example.com', 'ben@example.org'],
			messageCount: 1,
			unreadCount: 0,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'Hi Ben',
			latestFromAddress: 'me@example.com',
			latestSubject: 'Quarterly numbers',
			folderRoles: ['sent'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		const sentId = await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId: sentFolderId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: SENT_ID,
			threadId,
			fromAddress: 'me@example.com',
			toAddresses: ['ben@example.org'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Quarterly numbers',
			normalizedSubject: 'quarterly numbers',
			snippet: 'Hi Ben',
			rawStorageId: await ctx.storage.store(new Blob(['raw'])),
			rawSize: 3,
			attachments: [],
			hasAttachments: false,
			flagSeen: true,
			flagFlagged: false,
			flagAnswered: false,
			flagDraft: false,
			flagDeleted: false,
			customFlags: [],
			labelIds: [],
			receivedAt: now,
			internalDate: now,
			outbound: { state: 'sent', recipients: [] },
			...requestedReadReceipt({ isReadReceiptRequested: opts.isRequested }, now),
			createdAt: now,
			updatedAt: now,
		});
		return { inboxId, sentId };
	});
	return { t, ...ids };
}

function ingest(t: ReturnType<typeof convexTest>, from: string, raw: string) {
	return t.action(internal.mail.delivery.ingestFromWebhook, {
		deliveryId: 'd1',
		rawBytesBase64: Buffer.from(raw).toString('base64'),
		recipientAddress: 'me@example.com',
		from,
		to: ['me@example.com'],
		cc: [],
		bcc: [],
		subject: 'Read: Quarterly numbers',
		textBody: 'This is a receipt for the mail you sent.',
		messageId: '<rcpt-1@example.org>',
		date: Date.UTC(2026, 10, 3, 9, 12),
		attachments: [],
	});
}

async function inboxCount(t: ReturnType<typeof convexTest>, inboxId: Id<'mailFolders'>) {
	return t.run(
		async (ctx) =>
			(
				await ctx.db
					.query('mailMessages')
					.filter((q) => q.eq(q.field('folderId'), inboxId))
					.collect()
			).length
	);
}

describe('ingestFromWebhook — returned read receipts', () => {
	// After the receipt's own Date, which is never recorded as later than now.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.UTC(2026, 10, 3, 10, 0));
	});
	afterEach(() => vi.useRealTimers());

	it('records a recipient’s receipt on the Sent copy and keeps it out of the Inbox', async () => {
		const { t, inboxId, sentId } = await setup({ isRequested: true });

		const result = await ingest(
			t,
			'Ben <ben@example.org>',
			receiptEml({ from: 'Ben <ben@example.org>', finalRecipient: 'Ben@Example.org' })
		);

		expect(result).toEqual({ skipped: true });
		expect(await inboxCount(t, inboxId)).toBe(0);
		const sent = await t.run((ctx) => ctx.db.get(sentId));
		expect(sent?.readReceipt?.returned).toEqual([
			{
				address: 'ben@example.org',
				disposition: 'displayed',
				isAutomatic: false,
				at: Date.UTC(2026, 10, 3, 9, 12),
			},
		]);
	});

	it('delivers a receipt for a message that asked for none', async () => {
		const { t, inboxId, sentId } = await setup({ isRequested: false });

		await ingest(
			t,
			'ben@example.org',
			receiptEml({ from: 'ben@example.org', finalRecipient: 'ben@example.org' })
		);

		expect(await inboxCount(t, inboxId)).toBe(1);
		expect((await t.run((ctx) => ctx.db.get(sentId)))?.readReceipt).toBeUndefined();
	});

	it('delivers a receipt from someone the message was not sent to', async () => {
		const { t, inboxId, sentId } = await setup({ isRequested: true });

		await ingest(
			t,
			'mallory@example.net',
			receiptEml({ from: 'mallory@example.net', finalRecipient: 'mallory@example.net' })
		);

		expect(await inboxCount(t, inboxId)).toBe(1);
		expect((await t.run((ctx) => ctx.db.get(sentId)))?.readReceipt?.returned).toEqual([]);
	});
});

describe('foldReturnedReceipt', () => {
	const message: Pick<
		Doc<'mailMessages'>,
		'readReceipt' | 'toAddresses' | 'ccAddresses' | 'bccAddresses'
	> = {
		readReceipt: { requestedAt: 1, returned: [] },
		toAddresses: ['Ben <ben@example.org>'],
		ccAddresses: ['cy@example.org'],
		bccAddresses: [],
	};
	const displayed = {
		originalMessageId: SENT_ID,
		finalRecipient: 'ben@example.org',
		disposition: 'displayed' as const,
		isAutomatic: false,
	};

	it('keeps one entry per recipient, the last to arrive', () => {
		const first = foldReturnedReceipt(message, displayed, 'ben@example.org', 10)!;
		const second = foldReturnedReceipt(
			{ ...message, readReceipt: first },
			{ ...displayed, disposition: 'deleted', isAutomatic: true },
			'ben@example.org',
			20
		);
		expect(second?.returned).toEqual([
			{ address: 'ben@example.org', disposition: 'deleted', isAutomatic: true, at: 20 },
		]);
	});

	it('falls back to the sender address when Final-Recipient names no recipient', () => {
		const folded = foldReturnedReceipt(
			message,
			{ ...displayed, finalRecipient: 'cy@relay.example' },
			'cy@example.org',
			10
		);
		expect(folded?.returned.map((r) => r.address)).toEqual(['cy@example.org']);
	});

	it('ignores dispositions that say nothing about reading', () => {
		expect(
			foldReturnedReceipt(message, { ...displayed, disposition: 'processed' }, 'ben@example.org', 1)
		).toBeNull();
	});
});
