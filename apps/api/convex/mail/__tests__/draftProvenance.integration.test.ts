/**
 * Draft provenance through the real draft mutations
 * (mail/draftProvenance.ts): only a draft the AI wrote and no person touched is
 * cleaned up once the conversation is answered. Every change a person makes
 * counts, even one that leaves the text alone (a link, a recipient, the
 * subject, an attachment); saves that change nothing and AI writes, a second
 * generation included, do not.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import { aiTextToHtml } from '@owlat/shared/answerMode';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';
import { settleOwnerReply } from '../answeredReply';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		getMutationContext: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

const OWNER = 'me@owlat.test';
const SENDER = 'sam@acme.test';
const AI_TEXT = "Hi Sam,\n\nHere's the report.";
const AI_TEXT_2 = 'Hi Sam,\n\nThe report is attached, with the March numbers.';
const QUOTE = '<br><br><div class="gmail_quote">On Monday Sam wrote: send the report?</div>';

type T = TestConvex<typeof schema>;

interface Reply {
	mailboxId: Id<'mailboxes'>;
	askId: Id<'mailMessages'>;
	draftId: Id<'mailDrafts'>;
	fields: { toAddresses: string[]; subject: string };
}

/** A reply draft opened on Sam's mail, as the composer creates it. */
async function openReply(t: T): Promise<Reply> {
	const mailboxId = await seedMailbox(t, { address: OWNER });
	await seedFolder(t, mailboxId, 'inbox');
	await seedFolder(t, mailboxId, 'sent');
	const askId = await seedMessage(t, mailboxId, {
		subject: 'Can you send the report?',
		fromAddress: SENDER,
		receivedAt: Date.now() - 60_000,
	});
	const created = await t.mutation(api.mail.drafts.create, {
		mailboxId,
		inReplyToMessageId: askId,
	});
	return {
		mailboxId,
		askId,
		draftId: created.draftId,
		fields: { toAddresses: created.toAddresses, subject: created.subject },
	};
}

/** One autosave of the composer's snapshot (`aiText` when it tags an AI write). */
async function save(
	t: T,
	r: Reply,
	body: string,
	extra: { aiText?: string; bodyText?: string; toAddresses?: string[]; subject?: string } = {}
): Promise<void> {
	await t.mutation(api.mail.drafts.update, {
		draftId: r.draftId,
		toAddresses: extra.toAddresses ?? r.fields.toAddresses,
		ccAddresses: [],
		bccAddresses: [],
		subject: extra.subject ?? r.fields.subject,
		bodyHtml: body,
		composerMode: 'simple',
		followUpRemindAt: null,
		...(extra.aiText !== undefined ? { aiText: extra.aiText } : {}),
		...(extra.bodyText !== undefined ? { bodyText: extra.bodyText } : {}),
	});
}

const aiBody = (text: string) => `${aiTextToHtml(text)}${QUOTE}`;

/** Our own reply syncs in; returns whether the draft was obsoleted by it. */
async function answerAndCheck(t: T, r: Reply): Promise<boolean> {
	return await t.run(async (ctx) => {
		const ask = (await ctx.db.get(r.askId))!;
		const sent = (await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', r.mailboxId).eq('role', 'sent'))
			.first())!;
		const { _id, _creationTime, ...base } = ask;
		const at = Date.now() + 60_000;
		const replyId = await ctx.db.insert('mailMessages', {
			...base,
			folderId: sent._id,
			uid: 2,
			rfc822MessageId: '<reply@owlat.test>',
			fromAddress: OWNER,
			toAddresses: [SENDER],
			receivedAt: at,
			internalDate: at,
		});
		await settleOwnerReply(ctx, replyId);
		return (await ctx.db.get(r.draftId))?.obsoleted !== undefined;
	});
}

async function draftRow(t: T, r: Reply) {
	return await t.run(async (ctx) => (await ctx.db.get(r.draftId))!);
}

