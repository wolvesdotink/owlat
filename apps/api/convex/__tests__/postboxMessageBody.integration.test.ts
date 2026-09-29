/**
 * mail.mailbox.messages.getMessageBody coverage — the reader's body source.
 *
 * Regression guard for the bug where bodies over the 64KB inline threshold were
 * dropped from the row, so newsletters / long threads rendered blank. Large
 * bodies are now stashed as storage blobs and resolved via signed URLs.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { storeSealedBlob } from '../lib/sealedBlob';
import { sealBodyAtWrite } from '../lib/messageBody';
import { enableFeatures } from './factories';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';

const OWNER_SESSION = {
	userId: 'test-user',
	role: 'owner',
	activeOrganizationId: 'test-org',
} as Awaited<ReturnType<typeof getBetterAuthSessionWithRole>>;

const INSTANCE_SECRET = 'postbox-message-body-test-instance-secret';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'owner',
			activeOrganizationId: 'test-org',
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('llmProvider')
	)
);

afterEach(() => {
	vi.unstubAllEnvs();
	vi.mocked(getBetterAuthSessionWithRole).mockResolvedValue(OWNER_SESSION);
});

async function seedMailboxAndFolder(
	t: ReturnType<typeof convexTest>,
	owner: { userId?: string; status?: 'active' | 'suspended' } = {}
) {
	let mailboxId!: Id<'mailboxes'>;
	let folderId!: Id<'mailFolders'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		mailboxId = await ctx.db.insert('mailboxes', {
			userId: owner.userId ?? 'test-user',
			organizationId: 'test-org',
			address: 'me@example.com',
			domain: 'example.com',
			status: owner.status ?? 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		folderId = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			role: 'inbox',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 1,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
	});
	return { mailboxId, folderId };
}

async function insertMessage(
	t: ReturnType<typeof convexTest>,
	mailboxId: Id<'mailboxes'>,
	folderId: Id<'mailFolders'>,
	body: {
		htmlBodyInline?: string;
		textBodyInline?: string;
		htmlBodyStorageId?: Id<'_storage'>;
		textBodyStorageId?: Id<'_storage'>;
	}
): Promise<Id<'mailMessages'>> {
	let id!: Id<'mailMessages'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		const rawStorageId = await ctx.storage.store(new Blob(['raw']));
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 's',
			participants: ['a@example.com'],
			messageCount: 1,
			unreadCount: 0,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 's',
			latestFromAddress: 'a@example.com',
			latestSubject: 's',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		id = await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId,
			uid: 1,
			modseq: 1,
			rfc822MessageId: '<m@example.com>',
			threadId,
			fromAddress: 'a@example.com',
			toAddresses: ['me@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 's',
			normalizedSubject: 's',
			snippet: 's',
			rawStorageId,
			rawSize: 3,
			htmlBodyInline: body.htmlBodyInline,
			textBodyInline: body.textBodyInline,
			htmlBodyStorageId: body.htmlBodyStorageId,
			textBodyStorageId: body.textBodyStorageId,
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
			createdAt: now,
			updatedAt: now,
		});
	});
	return id;
}

describe('mail.mailbox.messages.getMessageBody', () => {
	it('returns the inline body for small messages', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, folderId } = await seedMailboxAndFolder(t);
		const id = await insertMessage(t, mailboxId, folderId, {
			htmlBodyInline: '<p>small</p>',
		});
		const body = await t.action(api.mail.mailbox.messages.getMessageBody, { messageId: id });
		expect(body?.htmlInline).toBe('<p>small</p>');
		expect(body?.htmlUrl).toBeNull();
	});

	it('returns a signed URL for storage-backed large bodies', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, folderId } = await seedMailboxAndFolder(t);
		let storageId!: Id<'_storage'>;
		await t.run(async (ctx) => {
			storageId = await ctx.storage.store(new Blob(['<p>big</p>'], { type: 'text/html' }));
		});
		const id = await insertMessage(t, mailboxId, folderId, { htmlBodyStorageId: storageId });
		const body = await t.action(api.mail.mailbox.messages.getMessageBody, { messageId: id });
		expect(body?.htmlInline).toBeNull();
		expect(body?.htmlUrl).toBeTruthy();
	});

	it('fails closed for a sealed blob after key loss while preserving legacy plaintext', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, folderId } = await seedMailboxAndFolder(t);
		vi.stubEnv('INSTANCE_SECRET', INSTANCE_SECRET);
		const sealedStorageId = await t.run((ctx) =>
			storeSealedBlob(ctx.storage, new TextEncoder().encode('<p>sealed</p>'), 'text/html')
		);
		const sealedMessageId = await insertMessage(t, mailboxId, folderId, {
			htmlBodyStorageId: sealedStorageId,
		});
		vi.stubEnv('INSTANCE_SECRET', undefined);

		const sealedBody = await t.action(api.mail.mailbox.messages.getMessageBody, {
			messageId: sealedMessageId,
		});
		expect(sealedBody?.htmlUrl).toBeNull();
		expect(
			await t.action(internal.mail.imap.fetch.getRawStorageUrl, {
				storageId: sealedStorageId,
			})
		).toBeNull();

		const legacyStorageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(['<p>legacy</p>'], { type: 'text/html' }))
		);
		const legacyMessageId = await insertMessage(t, mailboxId, folderId, {
			htmlBodyStorageId: legacyStorageId,
		});
		const legacyBody = await t.action(api.mail.mailbox.messages.getMessageBody, {
			messageId: legacyMessageId,
		});
		expect(legacyBody?.htmlUrl).toBeTruthy();
		expect(
			await t.action(internal.mail.imap.fetch.getRawStorageUrl, {
				storageId: legacyStorageId,
			})
		).toBeTruthy();
	});

	it('mints raw URLs for a batch of messages in one call (IMAP FETCH, plan 3.6)', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, folderId } = await seedMailboxAndFolder(t);
		const kept = await insertMessage(t, mailboxId, folderId, { htmlBodyInline: '<p>a</p>' });
		const gone = await insertMessage(t, mailboxId, folderId, { htmlBodyInline: '<p>b</p>' });
		await t.run((ctx) => ctx.db.delete(gone));

		const rows = await t.action(internal.mail.imap.fetch.getRawStorageUrls, {
			messageIds: [kept, gone],
		});

		expect(rows.map((r) => r.messageId)).toEqual([kept, gone]);
		expect(rows[0]?.url).toBeTruthy();
		expect(rows[1]?.url).toBeNull();
		await expect(
			t.action(internal.mail.imap.fetch.getRawStorageUrls, {
				messageIds: Array.from({ length: 101 }, () => kept),
			})
		).rejects.toThrow(/At most 100/);
	});
});

describe('mail.mailbox.messages.getMessageInlineBody (reactive body query)', () => {
	it('returns the inline html and text with no blob flags for small messages', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, folderId } = await seedMailboxAndFolder(t);
		const id = await insertMessage(t, mailboxId, folderId, {
			htmlBodyInline: '<p>small</p>',
			textBodyInline: 'small',
		});
		const body = await t.query(api.mail.mailbox.messages.getMessageInlineBody, { messageId: id });
		expect(body).toEqual({
			htmlInline: '<p>small</p>',
			textInline: 'small',
			hasHtmlBlob: false,
			hasTextBlob: false,
		});
	});

	it('unseals a sealed inline body', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, folderId } = await seedMailboxAndFolder(t);
		vi.stubEnv('INSTANCE_SECRET', INSTANCE_SECRET);
		const sealed = await sealBodyAtWrite('<p>secret</p>');
		expect(sealed).not.toBe('<p>secret</p>');
		const id = await insertMessage(t, mailboxId, folderId, { htmlBodyInline: sealed });
		const body = await t.query(api.mail.mailbox.messages.getMessageInlineBody, { messageId: id });
		expect(body?.htmlInline).toBe('<p>secret</p>');
		expect(body?.textInline).toBeNull();
	});

	it('flags storage-backed bodies instead of returning them', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, folderId } = await seedMailboxAndFolder(t);
		const { htmlId, textId } = await t.run(async (ctx) => ({
			htmlId: await ctx.storage.store(new Blob(['<p>big</p>'], { type: 'text/html' })),
			textId: await ctx.storage.store(new Blob(['big'], { type: 'text/plain' })),
		}));
		const id = await insertMessage(t, mailboxId, folderId, {
			htmlBodyStorageId: htmlId,
			textBodyStorageId: textId,
		});
		const body = await t.query(api.mail.mailbox.messages.getMessageInlineBody, { messageId: id });
		expect(body).toEqual({
			htmlInline: null,
			textInline: null,
			hasHtmlBlob: true,
			hasTextBlob: true,
		});
	});

	it('returns null for a suspended mailbox and for a missing message', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, folderId } = await seedMailboxAndFolder(t, { status: 'suspended' });
		const id = await insertMessage(t, mailboxId, folderId, { htmlBodyInline: '<p>hidden</p>' });
		expect(
			await t.query(api.mail.mailbox.messages.getMessageInlineBody, { messageId: id })
		).toBeNull();
		await t.run((ctx) => ctx.db.delete(id));
		expect(
			await t.query(api.mail.mailbox.messages.getMessageInlineBody, { messageId: id })
		).toBeNull();
	});

	it("returns null to an editor reading someone else's personal mailbox", async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, folderId } = await seedMailboxAndFolder(t, { userId: 'someone-else' });
		const id = await insertMessage(t, mailboxId, folderId, { htmlBodyInline: '<p>theirs</p>' });
		vi.mocked(getBetterAuthSessionWithRole).mockResolvedValue({
			userId: 'test-user',
			role: 'editor',
			activeOrganizationId: 'test-org',
		});
		expect(
			await t.query(api.mail.mailbox.messages.getMessageInlineBody, { messageId: id })
		).toBeNull();
		expect(
			await t.action(api.mail.mailbox.messages.getMessageBodyBlobUrls, { messageId: id })
		).toBeNull();
	});
});

describe('mail.mailbox.messages.getMessageBodyBlobUrls', () => {
	it('mints URLs only for the blobs a message has', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, folderId } = await seedMailboxAndFolder(t);
		const htmlId = await t.run((ctx) =>
			ctx.storage.store(new Blob(['<p>big</p>'], { type: 'text/html' }))
		);
		const large = await insertMessage(t, mailboxId, folderId, { htmlBodyStorageId: htmlId });
		const largeUrls = await t.action(api.mail.mailbox.messages.getMessageBodyBlobUrls, {
			messageId: large,
		});
		expect(largeUrls?.htmlUrl).toBeTruthy();
		expect(largeUrls?.textUrl).toBeNull();

		const small = await insertMessage(t, mailboxId, folderId, { htmlBodyInline: '<p>s</p>' });
		expect(
			await t.action(api.mail.mailbox.messages.getMessageBodyBlobUrls, { messageId: small })
		).toEqual({ htmlUrl: null, textUrl: null });
	});

	it('fails closed for a sealed blob after key loss', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, folderId } = await seedMailboxAndFolder(t);
		vi.stubEnv('INSTANCE_SECRET', INSTANCE_SECRET);
		const sealedStorageId = await t.run((ctx) =>
			storeSealedBlob(ctx.storage, new TextEncoder().encode('<p>sealed</p>'), 'text/html')
		);
		const id = await insertMessage(t, mailboxId, folderId, { htmlBodyStorageId: sealedStorageId });
		vi.stubEnv('INSTANCE_SECRET', undefined);
		const urls = await t.action(api.mail.mailbox.messages.getMessageBodyBlobUrls, {
			messageId: id,
		});
		expect(urls).toEqual({ htmlUrl: null, textUrl: null });
	});
});

describe('mail.mailbox.messages.getMessage (deep-link fallback)', () => {
	it('returns the full message by id for the owner', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		const { mailboxId, folderId } = await seedMailboxAndFolder(t);
		const id = await insertMessage(t, mailboxId, folderId, { htmlBodyInline: '<p>hi</p>' });
		const msg = await t.query(api.mail.mailbox.messages.getMessage, { messageId: id });
		expect(msg?._id).toBe(id);
		expect(msg?.subject).toBe('s');
	});
});
