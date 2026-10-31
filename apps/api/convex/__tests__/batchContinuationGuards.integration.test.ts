/**
 * A provider batch result is kept only if the live extraction
 * path would still read its source now (Sol r2 F1): the batch was out for up to
 * a day. Postbox mail moved to Trash or Spam meanwhile, a Team message the
 * guard has since held back, or `ai.knowledge` switched off: the item still
 * writes its row and settles (it was billed), and the result is dropped. The
 * mail resume rechecks the same guards and drops the result when one refuses.
 */

import { describe, expect, it } from 'vitest';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { newHarness } from './testModules';
import { createTestInboundMessage, enableFeatures } from './factories';
import { batchItemKey } from '../lib/aiRouting/batchConsumers';

type T = ReturnType<typeof newHarness>;
type MailRole = 'inbox' | 'trash' | 'spam';

const ENTRIES = [
	{ type: 'fact' as const, title: 'Move', content: 'Ana moves in May.', confidence: 0.9 },
];
const BODY = 'We are moving to the new office on the first of May; please update the address.';

/** A Postbox message in `role`, with a folder of each other role to move it to. */
async function seedMail(t: T): Promise<{
	mailMessageId: Id<'mailMessages'>;
	folders: Record<MailRole, Id<'mailFolders'>>;
}> {
	return t.run(async (ctx) => {
		const now = Date.now();
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user-A',
			organizationId: 'org-1',
			address: 'me@example.com',
			domain: 'example.com',
			status: 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		const folders = {} as Record<MailRole, Id<'mailFolders'>>;
		for (const role of ['inbox', 'trash', 'spam'] as const) {
			folders[role] = await ctx.db.insert('mailFolders', {
				mailboxId,
				name: role,
				role,
				uidValidity: now,
				uidNext: 1,
				highestModseq: 0,
				totalCount: 0,
				unseenCount: 0,
				subscribed: true,
				createdAt: now,
				updatedAt: now,
			});
		}
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId,
			normalizedSubject: 'move',
			participants: ['ana@example.com'],
			messageCount: 1,
			unreadCount: 1,
			hasFlagged: false,
			hasAttachments: false,
			lastMessageAt: now,
			firstMessageAt: now,
			latestSnippet: 'move',
			latestFromAddress: 'ana@example.com',
			latestSubject: 'We are moving',
			folderRoles: ['inbox'],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});
		const mailMessageId = await ctx.db.insert('mailMessages', {
			mailboxId,
			folderId: folders.inbox,
			uid: 1,
			modseq: 1,
			rfc822MessageId: '<move@example.com>',
			threadId,
			fromAddress: 'ana@example.com',
			toAddresses: ['me@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'We are moving',
			normalizedSubject: 'move',
			snippet: 'move',
			textBodyInline: BODY,
			rawStorageId: await ctx.storage.store(new Blob(['raw'])),
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
			receivedAt: now,
			internalDate: now,
			createdAt: now,
			updatedAt: now,
		} as never);
		return { mailMessageId, folders };
	});
}

async function seedItem(
	t: T,
	consumer: Doc<'llmBatchItems'>['consumer'],
	sourceId: string
): Promise<Id<'llmBatchItems'>> {
	return t.run(async (ctx) => {
		const now = Date.now();
		return ctx.db.insert('llmBatchItems', {
			itemKey: batchItemKey(consumer, sourceId),
			consumer,
			sourceId,
			task: 'knowledge.extract',
			provider: 'openai-native',
			modelId: 'gpt-6-luna',
			requestId: `req-${sourceId}`,
			rootRequestId: `root:${sourceId}`,
			policyVersion: 1,
			requestBoundMicrousd: 5_000,
			status: 'submitted',
			providerBatchId: 'batch_1',
			nextPollAt: now,
			expiresAt: now + 60_000,
			createdAt: now,
			updatedAt: now,
		});
	});
}

const complete = (t: T, itemId: Id<'llmBatchItems'>) =>
	t.mutation(internal.aiRouting.batchItems.completeItem, {
		itemId,
		outcome: 'succeeded',
		request: {
			attempt: 1,
			latencyMs: 1,
			usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
		},
		entries: ENTRIES,
	});

const markers = (t: T) => t.run((c) => c.db.query('knowledgeExtractionProgress').collect());
const rows = (t: T) => t.run((c) => c.db.query('llmUsageEvents').collect());
const continuations = async (t: T) =>
	(await t.run((c) => c.db.system.query('_scheduled_functions').collect())).filter((job) =>
		job.name.startsWith('knowledge/')
	);

