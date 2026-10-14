/**
 * #1346 through the IMAP-sync ingest mutation (`ingestExternalMessage`) and a
 * client's IMAP APPEND: our own reply hides the conversation's untouched AI
 * draft, but neither a vacation auto-reply (Auto-Submitted) nor an unsent
 * `\Draft` kept in a custom folder counts as a reply. The `\Draft` flag the
 * worker forwards is stored on the row.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { aiTextToHtml } from '@owlat/shared/answerMode';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { modules } from './helpers.testlib';

const OWNER = 'me@gmail.example';
const SENDER = 'sam@acme.test';
const T0 = 1_700_000_000_000;
const AI_TEXT = 'Hi Sam,\n\nFriday works.';

type T = TestConvex<typeof schema>;

interface Seeded {
	accountId: Id<'externalMailAccounts'>;
	mailboxId: Id<'mailboxes'>;
}

/** An external mailbox with Inbox, Sent and a custom "Notes" user folder. */
async function seedAccount(t: T): Promise<Seeded> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user-A',
			organizationId: 'org-1',
			address: OWNER,
			domain: 'gmail.example',
			kind: 'external',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const folder = async (name: string, role?: 'inbox' | 'sent') =>
			await ctx.db.insert('mailFolders', {
				mailboxId,
				name,
				...(role ? { role } : {}),
				uidValidity: now,
				uidNext: 1,
				highestModseq: 1,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
		await folder('INBOX', 'inbox');
		await folder('Sent', 'sent');
		const notesId = await folder('Notes');
		const accountId = await ctx.db.insert('externalMailAccounts', {
			userId: 'user-A',
			organizationId: 'org-1',
			mailboxId,
			imapHost: 'imap.gmail.example',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.gmail.example',
			smtpPort: 465,
			isSmtpSecure: true,
			authMethod: 'password' as const,
			imapUsername: OWNER,
			secretCiphertext: 'x',
			secretIv: 'x',
			secretAuthTag: 'x',
			secretEnvelopeVersion: 1,
			status: 'connected' as const,
			createdAt: now,
			updatedAt: now,
		});
		await ctx.db.patch(mailboxId, { externalAccountId: accountId });
		await ctx.db.insert('externalMailFolderSync', {
			accountId,
			mailboxId,
			folderId: notesId,
			remoteName: 'Notes',
			remoteUidValidity: 7,
			lastSeenUid: 0,
			lastSyncedAt: now,
		});
		return { accountId, mailboxId };
	});
}

/** One message through the mutation the worker's ingest action delegates to. */
async function ingest(
	t: T,
	s: Seeded,
	opts: {
		uid: number;
		from: string;
		to: string;
		at: number;
		folder: 'inbox' | 'sent' | 'Notes';
		inReplyTo?: string;
		flagDraft?: boolean;
		antiLoopHeaders?: Record<string, string>;
	}
): Promise<void> {
	const rawStorageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(['raw'])));
	await t.mutation(internal.mail.external.delivery.ingestExternalMessage, {
		accountId: s.accountId,
		...(opts.folder === 'Notes' ? {} : { folderRole: opts.folder }),
		remoteName: opts.folder === 'inbox' ? 'INBOX' : opts.folder === 'sent' ? 'Sent' : 'Notes',
		remoteUid: opts.uid,
		remoteUidValidity: 7,
		rawStorageId,
		rawSize: 3,
		from: opts.from,
		to: [opts.to],
		cc: [],
		bcc: [],
		subject: opts.inReplyTo ? 'Re: Friday plans?' : 'Friday plans?',
		textBodyInline: 'Friday?',
		messageId: `<m${opts.uid}@acme.test>`,
		...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
		receivedAt: opts.at,
		attachments: [],
		origin: 'sync',
		...(opts.flagDraft ? { flagDraft: true } : {}),
		...(opts.antiLoopHeaders ? { antiLoopHeaders: opts.antiLoopHeaders } : {}),
	});
}

/** The asking message synced in, plus an untouched AI reply draft saved for it. */
async function askWithAiDraft(t: T, s: Seeded) {
	await ingest(t, s, { uid: 1, from: `Sam <${SENDER}>`, to: OWNER, at: T0, folder: 'inbox' });
	return await t.run(async (ctx) => {
		const ask = (await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', s.mailboxId))
			.first())!;
		const draftId = await ctx.db.insert('mailDrafts', {
			mailboxId: s.mailboxId,
			threadId: ask.threadId,
			inReplyToMessageId: ask._id,
			toAddresses: [SENDER],
			ccAddresses: [],
			bccAddresses: [],
			fromAddress: OWNER,
			subject: 'Re: Friday plans?',
			bodyHtml: aiTextToHtml(AI_TEXT),
			aiAuthored: { text: AI_TEXT, at: T0 + 1_000 },
			attachments: [],
			state: 'draft',
			lastEditedAt: T0 + 1_000,
			createdAt: T0 + 1_000,
		});
		return { draftId, threadId: ask.threadId };
	});
}

