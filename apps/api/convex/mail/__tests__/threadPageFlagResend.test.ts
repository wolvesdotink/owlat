/**
 * What a flag change re-sends to an open reader. Convex re-runs a query when a
 * document it read changes and sends the new result whole, so whatever shares
 * a result with a message's flags crosses the socket again on every mark-read,
 * star or label change. The reader's thread page and the body queries it holds
 * are read before and after one mark-read, and the JSON of every result that
 * changed is counted.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { api } from '../../_generated/api';
import { modules, seedMailbox, seedFolder } from './helpers.testlib';
import { enableFeatures } from '../../__tests__/factories';
import { insertMessageBody } from '../../lib/messageBodyStore';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

type T = TestConvex<typeof schema>;

const MESSAGES = 10;
/** A plain newsletter-sized body: a few KB of HTML plus its text part. */
const BODY_HTML = `<p>${'Lorem ipsum dolor sit amet. '.repeat(150)}</p>`;
const BODY_TEXT = 'Lorem ipsum dolor sit amet. '.repeat(100);

async function seedThread(t: T): Promise<Id<'mailMessages'>[]> {
	await enableFeatures(t, ['mail.external']);
	const mailboxId = await seedMailbox(t, { userId: 'user-A', address: 'me@owlat.test' });
	const folderId = await seedFolder(t, mailboxId, 'inbox');
	return await t.run(async (ctx) => {
		const base = Date.now() - MESSAGES * 1000;
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'thread',
			participants: ['sender@example.com'],
			messageCount: MESSAGES,
			unreadCount: MESSAGES,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: base + (MESSAGES - 1) * 1000,
			firstMessageAt: base,
			latestSnippet: 'thread',
			latestFromAddress: 'sender@example.com',
			latestSubject: 'thread',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: base,
			updatedAt: base,
		});
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		const ids: Id<'mailMessages'>[] = [];
		for (let i = 0; i < MESSAGES; i++) {
			const receivedAt = base + i * 1000;
			const id = await ctx.db.insert('mailMessages', {
				mailboxId,
				folderId,
				uid: i + 1,
				modseq: i + 1,
				rfc822MessageId: `<thread-${i}@example.com>`,
				threadId,
				fromAddress: 'sender@example.com',
				toAddresses: ['me@owlat.test'],
				ccAddresses: [],
				bccAddresses: [],
				subject: `thread ${i}`,
				normalizedSubject: 'thread',
				snippet: `thread ${i}`,
				rawStorageId,
				rawSize: 3,
				attachments: [],
				hasAttachments: false,
				flagSeen: false,
				flagFlagged: false,
				flagAnswered: false,
				flagDraft: false,
				flagDeleted: false,
				customFlags: [],
				labelIds: [],
				receivedAt,
				internalDate: receivedAt,
				createdAt: receivedAt,
				updatedAt: receivedAt,
			});
			await insertMessageBody(ctx.db, id, { html: BODY_HTML, text: BODY_TEXT });
			ids.push(id);
		}
		await ctx.db.patch(folderId, { totalCount: MESSAGES, unseenCount: MESSAGES });
		return ids;
	});
}

type Subscription = { name: string; run: () => Promise<unknown> };

/** JSON bytes of the subscriptions whose result changed across `change`. */
async function resentBytes(subscriptions: Subscription[], change: () => Promise<unknown>) {
	const before = await Promise.all(subscriptions.map(async (s) => JSON.stringify(await s.run())));
	await change();
	const after = await Promise.all(subscriptions.map(async (s) => JSON.stringify(await s.run())));
	const changed = subscriptions.filter((_, i) => before[i] !== after[i]).map((s) => s.name);
	const resent = after.filter((json, i) => json !== before[i]).join('');
	return { changed, bytes: resent.length, resent };
}

describe('a mark-read in an open 10-message thread', () => {
	it('re-sends every inline body of the thread page', async () => {
		const t = convexTest(schema, modules);
		const ids = await seedThread(t);
		const opened = ids[MESSAGES - 1]!;

		// What the reader holds once the thread has answered: the page, whose
		// row for the opened message carries its body, so no body query.
		const result = await resentBytes(
			[
				{
					name: 'listThreadMessages',
					run: () =>
						t.query(api.mail.mailbox.messages.listThreadMessages, {
							messageId: opened,
							pageSize: 50,
							withBodies: 10,
						}),
				},
			],
			() => t.mutation(api.mail.messageActions.setFlags, { messageIds: [opened], seen: true })
		);

		expect(result.changed).toEqual(['listThreadMessages']);
		expect(result.bytes).toBeGreaterThan(MESSAGES * BODY_HTML.length);
	});

	it('with omitBodies re-sends the page without a single body', async () => {
		const t = convexTest(schema, modules);
		const ids = await seedThread(t);
		const opened = ids[MESSAGES - 1]!;

		// The page without bodies, and the body query of the one message the
		// reader expands (the newest, which is the opened one).
		const result = await resentBytes(
			[
				{
					name: 'listThreadMessages',
					run: () =>
						t.query(api.mail.mailbox.messages.listThreadMessages, {
							messageId: opened,
							pageSize: 50,
							withBodies: 10,
							omitBodies: true,
						}),
				},
				{
					name: 'getMessageInlineBody',
					run: () => t.query(api.mail.mailbox.messages.getMessageInlineBody, { messageId: opened }),
				},
			],
			() => t.mutation(api.mail.messageActions.setFlags, { messageIds: [opened], seen: true })
		);

		expect(result.changed).toEqual(['listThreadMessages']);
		expect(result.resent).not.toContain('Lorem ipsum');
		// 10 body-less rows, the thread and the labels: a tenth of the page with bodies.
		expect(result.bytes).toBeLessThan(MESSAGES * 1000);
	});

	it('with omitBodies the rows keep their non-body fields and the body query has the body', async () => {
		const t = convexTest(schema, modules);
		const ids = await seedThread(t);
		const opened = ids[MESSAGES - 1]!;

		const page = (await t.query(api.mail.mailbox.messages.listThreadMessages, {
			messageId: opened,
			pageSize: 50,
			withBodies: 10,
			omitBodies: true,
		}))!;
		expect(page.messages.map((m) => m._id)).toEqual(ids);
		for (const row of page.messages) {
			expect(row).not.toHaveProperty('textBodyInline');
			expect(row).not.toHaveProperty('htmlBodyInline');
			expect(row.rfc822MessageId).toMatch(/^<thread-/);
		}
		expect(
			await t.query(api.mail.mailbox.messages.getMessageInlineBody, { messageId: opened })
		).toEqual({
			htmlInline: BODY_HTML,
			textInline: BODY_TEXT,
			hasHtmlBlob: false,
			hasTextBlob: false,
		});
	});
});
