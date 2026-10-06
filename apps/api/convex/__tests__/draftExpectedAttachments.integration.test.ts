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
 *  - a forward is one debt the server expands from the raw message (the
 *    disposition rule, raw part index as identity) and copies from that same
 *    parse, once across tabs; one it cannot read stays owed;
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

/** A raw MIME leaf. */
function leaf(type: string, headers: string[], body: string): string {
	return [
		`Content-Type: ${type}`,
		...headers,
		'Content-Transfer-Encoding: base64',
		'',
		Buffer.from(body).toString('base64'),
	].join('\r\n');
}
const attached = (name: string) => `Content-Disposition: attachment; filename="${name}"`;

/** A raw message: an HTML body and `leaves`, as a client sends it. */
function rawMessage(html: string, leaves: string[]): string {
	return [
		'From: billing@example.com',
		'MIME-Version: 1.0',
		'Content-Type: multipart/mixed; boundary="b"',
		'',
		'--b',
		'Content-Type: text/html; charset=utf-8',
		'',
		html,
		...leaves.flatMap((part) => ['--b', part]),
		'--b--',
		'',
	].join('\r\n');
}

/**
 * A PDF that is a real attachment but also has a Content-ID the body links
 * (`href="cid:"`), a photo marked as an attachment that the body also shows
 * (`<img src="cid:">`), and an inline logo.
 */
const INVOICE_EML = rawMessage(
	'<p>Your <a href="cid:invoice@x">invoice</a>.</p><img src="cid:photo@x"><img src="cid:logo@x">',
	[
		leaf('application/pdf', ['Content-ID: <invoice@x>', attached('invoice.pdf')], '%PDF-1.4'),
		leaf('image/png', ['Content-ID: <photo@x>', attached('photo.png')], 'photo'),
		leaf(
			'image/png',
			['Content-ID: <logo@x>', 'Content-Disposition: inline; filename="logo.png"'],
			'logo'
		),
	]
);

/**
 * A message whose row lists `metadata` (what delivery recorded, possibly by
 * another parser) and whose raw blob is `eml`.
 */
async function forwardSource(
	t: Harness,
	mailboxId: Id<'mailboxes'>,
	eml = INVOICE_EML,
	metadata: Array<{
		filename: string;
		contentType: string;
		size: number;
		partIndex: string;
		contentId?: string;
	}> = []
) {
	await seedFolder(t, mailboxId, 'inbox');
	const messageId = await seedMessage(t, mailboxId, { subject: 'Invoice', attachments: metadata });
	await t.run(async (ctx) => {
		const rawStorageId = await ctx.storage.store(new Blob([eml]));
		await ctx.db.patch(messageId, { rawStorageId });
	});
	return messageId;
}

async function forwardDraft(
	t: Harness,
	eml?: string,
	metadata?: Parameters<typeof forwardSource>[3]
) {
	const mailboxId = await seedMailbox(t);
	const messageId = await forwardSource(t, mailboxId, eml, metadata);
	const { draftId } = await t.mutation(api.mail.drafts.create, {
		mailboxId,
		expectedAttachments: [{ kind: 'forward', messageId }],
	});
	return { mailboxId, messageId, draftId };
}

const fulfil = (t: Harness, draftId: Id<'mailDrafts'>) =>
	t.action(api.mail.draftExpectedAttachmentsFulfil.fulfil, { draftId });

