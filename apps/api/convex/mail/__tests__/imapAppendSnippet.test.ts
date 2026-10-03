/**
 * IMAP APPEND derives the snippet from the bodies it stores, with the same
 * `buildSnippet` the delivery pipeline uses. The IMAP server used to send its
 * own snippet, built from raw MIME, so an APPENDed multipart message showed
 * boundary lines as its preview. Only IMAP servers from v0.6.3 and older sent
 * one, and the backend no longer serves them (wire version 0), so the argument
 * is gone.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { modules, seedMailbox, seedFolder } from './helpers.testlib';

const ME = 'me@owlat.test';

async function setup(): Promise<{
	t: TestConvex<typeof schema>;
	sentId: Id<'mailFolders'>;
	rawStorageId: Id<'_storage'>;
}> {
	const t = convexTest(schema, modules);
	const mailboxId = await seedMailbox(t, { address: ME, domain: 'owlat.test' });
	const sentId = await seedFolder(t, mailboxId, 'sent');
	const rawStorageId = await t.run((ctx) => ctx.storage.store(new Blob(['raw'])));
	return { t, sentId, rawStorageId };
}

async function appendAndRead(
	bodies: { textBodyInline?: string; htmlBodyInline?: string },
	messageId: string
): Promise<{ snippet: string; latestSnippet: string | undefined }> {
	const { t, sentId, rawStorageId } = await setup();
	const result = await t.mutation(internal.mail.imap.append.appendMessage, {
		folderId: sentId,
		rawStorageId,
		rawSize: 3,
		rfc822MessageId: messageId,
		fromAddress: ME,
		toAddresses: ['alice@example.com'],
		ccAddresses: [],
		bccAddresses: [],
		subject: 'Plan',
		...bodies,
	});
	return t.run(async (ctx) => {
		const message = (await ctx.db.get(result.messageId))!;
		const thread = (await ctx.db.get(message.threadId))!;
		return { snippet: message.snippet, latestSnippet: thread.latestSnippet };
	});
}

describe('mail/imap/append:appendMessage snippet', () => {
	it('builds the snippet from the text body', async () => {
		const row = await appendAndRead(
			{
				textBodyInline: '  See you at the meeting.  ',
				htmlBodyInline: '<p>ignored while text exists</p>',
			},
			'text@owlat.test'
		);
		expect(row.snippet).toBe('See you at the meeting.');
		expect(row.latestSnippet).toBe('See you at the meeting.');
	});

	it('falls back to the HTML body with tags and styles stripped', async () => {
		const row = await appendAndRead(
			{ htmlBodyInline: '<style>p{color:red}</style><p>Hello <b>world</b></p>' },
			'html@owlat.test'
		);
		expect(row.snippet).toBe('Hello world');
		expect(row.latestSnippet).toBe('Hello world');
	});

	it('stores an empty snippet when the message has no body', async () => {
		const row = await appendAndRead({}, 'empty@owlat.test');
		expect(row.snippet).toBe('');
	});

	it('no longer accepts a client snippet', async () => {
		const { t, sentId, rawStorageId } = await setup();
		await expect(
			t.mutation(internal.mail.imap.append.appendMessage, {
				folderId: sentId,
				rawStorageId,
				rawSize: 3,
				rfc822MessageId: 'client-snippet@owlat.test',
				fromAddress: ME,
				toAddresses: ['alice@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'Plan',
				snippet: '--boundary-123 Content-Type: text/plain',
			} as never)
		).rejects.toThrow(/snippet/);
	});
});