describe('an AI draft no person touched', () => {
	it('stays the AI’s through the seeded save, the AI write and repeated snapshots', async () => {
		const t = convexTest(schema, modules);
		const r = await openReply(t);

		await save(t, r, QUOTE); // the composer seeds the quote before anyone types
		await save(t, r, aiBody(AI_TEXT), { aiText: AI_TEXT });
		await save(t, r, aiBody(AI_TEXT), { aiText: AI_TEXT }); // the same snapshot again
		await t.mutation(api.mail.drafts.update, { draftId: r.draftId, aiBaseline: AI_TEXT });

		const row = await draftRow(t, r);
		expect(row.aiAuthored?.text).toBe(AI_TEXT);
		expect(row.humanTouchedAt).toBeUndefined();
		expect(await answerAndCheck(t, r)).toBe(true);
	});

	it('includes a plain-text body that is the same AI text', async () => {
		const t = convexTest(schema, modules);
		const r = await openReply(t);

		await save(t, r, aiBody(AI_TEXT), { aiText: AI_TEXT, bodyText: `${AI_TEXT}\n` });

		expect((await draftRow(t, r)).humanTouchedAt).toBeUndefined();
		expect(await answerAndCheck(t, r)).toBe(true);
	});

	it('includes a second generation that replaced the first', async () => {
		const t = convexTest(schema, modules);
		const r = await openReply(t);

		await save(t, r, aiBody(AI_TEXT), { aiText: AI_TEXT });
		await t.mutation(api.mail.drafts.update, { draftId: r.draftId, aiBaseline: AI_TEXT });
		await save(t, r, aiBody(AI_TEXT_2), { aiText: AI_TEXT_2 });

		const row = await draftRow(t, r);
		expect(row.aiDraftBaseline?.text).toBe(AI_TEXT); // edit learning keeps the first
		expect(row.aiAuthored?.text).toBe(AI_TEXT_2);
		expect(row.humanTouchedAt).toBeUndefined();
		expect(await answerAndCheck(t, r)).toBe(true);
	});
});

describe('a person’s change makes the draft theirs', () => {
	const edits: Array<[string, (t: T, r: Reply) => Promise<unknown>]> = [
		['a word in the body', (t, r) => save(t, r, aiBody(`${AI_TEXT} Thanks!`))],
		[
			'a plain-text body of its own beside the unchanged AI HTML',
			(t, r) =>
				save(t, r, aiBody(AI_TEXT), { aiText: AI_TEXT, bodyText: 'My own words, not the AI’s.' }),
		],
		[
			'the plain-text body (a quick reply)',
			(t, r) =>
				t.mutation(api.mail.drafts.update, { draftId: r.draftId, bodyText: 'Numbers attached.' }),
		],
		[
			'a link, with the text unchanged (even tagged as AI)',
			(t, r) =>
				save(
					t,
					r,
					aiBody(AI_TEXT).replace('the report', '<a href="https://owlat.test/r">the report</a>'),
					{ aiText: AI_TEXT }
				),
		],
		[
			'a recipient',
			(t, r) =>
				save(t, r, aiBody(AI_TEXT), {
					aiText: AI_TEXT,
					toAddresses: [...r.fields.toAddresses, 'kim@acme.test'],
				}),
		],
		['the subject', (t, r) => save(t, r, aiBody(AI_TEXT), { aiText: AI_TEXT, subject: 'Report' })],
		[
			'an attachment',
			async (t, r) => {
				const storageId = await t.run(async (ctx) => {
					const id = await ctx.storage.store(new Blob(['numbers']));
					await ctx.db.insert('storageUploads', {
						userId: 'user-A',
						organizationId: 'org-1',
						status: 'uploaded',
						storageId: id,
						expiresAt: Date.now() + 60_000,
					});
					return id;
				});
				await t.mutation(api.mail.drafts.addAttachment, {
					draftId: r.draftId,
					storageId,
					filename: 'numbers.csv',
					contentType: 'text/csv',
					size: 7,
				});
			},
		],
	];

	it.each(edits)('%s keeps the draft once the conversation is answered', async (_label, edit) => {
		const t = convexTest(schema, modules);
		const r = await openReply(t);
		await save(t, r, aiBody(AI_TEXT), { aiText: AI_TEXT });

		await edit(t, r);

		expect((await draftRow(t, r)).humanTouchedAt).toBeDefined();
		expect(await answerAndCheck(t, r)).toBe(false);
	});
});

