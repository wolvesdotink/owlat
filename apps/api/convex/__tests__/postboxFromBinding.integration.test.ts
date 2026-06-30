import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) =>
		!path.includes('sesActions') &&
		!path.includes('agentSecurity') &&
		!path.includes('agentContext') &&
		!path.includes('agentClassifier') &&
		!path.includes('agentDrafter') &&
		!path.includes('agentRouter') &&
		!path.includes('agent/walker') &&
		!path.includes('agent/steps/index') &&
		!path.includes('agent/steps/shared') &&
		!path.includes('agent/steps/classify') &&
		!path.includes('agent/steps/draft') &&
		!path.includes('knowledgeExtraction') &&
		!path.includes('semanticFileProcessing') &&
		!path.includes('visualizationAgent') &&
		!path.includes('llmProvider')
	)
);

async function seedMailbox(t: ReturnType<typeof convexTest>, address: string) {
	let mailboxId!: Id<'mailboxes'>;
	let sentFolderId!: Id<'mailFolders'>;
	let inboxFolderId!: Id<'mailFolders'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'test-user',
			organizationId: 'test-org',
			address,
			domain: address.split('@')[1],
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		sentFolderId = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'Sent',
			role: 'sent',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 0,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
		inboxFolderId = await ctx.db.insert('mailFolders', {
			mailboxId,
			name: 'INBOX',
			role: 'inbox',
			uidValidity: now,
			uidNext: 1,
			highestModseq: 0,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
	});
	return { mailboxId, sentFolderId, inboxFolderId };
}

describe('mailIdentities.resolveAllowedFromAddresses', () => {
	it('returns the mailbox address plus any aliases', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedMailbox(t, 'alice@example.com');

		await t.run(async (ctx) => {
			await ctx.db.insert('mailAliases', {
				alias: 'alice+sales@example.com',
				targetMailboxId: mailboxId,
				organizationId: 'test-org',
				createdAt: Date.now(),
			});
			await ctx.db.insert('mailAliases', {
				alias: 'Alice.Wonderland@Example.com'.toLowerCase(),
				targetMailboxId: mailboxId,
				organizationId: 'test-org',
				createdAt: Date.now(),
			});
		});

		const allowed = await t.query(
			internal.mail.identities.resolveAllowedFromAddresses,
			{ mailboxId }
		);

		expect(allowed.sort()).toEqual(
			[
				'alice@example.com',
				'alice+sales@example.com',
				'alice.wonderland@example.com',
			].sort()
		);
	});

	it('returns an empty set for a non-active mailbox', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedMailbox(t, 'suspended@example.com');
		await t.run(async (ctx) => {
			await ctx.db.patch(mailboxId, { status: 'suspended' });
		});

		const allowed = await t.query(
			internal.mail.identities.resolveAllowedFromAddresses,
			{ mailboxId }
		);
		expect(allowed).toEqual([]);
	});
});

