/**
 * Plan 3.2 — inline message bodies live in `mailMessageBodies`, not on the row.
 *
 * Convex reads whole documents, so a body on the `mailMessages` row was paid for
 * by every list, count and flag write that touched it. These tests pin the move:
 *
 *   - delivery writes the body to its own row (sealed when a key is set) and
 *     leaves the message row body-free, while the reader still gets it;
 *   - a legacy row that still carries its body on the row reads the same;
 *   - IMAP COPY gives the copy its own body row, and purging a message removes
 *     only its own;
 *   - filter evaluation sees the moved body;
 *   - the 0049 back-fill moves legacy bodies, is idempotent, resumable and
 *     never changes what a reader returns.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { isSealedAtRest } from '../../lib/atRestBodies';
import { modules, seedMailbox, seedFolder, seedMessage } from './helpers.testlib';
import { expectScheduledFailure } from '../../__tests__/helpers/scheduledFailures';

const sessionMocks = vi.hoisted(() => ({ userId: 'user-A' }));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	const session = async () => ({
		userId: sessionMocks.userId,
		role: 'owner' as const,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		requireOrgMember: vi.fn(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(session),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: 'owner',
			activeOrganizationId: 'org-1',
		})),
	};
});

type T = TestConvex<typeof schema>;

beforeEach(() => {
	sessionMocks.userId = 'user-A';
});

afterEach(() => {
	vi.unstubAllEnvs();
});

/**
 * Stub an instance key for one test. The AI classifiers that delivery schedules
 * read the sealed body too, and they fire after the stub is gone; they are not
 * what these tests are about.
 */
function withInstanceKey(): void {
	vi.stubEnv('INSTANCE_SECRET', 'test-instance-secret-for-body-rows-0123456789');
	expectScheduledFailure('mail/ai/categoryClassify:classifyThread');
	expectScheduledFailure('mail/ai/needsReplyClassify:classifyThread');
}

async function setup(t: T): Promise<Id<'mailboxes'>> {
	const mailboxId = await seedMailbox(t, {
		userId: 'user-A',
		organizationId: 'org-1',
		address: 'me@example.com',
		domain: 'example.com',
	});
	await seedFolder(t, mailboxId, 'inbox');
	await seedFolder(t, mailboxId, 'archive');
	await seedFolder(t, mailboxId, 'trash');
	return mailboxId;
}

let deliverySeq = 0;

/** Deliver one message through the real pipeline (`insertDeliveredMessage`). */
async function deliver(
	t: T,
	body: { text?: string; html?: string } = { text: 'Hello from the body table' }
): Promise<Id<'mailMessages'>> {
	const rawStorageId = await t.run((ctx) => ctx.storage.store(new Blob(['raw'])));
	deliverySeq++;
	const result = await t.mutation(internal.mail.delivery.deliverToMailbox, {
		rawStorageId,
		rawSize: 3,
		recipientAddress: 'me@example.com',
		from: 'Alice <alice@sender.example>',
		to: ['me@example.com'],
		cc: [],
		bcc: [],
		subject: `Body ${deliverySeq}`,
		...(body.text !== undefined ? { textBodyInline: body.text } : {}),
		...(body.html !== undefined ? { htmlBodyInline: body.html } : {}),
		snippet: 'Hello',
		messageId: `<body-${deliverySeq}@sender.example>`,
		receivedAt: Date.now() + deliverySeq,
		attachments: [],
	});
	if (!('messageId' in result)) throw new Error('delivery skipped');
	return result.messageId;
}

function readRow(t: T, id: Id<'mailMessages'>): Promise<Doc<'mailMessages'> | null> {
	return t.run((ctx) => ctx.db.get(id));
}

function bodyRows(t: T, id: Id<'mailMessages'>): Promise<Doc<'mailMessageBodies'>[]> {
	return t.run((ctx) =>
		ctx.db
			.query('mailMessageBodies')
			.withIndex('by_message', (q) => q.eq('messageId', id))
			.collect()
	);
}

async function readerBody(t: T, messageId: Id<'mailMessages'>) {
	const message = await t.query(api.mail.mailbox.messages.getMessage, { messageId });
	const inline = await t.query(api.mail.mailbox.messages.getMessageInlineBody, { messageId });
	const thread = await t.query(api.mail.mailbox.messages.listThreadMessages, { messageId });
	const inThread = thread?.messages.find((m) => m._id === messageId);
	return {
		getMessage: { text: message?.textBodyInline, html: message?.htmlBodyInline },
		inlineBody: { text: inline?.textInline ?? undefined, html: inline?.htmlInline ?? undefined },
		thread: { text: inThread?.textBodyInline, html: inThread?.htmlBodyInline },
	};
}