/** Still shown: not deleted, not obsoleted by a reply. */
async function draftExists(t: T, draftId: Id<'mailDrafts'>): Promise<boolean> {
	return await t.run(async (ctx) => {
		const draft = await ctx.db.get(draftId);
		return draft !== null && draft.obsoleted === undefined;
	});
}

/** A desktop client files our reply in Sent through IMAP APPEND. */
async function appendReply(t: T, s: Seeded, headerBlock: string): Promise<void> {
	const { folderId, rawStorageId } = await t.run(async (ctx) => ({
		folderId: (await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', s.mailboxId).eq('role', 'sent'))
			.first())!._id,
		rawStorageId: await ctx.storage.store(new Blob(['raw'])),
	}));
	await t.mutation(internal.mail.imap.append.appendMessage, {
		folderId,
		rawStorageId,
		rawSize: 3,
		rfc822MessageId: 'reply-1@gmail.example',
		inReplyTo: '<m1@acme.test>',
		references: ['<m1@acme.test>'],
		fromAddress: OWNER,
		toAddresses: [SENDER],
		ccAddresses: [],
		bccAddresses: [],
		subject: 'Re: Friday plans?',
		textBodyInline: 'Friday works.',
		internalDate: T0 + 10_000,
		flags: ['\\Seen'],
		headerBlock,
	});
}

describe('our reply synced through ingest', () => {
	it('removes the untouched AI draft for the answered mail', async () => {
		const t = convexTest(schema, modules);
		const s = await seedAccount(t);
		const { draftId } = await askWithAiDraft(t, s);

		await ingest(t, s, {
			uid: 2,
			from: OWNER,
			to: SENDER,
			at: T0 + 10_000,
			folder: 'sent',
			inReplyTo: '<m1@acme.test>',
		});

		expect(await draftExists(t, draftId)).toBe(false);
	});

	it('keeps it for a vacation auto-reply (Auto-Submitted: auto-replied)', async () => {
		const t = convexTest(schema, modules);
		const s = await seedAccount(t);
		const { draftId } = await askWithAiDraft(t, s);

		await ingest(t, s, {
			uid: 2,
			from: OWNER,
			to: SENDER,
			at: T0 + 10_000,
			folder: 'sent',
			inReplyTo: '<m1@acme.test>',
			antiLoopHeaders: { 'auto-submitted': 'auto-replied' },
		});

		expect(await draftExists(t, draftId)).toBe(true);
	});

	it('keeps it for an unsent \\Draft kept in a custom folder, and stores the flag', async () => {
		const t = convexTest(schema, modules);
		const s = await seedAccount(t);
		const { draftId, threadId } = await askWithAiDraft(t, s);

		await ingest(t, s, {
			uid: 2,
			from: OWNER,
			to: SENDER,
			at: T0 + 10_000,
			folder: 'Notes',
			inReplyTo: '<m1@acme.test>',
			flagDraft: true,
		});

		expect(await draftExists(t, draftId)).toBe(true);
		const stored = await t.run(async (ctx) =>
			(
				await ctx.db
					.query('mailMessages')
					.withIndex('by_thread', (q) => q.eq('threadId', threadId))
					.collect()
			).find((m) => m.fromAddress === OWNER)
		);
		expect(stored?.flagDraft).toBe(true);
	});
});

describe('our reply filed through IMAP APPEND', () => {
	it('hides the untouched AI draft for the answered mail', async () => {
		const t = convexTest(schema, modules);
		const s = await seedAccount(t);
		const { draftId } = await askWithAiDraft(t, s);

		await appendReply(t, s, 'From: me@gmail.example\r\nSubject: Re: Friday plans?');

		expect(await draftExists(t, draftId)).toBe(false);
	});

	it('keeps it for a vacation auto-reply (Auto-Submitted: auto-replied)', async () => {
		const t = convexTest(schema, modules);
		const s = await seedAccount(t);
		const { draftId } = await askWithAiDraft(t, s);

		await appendReply(
			t,
			s,
			'From: me@gmail.example\r\nAuto-Submitted: auto-replied\r\nSubject: Re: Friday plans?'
		);

		expect(await draftExists(t, draftId)).toBe(true);
	});
});
