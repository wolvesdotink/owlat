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
import { forwardedParts } from '@owlat/shared/mailMime';
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

/**
 * A received message as a client sends it: a PDF that is a real attachment but
 * also carries a Content-ID (linked from the body with `href="cid:"`), a photo
 * marked as an attachment though the body also shows it, and an inline logo.
 */
const INVOICE_EML = [
	'From: billing@example.com',
	'Subject: Invoice',
	'MIME-Version: 1.0',
	'Content-Type: multipart/mixed; boundary="mix"',
	'',
	'--mix',
	'Content-Type: multipart/related; boundary="rel"',
	'',
	'--rel',
	'Content-Type: text/html; charset=utf-8',
	'',
	'<p>Your <a href="cid:invoice@example.com">invoice</a>.</p><img src="cid:photo@example.com"><img src="cid:logo@example.com">',
	'--rel',
	'Content-Type: application/pdf; name="invoice.pdf"',
	'Content-ID: <invoice@example.com>',
	'Content-Disposition: attachment; filename="invoice.pdf"',
	'Content-Transfer-Encoding: base64',
	'',
	Buffer.from('%PDF-1.4').toString('base64'),
	'--rel',
	'Content-Type: image/png; name="photo.png"',
	'Content-ID: <photo@example.com>',
	'Content-Disposition: attachment; filename="photo.png"',
	'Content-Transfer-Encoding: base64',
	'',
	Buffer.from('photo').toString('base64'),
	'--rel',
	'Content-Type: image/png; name="logo.png"',
	'Content-ID: <logo@example.com>',
	'Content-Disposition: inline; filename="logo.png"',
	'Content-Transfer-Encoding: base64',
	'',
	Buffer.from('logo').toString('base64'),
	'--rel--',
	'--mix--',
	'',
].join('\r\n');
const INVOICE_HTML =
	'<p>Your <a href="cid:invoice@example.com">invoice</a>.</p><img src="cid:photo@example.com"><img src="cid:logo@example.com">';

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
		htmlBodyInline: '<p>Numbers attached.</p><img src="cid:logo@x">',
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

	it('keeps the generated text sealed at rest and attaches the plaintext', async () => {
		vi.stubEnv('INSTANCE_SECRET', 'test-instance-secret');
		try {
			const t = convexTest();
			const { draftId } = await rsvpDraft(t);
			const stored = (await row(t, draftId))?.expectedAttachments?.[0]?.source;
			expect(stored).toMatchObject({ kind: 'generated' });
			expect(JSON.stringify(stored)).not.toContain('METHOD:REPLY');
			await t.action(api.mail.draftExpectedAttachments.fulfil, { draftId });
			const draft = (await row(t, draftId))!;
			const text = await t.run(async (ctx) =>
				(await ctx.storage.get(draft.attachments[0]!.storageId))!.text()
			);
			expect(text).toBe(ICS);
		} finally {
			vi.unstubAllEnvs();
		}
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

	it('forwards a raw message the way the composer names it: files by disposition, Content-ID or not', async () => {
		const t = convexTest();
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'inbox');
		// What delivery records for this raw message: no disposition, only Content-IDs.
		const messageId = await seedMessage(t, mailboxId, {
			htmlBodyInline: INVOICE_HTML,
			attachments: [
				{
					filename: 'invoice.pdf',
					contentType: 'application/pdf',
					size: 9,
					partIndex: '0',
					contentId: '<invoice@example.com>',
				},
				{
					filename: 'photo.png',
					contentType: 'image/png',
					size: 5,
					partIndex: '1',
					contentId: '<photo@example.com>',
				},
				{
					filename: 'logo.png',
					contentType: 'image/png',
					size: 4,
					partIndex: '2',
					contentId: '<logo@example.com>',
				},
			],
		});
		await t.run(async (ctx) => {
			const rawStorageId = await ctx.storage.store(new Blob([INVOICE_EML]));
			await ctx.db.patch(messageId, { rawStorageId });
		});
		// The composer reads the raw message and names the parts marked as attachments.
		const parts = forwardedParts(INVOICE_EML);
		expect(parts).toEqual([
			{ partIndex: '0', filename: 'invoice.pdf' },
			{ partIndex: '1', filename: 'photo.png' },
		]);
		const { draftId } = await t.mutation(api.mail.drafts.create, {
			mailboxId,
			expectedAttachments: [{ kind: 'forward', messageId, parts }],
		});
		expect(await t.action(api.mail.draftExpectedAttachments.fulfil, { draftId })).toEqual({
			failed: [],
		});
		const draft = (await row(t, draftId))!;
		expect(draft.attachments.map((a) => a.filename)).toEqual(['invoice.pdf', 'photo.png']);
		const pdf = await t.run(async (ctx) =>
			(await ctx.storage.get(draft.attachments[0]!.storageId))!.text()
		);
		expect(pdf).toBe('%PDF-1.4');

		// Without named parts the row decides: only the image the body shows stays out.
		const derived = await t.mutation(api.mail.drafts.create, {
			mailboxId,
			expectedAttachments: [{ kind: 'forward', messageId }],
		});
		expect((await row(t, derived.draftId))?.expectedAttachments?.map((e) => e.filename)).toEqual([
			'invoice.pdf',
		]);
	});

	it('owes a placeholder for a deleted forward whose parts were never named', async () => {
		const t = convexTest();
		const mailboxId = await seedMailbox(t);
		const messageId = await forwardSource(t, mailboxId);
		await t.run((ctx) => ctx.db.delete(messageId));
		const { draftId } = await t.mutation(api.mail.drafts.create, {
			mailboxId,
			expectedAttachments: [{ kind: 'forward', messageId }],
		});
		const entries = (await t.query(api.mail.drafts.get, { draftId }))?.expectedAttachments;
		expect(entries).toEqual([
			expect.objectContaining({ filename: '', isPlaceholder: true, state: 'owed' }),
		]);
		expect(await sendError(t, draftId)).toMatch(/still being added/);
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
					storageId: filler,
					filename: `f${i}`,
					contentType: 'text/plain',
					size: 1,
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

	it('still owes the files of a forwarded message that was deleted before the draft existed', async () => {
		const t = convexTest();
		const mailboxId = await seedMailbox(t);
		const messageId = await forwardSource(t, mailboxId);
		await t.run((ctx) => ctx.db.delete(messageId));
		const { draftId } = await t.mutation(api.mail.drafts.create, {
			mailboxId,
			expectedAttachments: [
				{ kind: 'forward', messageId, parts: [{ partIndex: '0', filename: 'numbers.pdf' }] },
			],
		});
		expect(await t.action(api.mail.draftExpectedAttachments.fulfil, { draftId })).toEqual({
			failed: [{ key: `forward:${messageId}:0`, filename: 'numbers.pdf', reason: 'unreadable' }],
		});
		expect(await sendError(t, draftId)).toMatch(/still being added/);
		await t.mutation(api.mail.draftExpectedAttachments.remove, {
			draftId,
			key: `forward:${messageId}:0`,
		});
		expect(await sendError(t, draftId)).not.toMatch(/still being added/);
	});

	it('owes every forwarded part: what a compose limit refuses stays owed, never cut', async () => {
		const t = convexTest();
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'inbox');
		const count = ATTACHMENT_COMPOSE_LIMITS.maxCount + 2;
		const parts = Array.from({ length: count }, (_, i) => ({
			filename: `part-${i}.txt`,
			contentType: 'text/plain',
			size: 2,
			partIndex: String(i),
		}));
		const messageId = await seedMessage(t, mailboxId, { attachments: parts });
		await t.run(async (ctx) => {
			const message = (await ctx.db.get(messageId))!;
			const stored = [];
			for (const part of parts) {
				const storageId = await ctx.storage.store(new Blob([`p${part.partIndex}`]));
				stored.push({ ...part, storageId });
			}
			await ctx.db.insert('mailMessageParts', {
				rawStorageId: message.rawStorageId,
				status: 'stored',
				parts: stored.map(({ partIndex: _p, ...rest }) => rest),
				createdAt: Date.now(),
			});
		});
		const { draftId } = await t.mutation(api.mail.drafts.create, {
			mailboxId,
			expectedAttachments: [{ kind: 'forward', messageId }],
		});
		expect((await row(t, draftId))?.expectedAttachments).toHaveLength(count);
		const { failed } = await t.action(api.mail.draftExpectedAttachments.fulfil, { draftId });
		expect(failed.map((f) => f.reason)).toEqual(['tooMany', 'tooMany']);
		const draft = (await row(t, draftId))!;
		expect(draft.attachments).toHaveLength(ATTACHMENT_COMPOSE_LIMITS.maxCount);
		expect(draft.expectedAttachments?.filter((e) => e.state === 'owed')).toHaveLength(2);
	});

	it('refuses an open owing more parts than any message can hold, whole', async () => {
		const t = convexTest();
		const mailboxId = await seedMailbox(t);
		await seedFolder(t, mailboxId, 'inbox');
		const messageId = await seedMessage(t, mailboxId);
		const parts = Array.from({ length: 1001 }, (_, i) => ({
			partIndex: String(i),
			filename: `p${i}`,
		}));
		await expect(
			t.mutation(api.mail.drafts.create, {
				mailboxId,
				expectedAttachments: [{ kind: 'forward', messageId, parts }],
			})
		).rejects.toThrow(/too many attachments/);
	});

	it('settles an attached file as removed when its chip is removed like any attachment', async () => {
		const t = convexTest();
		const { draftId } = await rsvpDraft(t);
		await t.action(api.mail.draftExpectedAttachments.fulfil, { draftId });
		const landed = (await row(t, draftId))!.attachments[0]!.storageId;
		await t.mutation(api.mail.drafts.removeAttachment, { draftId, storageId: landed });
		const draft = (await row(t, draftId))!;
		expect(draft.attachments).toEqual([]);
		expect(draft.expectedAttachments?.[0]?.state).toBe('removed');
		// Nothing brings it back.
		await t.action(api.mail.draftExpectedAttachments.fulfil, { draftId });
		expect((await row(t, draftId))!.attachments).toEqual([]);
	});

	it('receipts each server copy, so one that is never bound is swept like an unclaimed upload', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			const t = convexTest();
			const { draftId } = await rsvpDraft(t);
			// The action stored and staged a copy, then died before binding it.
			const orphan = await t.run((ctx) => ctx.storage.store(new Blob(['orphan'])));
			await t.mutation(internal.mail.draftExpectedAttachments.stageCopy, { storageId: orphan });
			// A normal fulfil binds its own copy through the same receipt.
			await t.action(api.mail.draftExpectedAttachments.fulfil, { draftId });
			const bound = (await row(t, draftId))!.attachments[0]!.storageId;
			const receipt = (storageId: Id<'_storage'>) =>
				t.run((ctx) =>
					ctx.db
						.query('storageUploads')
						.withIndex('by_storage', (q) => q.eq('storageId', storageId))
						.unique()
				);
			expect(await receipt(bound)).toMatchObject({
				status: 'bound',
				resourceKey: `mailDrafts:${draftId}`,
			});
			expect(await receipt(orphan)).toMatchObject({ status: 'uploaded' });

			vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
			await t.mutation(internal.storage.uploads.cleanup, {});
			const exists = (storageId: Id<'_storage'>) =>
				t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null);
			expect(await exists(orphan)).toBe(false);
			expect(await receipt(orphan)).toBeNull();
			expect(await exists(bound)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
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
		// The bound is UTF-8 bytes: 64 Ki characters of `é` are 128 KiB.
		await expect(
			t.mutation(api.mail.drafts.create, {
				mailboxId,
				expectedAttachments: [{ ...RSVP, content: 'é'.repeat(64 * 1024) }],
			})
		).rejects.toThrow(/too large/);
		const fits = await t.mutation(api.mail.drafts.create, {
			mailboxId,
			expectedAttachments: [{ ...RSVP, content: 'é'.repeat(32 * 1024) }],
		});
		expect((await row(t, fits.draftId))?.expectedAttachments?.[0]?.size).toBe(64 * 1024);
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