function expectReaderBody(
	got: Awaited<ReturnType<typeof readerBody>>,
	want: { text?: string; html?: string }
): void {
	expect(got.getMessage).toEqual(want);
	expect(got.inlineBody).toEqual(want);
	expect(got.thread).toEqual(want);
}

describe('mailMessageBodies (plan 3.2)', () => {
	it('delivery stores the body in its own row and the reader still returns it', async () => {
		const t = convexTest(schema, modules);
		await setup(t);
		const id = await deliver(t, { text: 'plain part', html: '<p>html part</p>' });

		const row = await readRow(t, id);
		expect(row).not.toHaveProperty('textBodyInline');
		expect(row).not.toHaveProperty('htmlBodyInline');
		const bodies = await bodyRows(t, id);
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toMatchObject({
			textBodyInline: 'plain part',
			htmlBodyInline: '<p>html part</p>',
		});

		expectReaderBody(await readerBody(t, id), { text: 'plain part', html: '<p>html part</p>' });
	});

	it('seals the body row at rest when the instance has a key', async () => {
		withInstanceKey();
		const t = convexTest(schema, modules);
		await setup(t);
		const id = await deliver(t, { text: 'secret contract terms' });

		const [body] = await bodyRows(t, id);
		expect(body?.textBodyInline).toBeDefined();
		expect(isSealedAtRest(body!.textBodyInline!)).toBe(true);
		expect(body!.textBodyInline).not.toContain('contract');
		// Sealing is at rest only; the reader gets plaintext.
		expectReaderBody(await readerBody(t, id), { text: 'secret contract terms' });
	});

	it('a message without an inline body gets no body row', async () => {
		const t = convexTest(schema, modules);
		await setup(t);
		const id = await deliver(t, {});
		expect(await bodyRows(t, id)).toHaveLength(0);
		expectReaderBody(await readerBody(t, id), {});
	});

	it('a legacy row with its body still on the row reads the same', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await setup(t);
		const id = await seedMessage(t, mailboxId, {
			textBodyInline: 'legacy text',
			htmlBodyInline: '<b>legacy</b>',
		});
		expect(await bodyRows(t, id)).toHaveLength(0);
		expectReaderBody(await readerBody(t, id), { text: 'legacy text', html: '<b>legacy</b>' });
	});

	it('IMAP COPY gives the copy its own body row; purge removes only its own', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await setup(t);
		const id = await deliver(t, { text: 'copied body' });
		const folders = await t.run((ctx) =>
			ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
				.collect()
		);
		const inbox = folders.find((f) => f.role === 'inbox')!;
		const archive = folders.find((f) => f.role === 'archive')!;
		await t.mutation(internal.mail.imap.move.copyMessages, {
			sourceFolderId: inbox._id,
			targetFolderId: archive._id,
			messageIds: [id],
		});
		const copy = await t.run((ctx) =>
			ctx.db
				.query('mailMessages')
				.withIndex('by_folder_and_uid', (q) => q.eq('folderId', archive._id))
				.first()
		);
		expect(copy).not.toBeNull();
		expect(copy!._id).not.toBe(id);
		expect(await bodyRows(t, copy!._id)).toHaveLength(1);
		expectReaderBody(await readerBody(t, copy!._id), { text: 'copied body' });

		await t.mutation(api.mail.messageActions.purge, { messageIds: [id] });
		expect(await bodyRows(t, id)).toHaveLength(0);
		expect(await bodyRows(t, copy!._id)).toHaveLength(1);
		expectReaderBody(await readerBody(t, copy!._id), { text: 'copied body' });
	});

	it('the AI context queries read the moved body', async () => {
		const t = convexTest(schema, modules);
		await setup(t);
		const id = await deliver(t, { text: 'Can you send the signed lease by Friday?' });
		const row = await readRow(t, id);

		const category = await t.query(internal.mail.category.getThreadCategoryContext, {
			threadId: row!.threadId,
		});
		expect(category?.transcript).toContain('signed lease by Friday');
		const needsReply = await t.query(internal.mail.needsReply.getThreadContext, {
			threadId: row!.threadId,
		});
		expect(needsReply?.transcript).toContain('signed lease by Friday');
	});

	it('the filter preview matches a body condition against the moved body', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await setup(t);
		await deliver(t, { text: 'the invoice number is 4411' });
		await deliver(t, { text: 'nothing to see' });
		const legacy = await seedMessage(t, mailboxId, { textBodyInline: 'legacy invoice 4411' });

		const result = await t.query(api.mail.filters.preview, {
			mailboxId,
			conditions: [{ field: 'body', op: 'contains', value: '4411' }],
		});
		expect(result.matchCount).toBe(2);
		expect(result.matches.map((m) => m.messageId)).toContain(legacy);
	});
});