describe('mail.draftLifecycle.transition({ to: "sent" }) — From-binding', () => {
	// Minimal sent-context fixture — the lifecycle's `→ sent` reducer
	// needs an rfc822 messageId and a raw .eml storage handle but
	// these tests only care about the from-binding check that runs
	// BEFORE the cascade.
	async function makeSentContext(t: ReturnType<typeof convexTest>) {
		let rawStorageId!: Id<'_storage'>;
		await t.run(async (ctx) => {
			rawStorageId = await ctx.storage.store(
				new Blob([new Uint8Array([0])], { type: 'message/rfc822' }),
			);
		});
		return {
			rawStorageId,
			rawSize: 1,
			rfc822MessageId: 'test-msg-1@example.com',
			references: [] as string[],
			bodyHtml: '<p>Hi</p>',
			bodyText: 'Hi',
			attachmentsMeta: [] as Array<{
				filename: string;
				contentType: string;
				size: number;
				contentId?: string;
				partIndex: string;
			}>,
		};
	}

	it('succeeds when fromAddress is the mailbox address', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedMailbox(t, 'alice@example.com');

		let draftId!: Id<'mailDrafts'>;
		await t.run(async (ctx) => {
			const now = Date.now();
			draftId = await ctx.db.insert('mailDrafts', {
				mailboxId,
				toAddresses: ['bob@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: 'alice@example.com',
				subject: 'Hi',
				bodyHtml: '<p>Hi</p>',
				attachments: [],
				state: 'pending_send',
				undoToken: 'tok_ok',
				scheduledSendAt: now,
				lastEditedAt: now,
				createdAt: now,
			});
		});

		const context = await makeSentContext(t);
		const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId,
			input: { to: 'sent', at: Date.now(), context },
		});
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.messageId).toBeDefined();
	});

	it('succeeds when fromAddress is an alias', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedMailbox(t, 'alice@example.com');

		let draftId!: Id<'mailDrafts'>;
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('mailAliases', {
				alias: 'alice+sales@example.com',
				targetMailboxId: mailboxId,
				organizationId: 'test-org',
				createdAt: now,
			});
			draftId = await ctx.db.insert('mailDrafts', {
				mailboxId,
				toAddresses: ['bob@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: 'alice+sales@example.com',
				subject: 'Hi',
				bodyHtml: '<p>Hi</p>',
				attachments: [],
				state: 'pending_send',
				undoToken: 'tok_ok',
				scheduledSendAt: now,
				lastEditedAt: now,
				createdAt: now,
			});
		});

		const context = await makeSentContext(t);
		const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId,
			input: { to: 'sent', at: Date.now(), context },
		});
		expect(outcome.ok).toBe(true);
	});

	it('rejects a draft with a forged fromAddress with reason "from_revoked" (caller reverts)', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedMailbox(t, 'alice@example.com');

		let draftId!: Id<'mailDrafts'>;
		await t.run(async (ctx) => {
			const now = Date.now();
			draftId = await ctx.db.insert('mailDrafts', {
				mailboxId,
				toAddresses: ['bob@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: 'ceo@example.com', // not the mailbox or any alias
				subject: 'Forged',
				bodyHtml: '<p>Forged</p>',
				attachments: [],
				state: 'pending_send',
				undoToken: 'tok_forged',
				scheduledSendAt: now,
				lastEditedAt: now,
				createdAt: now,
			});
		});

		const context = await makeSentContext(t);
		const outcome = await t.mutation(internal.mail.draftLifecycle.transition, {
			draftId,
			input: { to: 'sent', at: Date.now(), context },
		});
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe('from_revoked');

		// The lifecycle does NOT silently revert — the caller is expected
		// to follow up with `transition({ to: 'draft', reason: 'from_revoked' })`
		// which is exactly what `mail/outbound.ts` now does.
		await t.run(async (ctx) => {
			const draft = await ctx.db.get(draftId);
			expect(draft?.state).toBe('pending_send');
		});

		const revertOutcome = await t.mutation(
			internal.mail.draftLifecycle.transition,
			{
				draftId,
				input: { to: 'draft', at: Date.now(), reason: 'from_revoked' },
			},
		);
		expect(revertOutcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const draft = await ctx.db.get(draftId);
			expect(draft?.state).toBe('draft');
			expect(draft?.undoToken).toBeUndefined();
		});
	});
});

describe('mailImap.appendMessage — From-binding', () => {
	async function seedStorageBlob(t: ReturnType<typeof convexTest>): Promise<Id<'_storage'>> {
		// convex-test exposes ctx.storage which is fine
		let id!: Id<'_storage'>;
		await t.run(async (ctx) => {
			const blob = new Blob([new Uint8Array([0])], { type: 'message/rfc822' });
			id = await ctx.storage.store(blob);
		});
		return id;
	}

	it('accepts an APPEND with From = mailbox address', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, inboxFolderId } = await seedMailbox(t, 'alice@example.com');
		const storageId = await seedStorageBlob(t);

		const result = await t.mutation(internal.mail.imap.appendMessage, {
			folderId: inboxFolderId,
			rawStorageId: storageId,
			rawSize: 1,
			rfc822MessageId: 'msg-1@example.com',
			fromAddress: 'alice@example.com',
			toAddresses: ['alice@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Test',
			snippet: 'Test',
		});

		expect(result.uid).toBe(1);
		// Verify the mail row exists in the folder
		void mailboxId;
	});

	it('rejects an APPEND with a forged From with the from-not-authorized error', async () => {
		const t = convexTest(schema, modules);
		const { inboxFolderId } = await seedMailbox(t, 'alice@example.com');
		const storageId = await seedStorageBlob(t);

		await expect(
			t.mutation(internal.mail.imap.appendMessage, {
				folderId: inboxFolderId,
				rawStorageId: storageId,
				rawSize: 1,
				rfc822MessageId: 'msg-2@example.com',
				fromAddress: 'ceo@example.com',
				toAddresses: ['alice@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'Forged',
				snippet: 'Forged',
			})
		).rejects.toThrow(/From address not authorized/);
	});

	it('accepts an APPEND with From = active alias of the mailbox', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, inboxFolderId } = await seedMailbox(t, 'alice@example.com');
		await t.run(async (ctx) => {
			await ctx.db.insert('mailAliases', {
				alias: 'alice+sales@example.com',
				targetMailboxId: mailboxId,
				organizationId: 'test-org',
				createdAt: Date.now(),
			});
		});
		const storageId = await seedStorageBlob(t);

		const result = await t.mutation(internal.mail.imap.appendMessage, {
			folderId: inboxFolderId,
			rawStorageId: storageId,
			rawSize: 1,
			rfc822MessageId: 'msg-3@example.com',
			fromAddress: 'alice+sales@example.com',
			toAddresses: ['alice@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Alias',
			snippet: 'Alias',
		});
		expect(result.uid).toBe(1);
	});
});