describe('a write that changes nothing', () => {
	it('leaves the draft the AI’s: the same sender, an attachment that is not there', async () => {
		const t = convexTest(schema, modules);
		const r = await openReply(t);
		await save(t, r, aiBody(AI_TEXT), { aiText: AI_TEXT });
		const absent = await t.run(async (ctx) => ctx.storage.store(new Blob(['x'])));

		await t.mutation(api.mail.drafts.setIdentity, { draftId: r.draftId, fromAddress: OWNER });
		await t.mutation(api.mail.drafts.removeAttachment, { draftId: r.draftId, storageId: absent });

		expect((await draftRow(t, r)).humanTouchedAt).toBeUndefined();
		expect(await answerAndCheck(t, r)).toBe(true);
	});
});

describe('the Drafts list', () => {
	it('shows a live draft however many newer drafts are hidden as answered', async () => {
		const t = convexTest(schema, modules);
		const r = await openReply(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(r.draftId, { lastEditedAt: 1_000 });
			const live = (await ctx.db.get(r.draftId))!;
			const { _id, _creationTime, ...base } = live;
			for (let i = 0; i < 101; i++) {
				await ctx.db.insert('mailDrafts', {
					...base,
					lastEditedAt: 2_000 + i,
					obsoleted: { byMessageIds: [r.askId], at: 2_000 },
				});
			}
		});

		const listed = await t.query(api.mail.drafts.listForMailbox, { mailboxId: r.mailboxId });

		expect(listed.map((d) => d._id)).toEqual([r.draftId]);
	});
});

describe('a write that changes nothing, between two replies', () => {
	/** A reply queued on Sam's mail and taken to `→ sent`; returns the sent copy. */
	async function sendReply(t: T, r: Reply): Promise<Id<'mailMessages'>> {
		const draftId = await t.run(async (ctx) =>
			ctx.db.insert('mailDrafts', {
				mailboxId: r.mailboxId,
				inReplyToMessageId: r.askId,
				threadId: (await ctx.db.get(r.askId))!.threadId,
				toAddresses: [SENDER],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: OWNER,
				subject: 'Re: Can you send the report?',
				bodyHtml: '<p>Sent</p>',
				attachments: [],
				state: 'pending_send',
				undoToken: `undo-${Math.random()}`,
				lastEditedAt: Date.now(),
				createdAt: Date.now(),
			})
		);
		const rawStorageId = await t.run(async (ctx) => ctx.storage.store(new Blob(['raw'])));
		const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId,
			input: {
				to: 'sent',
				at: Date.now(),
				context: {
					rawStorageId,
					rawSize: 3,
					rfc822MessageId: 'reply@owlat.test',
					references: [],
					bodyHtml: '<p>Sent</p>',
					bodyText: 'Sent',
					attachmentsMeta: [],
				},
			},
		});
		if (!outcome.ok || !outcome.messageId) throw new Error('send did not reach → sent');
		return outcome.messageId;
	}

	async function deliver(t: T, sentId: Id<'mailMessages'>, verdict: 'sent' | 'bounced') {
		await t.mutation(internal.mail.postboxOutboundLifecycle.transition, {
			mailMessageId: sentId,
			recipientIdx: 0,
			input:
				verdict === 'sent' ? { to: 'sent', at: Date.now() } : { to: 'bounced', at: Date.now() },
		});
	}

	it('does not move the draft past a queued reply, which then still answers it', async () => {
		const t = convexTest(schema, modules);
		const r = await openReply(t);
		await save(t, r, aiBody(AI_TEXT), { aiText: AI_TEXT });
		const sentA = await sendReply(t, r);
		const sentB = await sendReply(t, r);
		await deliver(t, sentA, 'sent');
		expect((await draftRow(t, r)).obsoleted?.byMessageIds).toEqual([sentA]);
		const editedAt = (await draftRow(t, r)).lastEditedAt;

		// A minute on, so a save that wrongly stamped a fresh edit would show it.
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(editedAt! + 60_000);
			await t.mutation(api.mail.drafts.setIdentity, { draftId: r.draftId, fromAddress: OWNER });
			await save(t, r, aiBody(AI_TEXT), { aiText: AI_TEXT }); // the same snapshot again
			expect((await draftRow(t, r)).lastEditedAt).toBe(editedAt);
		} finally {
			vi.useRealTimers();
		}

		await deliver(t, sentB, 'sent');
		await deliver(t, sentA, 'bounced');
		expect((await draftRow(t, r)).obsoleted?.byMessageIds).toEqual([sentB]);
	});
});