describe('migration 0049_move_message_bodies', () => {
	const migration = internal.migrations['0049_move_message_bodies'];

	async function seedLegacy(t: T, mailboxId: Id<'mailboxes'>, count: number) {
		const ids: Id<'mailMessages'>[] = [];
		for (let i = 0; i < count; i++) {
			ids.push(
				await seedMessage(t, mailboxId, {
					subject: `legacy ${i}`,
					receivedAt: Date.now() - (count - i) * 1000,
					textBodyInline: `text ${i}`,
					...(i % 2 === 0 ? { htmlBodyInline: `<p>html ${i}</p>` } : {}),
				})
			);
		}
		return ids;
	}

	it('moves legacy bodies off the row without changing what the reader returns', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await setup(t);
		const legacy = await seedLegacy(t, mailboxId, 30);
		const fresh = await deliver(t, { text: 'already in the body table' });
		const before = await Promise.all([...legacy, fresh].map((id) => readerBody(t, id)));

		// First page only (25 of 31 rows): a half-moved table reads the same.
		const page = await t.mutation(migration.movePage, { cursor: null });
		expect(page.isDone).toBe(false);
		expect(page.moved).toBe(25);
		const mid = await Promise.all([...legacy, fresh].map((id) => readerBody(t, id)));
		expect(mid).toEqual(before);

		// Resume from the cursor to the end.
		const rest = await t.action(migration.run, { cursor: page.cursor });
		expect(rest.moved).toBe(5);
		for (const id of legacy) {
			const row = await readRow(t, id);
			expect(row).not.toHaveProperty('textBodyInline');
			expect(row).not.toHaveProperty('htmlBodyInline');
			expect(await bodyRows(t, id)).toHaveLength(1);
		}
		const after = await Promise.all([...legacy, fresh].map((id) => readerBody(t, id)));
		expect(after).toEqual(before);

		// Idempotent: a second full run moves nothing and duplicates no body row.
		const again = await t.action(migration.run, {});
		expect(again).toMatchObject({ scanned: 31, moved: 0 });
		for (const id of [...legacy, fresh]) expect(await bodyRows(t, id)).toHaveLength(1);
	});

	it('keeps an existing body row and only clears stale legacy columns', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await setup(t);
		const id = await seedMessage(t, mailboxId, { textBodyInline: 'stale copy' });
		await t.run((ctx) =>
			ctx.db.insert('mailMessageBodies', { messageId: id, textBodyInline: 'current body' })
		);
		expectReaderBody(await readerBody(t, id), { text: 'current body' });

		await t.action(migration.run, {});
		expect(await bodyRows(t, id)).toHaveLength(1);
		expect(await readRow(t, id)).not.toHaveProperty('textBodyInline');
		expectReaderBody(await readerBody(t, id), { text: 'current body' });
	});

	it('seals a plaintext legacy body on the way when the instance has a key', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await setup(t);
		const id = await seedMessage(t, mailboxId, { textBodyInline: 'plaintext from before E8b' });

		withInstanceKey();
		await t.action(migration.run, {});
		const [body] = await bodyRows(t, id);
		expect(isSealedAtRest(body!.textBodyInline!)).toBe(true);
		expectReaderBody(await readerBody(t, id), { text: 'plaintext from before E8b' });
	});

	it('migration 0035 seals body rows written while the instance had no key', async () => {
		const t = convexTest(schema, modules);
		await setup(t);
		const id = await deliver(t, { text: 'written before the key existed' });
		const [plain] = await bodyRows(t, id);
		expect(plain?.textBodyInline).toBe('written before the key existed');

		withInstanceKey();
		const page = await t.mutation(
			internal.migrations['0035_seal_bodies_at_rest'].sealMailMessageBodiesPage,
			{ cursor: null }
		);
		expect(page.sealed).toBe(1);
		const [sealed] = await bodyRows(t, id);
		expect(isSealedAtRest(sealed!.textBodyInline!)).toBe(true);
		expectReaderBody(await readerBody(t, id), { text: 'written before the key existed' });
	});
});