describe('a batch result is kept only where the live path would read the source', () => {
	it('keeps mail still in an extractable folder: the marker, and the resume', async () => {
		const t = newHarness();
		await enableFeatures(t, ['ai.knowledge']);
		const { mailMessageId } = await seedMail(t);
		const itemId = await seedItem(t, 'knowledge_mail', mailMessageId);

		expect(await complete(t, itemId)).toBe(true);

		expect(await markers(t)).toEqual([
			expect.objectContaining({ sourceType: 'email', status: 'in_progress', entries: ENTRIES }),
		]);
		expect((await continuations(t)).map((job) => job.name)).toEqual([
			'knowledge/batchedMail:resumeMailExtraction',
		]);
	});

	it.each(['trash', 'spam'] as const)(
		'drops the result of mail moved to %s while its batch was out, still billed and settled',
		async (role) => {
			const t = newHarness();
			await enableFeatures(t, ['ai.knowledge']);
			const { mailMessageId, folders } = await seedMail(t);
			const itemId = await seedItem(t, 'knowledge_mail', mailMessageId);
			await t.run((c) => c.db.patch(mailMessageId, { folderId: folders[role] }));

			expect(await complete(t, itemId)).toBe(true);

			expect((await t.run((c) => c.db.get(itemId)))?.status).toBe('completed');
			expect(await rows(t)).toEqual([expect.objectContaining({ totalTokens: 120 })]);
			expect(await markers(t)).toHaveLength(0);
			expect(await continuations(t)).toHaveLength(0);
		}
	);

	it('drops a result while ai.knowledge is off', async () => {
		const t = newHarness();
		const { mailMessageId } = await seedMail(t);
		const itemId = await seedItem(t, 'knowledge_mail', mailMessageId);

		expect(await complete(t, itemId)).toBe(true);

		expect(await rows(t)).toHaveLength(1);
		expect(await markers(t)).toHaveLength(0);
		expect(await continuations(t)).toHaveLength(0);
	});

	it('drops the result of a Team message the guard has since held back', async () => {
		const t = newHarness();
		await enableFeatures(t, ['ai.knowledge']);
		const { threadId: _thread, contactId: _contact, ...message } = createTestInboundMessage();
		const messageId = await t.run((c) =>
			c.db.insert('inboundMessages', { ...message, processingStatus: 'quarantined' } as never)
		);
		const itemId = await seedItem(t, 'knowledge_message', messageId);

		expect(await complete(t, itemId)).toBe(true);

		expect(await rows(t)).toHaveLength(1);
		expect(await markers(t)).toHaveLength(0);
		expect(await continuations(t)).toHaveLength(0);
	});
});

describe('the mail resume rechecks the live guards', () => {
	it.each(['trash', 'spam'] as const)(
		'drops the marker of mail moved to %s after the result was kept, and extracts nothing',
		async (role) => {
			const t = newHarness();
			await enableFeatures(t, ['ai.knowledge']);
			const { mailMessageId, folders } = await seedMail(t);
			const itemId = await seedItem(t, 'knowledge_mail', mailMessageId);
			await complete(t, itemId);
			await t.run((c) => c.db.patch(mailMessageId, { folderId: folders[role] }));
			await t.action(internal.knowledge.batchedMail.resumeMailExtraction, { mailMessageId });

			expect(await markers(t)).toHaveLength(0);
			expect(await t.run((c) => c.db.query('knowledgeEntries').collect())).toHaveLength(0);
		}
	);

	it('resolves the sender of kept mail to a contact before it resumes', async () => {
		const t = newHarness();
		await enableFeatures(t, ['ai.knowledge']);
		const { mailMessageId } = await seedMail(t);
		await complete(t, await seedItem(t, 'knowledge_mail', mailMessageId));

		await t.action(internal.knowledge.batchedMail.resumeMailExtraction, { mailMessageId });

		const contacts = await t.run((c) => c.db.query('contacts').collect());
		expect(contacts.map((contact) => contact.email)).toEqual(['ana@example.com']);
	});

	it('drops the marker of mail whose sender resolves to no contact, and creates none', async () => {
		const t = newHarness();
		await enableFeatures(t, ['ai.knowledge']);
		const { mailMessageId } = await seedMail(t);
		await complete(t, await seedItem(t, 'knowledge_mail', mailMessageId));
		await t.run((c) => c.db.patch(mailMessageId, { fromAddress: 'not-an-address' }));
		const contactsBefore = await t.run((c) => c.db.query('contacts').collect());

		await t.action(internal.knowledge.batchedMail.resumeMailExtraction, { mailMessageId });

		expect(await markers(t)).toHaveLength(0);
		expect(await t.run((c) => c.db.query('knowledgeEntries').collect())).toHaveLength(0);
		expect(await t.run((c) => c.db.query('contacts').collect())).toHaveLength(
			contactsBefore.length
		);
	});

	it('drops the marker once ai.knowledge went off', async () => {
		const t = newHarness();
		await enableFeatures(t, ['ai.knowledge']);
		const { mailMessageId } = await seedMail(t);
		await complete(t, await seedItem(t, 'knowledge_mail', mailMessageId));
		await t.run(async (c) => {
			for (const row of await c.db.query('featureFlagSettings').collect()) {
				await c.db.patch(row._id, { featureFlags: { ...row.featureFlags, 'ai.knowledge': false } });
			}
			for (const row of await c.db.query('instanceSettings').collect()) {
				await c.db.patch(row._id, {
					featureFlags: { ...row.featureFlags, 'ai.knowledge': false },
				});
			}
		});
		expect(await t.query(internal.mail.migrationIndexing.isKnowledgeEnabled, {})).toBe(false);

		await t.action(internal.knowledge.batchedMail.resumeMailExtraction, { mailMessageId });

		expect(await markers(t)).toHaveLength(0);
	});
});