async function attachedText(t: Harness, draftId: Id<'mailDrafts'>) {
	const draft = (await row(t, draftId))!;
	return t.run(async (ctx) =>
		Promise.all(
			draft.attachments.map(async (a) => [
				a.filename,
				await (await ctx.storage.get(a.storageId))!.text(),
			])
		)
	);
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
			t.action(api.mail.draftExpectedAttachmentsFulfil.fulfil, { draftId }),
			t.action(api.mail.draftExpectedAttachmentsFulfil.fulfil, { draftId }),
		]);
		expect(results).toEqual([{ failed: [] }, { failed: [] }]);
		await t.action(api.mail.draftExpectedAttachmentsFulfil.fulfil, { draftId });
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
			await t.action(api.mail.draftExpectedAttachmentsFulfil.fulfil, { draftId });
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
		expect(await t.action(api.mail.draftExpectedAttachmentsFulfil.fulfil, { draftId })).toEqual({
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
		await t.action(api.mail.draftExpectedAttachmentsFulfil.fulfil, { draftId });
		const landed = (await row(t, draftId))!.attachments[0]!.storageId;
		await t.mutation(api.mail.draftExpectedAttachments.remove, { draftId, key: 'generated:0' });
		expect((await row(t, draftId))!.attachments).toEqual([]);
		expect(await t.run(async (ctx) => (await ctx.storage.get(landed)) !== null)).toBe(false);
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
		expect(await t.action(api.mail.draftExpectedAttachmentsFulfil.fulfil, { draftId })).toEqual({
			failed: [{ key: 'generated:0', filename: 'reply.ics', reason: 'tooMany' }],
		});
		expect((await row(t, draftId))?.expectedAttachments?.[0]?.state).toBe('owed');
	});

	it('settles an attached file as removed when its chip is removed like any attachment', async () => {
		const t = convexTest();
		const { draftId } = await rsvpDraft(t);
		await t.action(api.mail.draftExpectedAttachmentsFulfil.fulfil, { draftId });
		const landed = (await row(t, draftId))!.attachments[0]!.storageId;
		await t.mutation(api.mail.drafts.removeAttachment, { draftId, storageId: landed });
		const draft = (await row(t, draftId))!;
		expect(draft.attachments).toEqual([]);
		expect(draft.expectedAttachments?.[0]?.state).toBe('removed');
		// Nothing brings it back.
		await t.action(api.mail.draftExpectedAttachmentsFulfil.fulfil, { draftId });
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
			await t.action(api.mail.draftExpectedAttachmentsFulfil.fulfil, { draftId });
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
		expect(await t.action(api.mail.draftExpectedAttachmentsFulfil.fulfil, { draftId })).toEqual({
			failed: [],
		});
		expect(await sendError(t, draftId)).not.toMatch(/still being added/);
	});
	it('owes a forward as one debt and refuses Send until the server has expanded it', async () => {
		const t = convexTest();
		const { messageId, draftId } = await forwardDraft(t);
		expect((await row(t, draftId))?.expectedAttachments).toEqual([
			{
				key: `forward:${messageId}`,
				filename: '',
				contentType: 'application/octet-stream',
				size: 0,
				source: { kind: 'forwardMessage', messageId },
				state: 'owed',
				isPlaceholder: true,
			},
		]);
		expect(await sendError(t, draftId)).toMatch(/still being added/);
	});

	it('copies what the raw message marks as attachments, also an image the body shows', async () => {
		// No client read at all (the row was made before anything named a part).
		const t = convexTest();
		const { messageId, draftId } = await forwardDraft(t);
		expect(await fulfil(t, draftId)).toEqual({ failed: [] });
		const draft = (await row(t, draftId))!;
		expect(draft.expectedAttachments?.map((e) => [e.key, e.state])).toEqual([
			[`forward:${messageId}:0`, 'attached'],
			[`forward:${messageId}:1`, 'attached'],
		]);
		expect(await attachedText(t, draftId)).toEqual([
			['invoice.pdf', '%PDF-1.4'],
			['photo.png', 'photo'],
		]);
		expect(await sendError(t, draftId)).not.toMatch(/still being added/);
	});

	it('keys duplicate filenames by raw part, whatever the row recorded', async () => {
		const t = convexTest();
		// A legacy row (another parser) numbered an unnamed inline image as part 0
		// and the two PDFs 1 and 2; the raw walker sees only the two PDFs, 0 and 1.
		const eml = rawMessage('<p>Two invoices.</p><img src="cid:sig@x">', [
			leaf('image/png', ['Content-ID: <sig@x>', 'Content-Disposition: inline'], 'sig'),
			leaf('application/pdf', [attached('invoice.pdf')], 'first'),
			leaf('application/pdf', [attached('invoice.pdf')], 'second'),
		]);
		const metadata = [
			{
				filename: 'attachment-0',
				contentType: 'image/png',
				size: 3,
				partIndex: '0',
				contentId: 'sig@x',
			},
			{ filename: 'invoice.pdf', contentType: 'application/pdf', size: 5, partIndex: '1' },
			{ filename: 'invoice.pdf', contentType: 'application/pdf', size: 6, partIndex: '2' },
		];
		const { messageId, draftId } = await forwardDraft(t, eml, metadata);
		expect(forwardedParts(eml).map((p) => p.partIndex)).toEqual(['0', '1']);
		expect(await fulfil(t, draftId)).toEqual({ failed: [] });
		expect((await row(t, draftId))?.expectedAttachments?.map((e) => e.key)).toEqual([
			`forward:${messageId}:0`,
			`forward:${messageId}:1`,
		]);
		expect(await attachedText(t, draftId)).toEqual([
			['invoice.pdf', 'first'],
			['invoice.pdf', 'second'],
		]);
	});

	it('expands a forward once when two tabs fulfil it at the same time', async () => {
		const t = convexTest();
		const { draftId } = await forwardDraft(t);
		const before = await blobCount(t);
		await Promise.all([fulfil(t, draftId), fulfil(t, draftId)]);
		const draft = (await row(t, draftId))!;
		expect(draft.expectedAttachments).toHaveLength(2);
		expect(draft.attachments.map((a) => a.filename)).toEqual(['invoice.pdf', 'photo.png']);
		// Losing copies are dropped: one blob per attachment.
		expect(await blobCount(t)).toBe(before + 2);
	});

	it('keeps an unreadable forward owed, and removing it clears the whole forward', async () => {
		const t = convexTest();
		const { messageId, draftId } = await forwardDraft(t);
		await t.run(async (ctx) => {
			const message = (await ctx.db.get(messageId))!;
			await ctx.storage.delete(message.rawStorageId);
		});
		expect(await fulfil(t, draftId)).toEqual({
			failed: [{ key: `forward:${messageId}`, filename: '', reason: 'unreadable' }],
		});
		expect((await row(t, draftId))?.expectedAttachments?.[0]?.state).toBe('owed');
		expect(await sendError(t, draftId)).toMatch(/still being added/);

		await t.mutation(api.mail.draftExpectedAttachments.remove, {
			draftId,
			key: `forward:${messageId}`,
		});
		expect(await fulfil(t, draftId)).toEqual({ failed: [] });
		expect((await row(t, draftId))!.attachments).toEqual([]);
		expect(await sendError(t, draftId)).not.toMatch(/still being added/);
	});

	it('owes a deleted forward as the placeholder debt, never as nothing', async () => {
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
		expect(await fulfil(t, draftId)).toEqual({
			failed: [{ key: `forward:${messageId}`, filename: '', reason: 'unreadable' }],
		});
		expect(await sendError(t, draftId)).toMatch(/still being added/);
	});

	it('keeps parts over a compose limit owed, and refuses to expand past 1000 parts', async () => {
		const t = convexTest();
		const count = ATTACHMENT_COMPOSE_LIMITS.maxCount + 2;
		const eml = rawMessage(
			'<p>Many.</p>',
			Array.from({ length: count }, (_, i) =>
				leaf('text/plain', [attached(`part-${i}.txt`)], `p${i}`)
			)
		);
		const { draftId } = await forwardDraft(t, eml);
		const { failed } = await fulfil(t, draftId);
		expect(failed.map((f) => f.reason)).toEqual(['tooMany', 'tooMany']);
		const draft = (await row(t, draftId))!;
		expect(draft.attachments).toHaveLength(ATTACHMENT_COMPOSE_LIMITS.maxCount);
		expect(draft.expectedAttachments?.filter((e) => e.state === 'owed')).toHaveLength(2);

		const other = await forwardDraft(t);
		const tooMany = Array.from({ length: 1001 }, (_, i) => ({
			partIndex: String(i),
			filename: `p${i}`,
			contentType: 'text/plain',
			size: 1,
		}));
		await expect(
			t.mutation(internal.mail.draftExpectedAttachments.expandForward, {
				draftId: other.draftId,
				key: `forward:${other.messageId}`,
				parts: tooMany,
			})
		).resolves.toEqual({ outcome: 'tooMany', owed: [] });
		expect((await row(t, other.draftId))?.expectedAttachments?.[0]?.state).toBe('owed');
	});
});
