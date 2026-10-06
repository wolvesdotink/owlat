/**
 * A draft owes the files it was opened to carry until they are attached
 * (#1257, mail/draftExpectedAttachments.ts). The row is the only record, so
 * every tab reads the same debt:
 *
 *  - `drafts.create` writes the owed list with the row; `drafts.get` shows it
 *    without a generated file's text; `drafts.send` refuses while one is owed;
 *  - `fulfil` attaches each owed key exactly once, from any number of tabs at
 *    once, and deletes a losing copy's blob;
 *  - `remove` settles a key as removed, takes a landed copy back out, and a
 *    copy still in flight is refused;
 *  - a forwarded part that cannot be read (yet) stays owed;
 *  - a draft created without the argument (the previous web app) owes nothing.
 */
import { convexTest as baseConvexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { ATTACHMENT_COMPOSE_LIMITS } from '@owlat/shared/attachments';
import { seedFolder, seedMailbox, seedMessage } from '../mail/__tests__/helpers.testlib';

const session = vi.hoisted(() => ({
	userId: 'user-A',
	activeOrganizationId: 'org-1',
	role: 'owner',
}));
vi.mock('../lib/sessionOrganization', async () => ({
	...(await vi.importActual('../lib/sessionOrganization')),
	getMutationContext: vi.fn(async () => ({ ...session })),
	requireOrgMember: vi.fn(async () => ({ ...session })),
	getBetterAuthSessionWithRole: vi.fn(async () => ({ ...session })),
	isActiveOrgMember: vi.fn(async () => true),
}));

const modules = import.meta.glob('../**/*.*s');
type Harness = TestConvex<typeof schema>;

function convexTest(): Harness {
	const t = baseConvexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

beforeEach(() => {
	session.userId = 'user-A';
	session.activeOrganizationId = 'org-1';
});

const ICS = 'BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nEND:VCALENDAR';
const RSVP = {
	kind: 'generated' as const,
	filename: 'reply.ics',
	contentType: 'text/calendar; method=REPLY; charset=utf-8',
	content: ICS,
};

async function rsvpDraft(t: Harness) {
	const mailboxId = await seedMailbox(t);
	const { draftId } = await t.mutation(api.mail.drafts.create, {
		mailboxId,
		expectedAttachments: [RSVP],
	});
	return { mailboxId, draftId };
}

const row = (t: Harness, draftId: Id<'mailDrafts'>) => t.run((ctx) => ctx.db.get(draftId));
const blobCount = (t: Harness) =>
	t.run(async (ctx) => (await ctx.db.system.query('_storage').collect()).length);

async function sendError(t: Harness, draftId: Id<'mailDrafts'>): Promise<string | null> {
	try {
		await t.mutation(api.mail.drafts.send, { draftId });
		return null;
	} catch (err) {
		return String(err);
	}
}

/** A message in the mailbox carrying a file part (stored) and an inline image. */
async function forwardSource(t: Harness, mailboxId: Id<'mailboxes'>, stored = true) {
	await seedFolder(t, mailboxId, 'inbox');
	const messageId = await seedMessage(t, mailboxId, {
		subject: 'Q3 numbers',
		attachments: [
			{ filename: 'numbers.pdf', contentType: 'application/pdf', size: 12, partIndex: '0' },
			{
				filename: 'logo.png',
				contentType: 'image/png',
				size: 4,
				partIndex: '1',
				contentId: 'logo@x',
			},
		],
	});
	if (stored) await storeParts(t, messageId);
	return messageId;
}

async function storeParts(t: Harness, messageId: Id<'mailMessages'>) {
	await t.run(async (ctx) => {
		const message = (await ctx.db.get(messageId))!;
		const pdf = await ctx.storage.store(new Blob(['%PDF numbers'], { type: 'application/pdf' }));
		const png = await ctx.storage.store(new Blob(['logo'], { type: 'image/png' }));
		await ctx.db.insert('mailMessageParts', {
			rawStorageId: message.rawStorageId,
			status: 'stored',
			parts: [
				{ filename: 'numbers.pdf', contentType: 'application/pdf', size: 12, storageId: pdf },
				{ filename: 'logo.png', contentType: 'image/png', size: 4, storageId: png },
			],
			createdAt: Date.now(),
		});
	});
}

describe('a draft owes its expected attachments', () => {
	it('is created owing the RSVP, shows the debt without its text, and refuses Send', async () => {
		const t = convexTest();
		const { draftId } = await rsvpDraft(t);
		expect((await row(t, draftId))?.expectedAttachments).toEqual([
			{
				key: 'generated:0',
				filename: 'reply.ics',
				contentType: RSVP.contentType,
				size: ICS.length,
				source: { kind: 'generated', content: ICS },
				state: 'owed',
			},
		]);
		const view = await t.query(api.mail.drafts.get, { draftId });
		expect(view?.expectedAttachments?.[0]?.source).toEqual({ kind: 'generated' });
		expect(await sendError(t, draftId)).toMatch(/still being added/);
	});

	it('attaches it once, however many tabs ask, and then lets Send through', async () => {
		const t = convexTest();
		const { draftId } = await rsvpDraft(t);
		const before = await blobCount(t);
		const results = await Promise.all([
			t.action(api.mail.draftExpectedAttachments.fulfil, { draftId }),
			t.action(api.mail.draftExpectedAttachments.fulfil, { draftId }),
		]);
		expect(results).toEqual([{ failed: [] }, { failed: [] }]);
		await t.action(api.mail.draftExpectedAttachments.fulfil, { draftId });
		const draft = (await row(t, draftId))!;
		expect(draft.attachments.map((a) => a.filename)).toEqual(['reply.ics']);
		expect(draft.expectedAttachments?.[0]).toMatchObject({
			state: 'attached',
			storageId: draft.attachments[0]!.storageId,
			source: { kind: 'generated' },
		});
		// The losing copy's blob is gone: one new blob for one attachment.
		expect(await blobCount(t)).toBe(before + 1);
		const text = await t.run(async (ctx) =>
			(await ctx.storage.get(draft.attachments[0]!.storageId))!.text()
		);
		expect(text).toBe(ICS);
		expect(await sendError(t, draftId)).not.toMatch(/still being added/);
	});

	it('refuses a copy that lands after the person removed the file', async () => {
		const t = convexTest();
		const { draftId } = await rsvpDraft(t);
		await t.mutation(api.mail.draftExpectedAttachments.remove, { draftId, key: 'generated:0' });
		// A copy that was already in flight reaches the server now.
		const late = await t.run((ctx) => ctx.storage.store(new Blob([ICS])));
		await expect(
			t.mutation(internal.mail.draftExpectedAttachments.bindExpected, {
				draftId,
				key: 'generated:0',
				storageId: late,
			})
		).resolves.toEqual({ outcome: 'taken' });
		expect(await t.action(api.mail.draftExpectedAttachments.fulfil, { draftId })).toEqual({
			failed: [],
		});
		const draft = (await row(t, draftId))!;
		expect(draft.attachments).toEqual([]);
		expect(draft.expectedAttachments?.[0]).toMatchObject({
			state: 'removed',
			source: { kind: 'generated' },
		});
		expect(await sendError(t, draftId)).not.toMatch(/still being added/);
	});

	it('takes a copy that already landed back out when the file is removed', async () => {
		const t = convexTest();
		const { draftId } = await rsvpDraft(t);
		await t.action(api.mail.draftExpectedAttachments.fulfil, { draftId });
		const landed = (await row(t, draftId))!.attachments[0]!.storageId;
		await t.mutation(api.mail.draftExpectedAttachments.remove, { draftId, key: 'generated:0' });
		expect((await row(t, draftId))!.attachments).toEqual([]);
		expect(await t.run(async (ctx) => (await ctx.storage.get(landed)) !== null)).toBe(false);
	});

	it('owes a forward its file parts, not its inline images, and copies them on the server', async () => {
		const t = convexTest();
		const mailboxId = await seedMailbox(t);
		const messageId = await forwardSource(t, mailboxId);
		const { draftId } = await t.mutation(api.mail.drafts.create, {
			mailboxId,
			expectedAttachments: [{ kind: 'forward', messageId }],
		});
		expect((await row(t, draftId))?.expectedAttachments?.map((e) => e.key)).toEqual([
			`forward:${messageId}:0`,
		]);
		await t.action(api.mail.draftExpectedAttachments.fulfil, { draftId });
		const draft = (await row(t, draftId))!;
		expect(draft.attachments.map((a) => a.filename)).toEqual(['numbers.pdf']);
		const text = await t.run(async (ctx) =>
			(await ctx.storage.get(draft.attachments[0]!.storageId))!.text()
		);
		expect(text).toBe('%PDF numbers');
	});

	it('keeps a forwarded part owed while it cannot be read, and attaches it on a retry', async () => {
		const t = convexTest();
		const mailboxId = await seedMailbox(t);
		const messageId = await forwardSource(t, mailboxId, false);
		const { draftId } = await t.mutation(api.mail.drafts.create, {
			mailboxId,
			expectedAttachments: [{ kind: 'forward', messageId }],
		});
		expect(await t.action(api.mail.draftExpectedAttachments.fulfil, { draftId })).toEqual({
			failed: [{ key: `forward:${messageId}:0`, filename: 'numbers.pdf', reason: 'unreadable' }],
		});
		expect((await row(t, draftId))?.expectedAttachments?.[0]?.state).toBe('owed');
		expect(await sendError(t, draftId)).toMatch(/still being added/);

		await storeParts(t, messageId);
		expect(await t.action(api.mail.draftExpectedAttachments.fulfil, { draftId })).toEqual({
			failed: [],
		});
		expect((await row(t, draftId))!.attachments.map((a) => a.filename)).toEqual(['numbers.pdf']);
	});

	it('keeps a file owed when a compose limit refuses it', async () => {
		const t = convexTest();
		const { draftId } = await rsvpDraft(t);
		await t.run(async (ctx) => {
			const filler = await ctx.storage.store(new Blob(['x']));
			const draft = (await ctx.db.get(draftId))!;
			await ctx.db.patch(draftId, {
				attachments: Array.from({ length: ATTACHMENT_COMPOSE_LIMITS.maxCount }, (_, i) => ({
					...{ storageId: filler, filename: `f${i}`, contentType: 'text/plain', size: 1 },
					isInline: false,
				})),
				expectedAttachments: draft.expectedAttachments,
			});
		});
		expect(await t.action(api.mail.draftExpectedAttachments.fulfil, { draftId })).toEqual({
			failed: [{ key: 'generated:0', filename: 'reply.ics', reason: 'tooMany' }],
		});
		expect((await row(t, draftId))?.expectedAttachments?.[0]?.state).toBe('owed');
	});

	it('refuses a forward of a message the caller cannot read, and an oversized generated file', async () => {
		const t = convexTest();
		const mailboxId = await seedMailbox(t);
		const foreign = await seedMailbox(t, {
			userId: 'user-B',
			organizationId: 'org-2',
			address: 'b@owlat.test',
		});
		const messageId = await forwardSource(t, foreign);
		await expect(
			t.mutation(api.mail.drafts.create, {
				mailboxId,
				expectedAttachments: [{ kind: 'forward', messageId }],
			})
		).rejects.toThrow(/not accessible/);
		await expect(
			t.mutation(api.mail.drafts.create, {
				mailboxId,
				expectedAttachments: [{ ...RSVP, content: 'x'.repeat(64 * 1024 + 1) }],
			})
		).rejects.toThrow(/too large/);
	});

	it('owes nothing for a draft created without the argument (the previous web app)', async () => {
		const t = convexTest();
		const mailboxId = await seedMailbox(t);
		const { draftId } = await t.mutation(api.mail.drafts.create, { mailboxId });
		expect((await row(t, draftId))?.expectedAttachments).toBeUndefined();
		expect(await t.action(api.mail.draftExpectedAttachments.fulfil, { draftId })).toEqual({
			failed: [],
		});
		expect(await sendError(t, draftId)).not.toMatch(/still being added/);
	});
});
