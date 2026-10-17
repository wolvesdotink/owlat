/**
 * Fixtures for the learn lane tests (SPEC §4): live deliveries through the real
 * hosted MX path (arrival record, sender profile, projection), and readers for
 * the operation log.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../../../schema';
import type { Doc, Id } from '../../../_generated/dataModel';
import { modules } from '../../__tests__/helpers.testlib';
import { deliverHosted, type T } from '../../senders/__tests__/senders.testlib';

/**
 * A test deployment for these suites. Live deliveries schedule the classifier
 * and the arrival read, which take rate-limiter tokens, so the component is
 * registered.
 */
export function learnTest(opts: { transactionLimits?: boolean } = {}): T {
	const t = convexTest({ schema, modules, transactionLimits: opts.transactionLimits ?? false });
	rateLimiterTest.register(t);
	return t;
}

/**
 * `count` conversations from `address`, ONE message each, every one an Inbox
 * message with its arrival record (kind `other`, so placed `today` until the
 * sender's status says otherwise): the shape that makes a sender-wide re-sort
 * recompute one projection per message. Seeded in chunks outside any limit.
 */
export async function seedSenderThreads(
	t: T,
	mailboxId: Id<'mailboxes'>,
	folderId: Id<'mailFolders'>,
	count: number,
	address = 'news@shop.example'
): Promise<{ messageIds: Id<'mailMessages'>[]; threadIds: Id<'mailThreads'>[] }> {
	const messageIds: Id<'mailMessages'>[] = [];
	const threadIds: Id<'mailThreads'>[] = [];
	for (let start = 0; start < count; start += 50) {
		await t.run(async (ctx) => {
			const rawStorageId = await ctx.storage.store(new Blob(['raw']));
			for (let i = start; i < Math.min(count, start + 50); i++) {
				const at = 1_000_000 + i;
				const threadId = await ctx.db.insert('mailThreads', {
					mailboxId,
					normalizedSubject: `bulk ${i}`,
					participants: [address],
					messageCount: 1,
					unreadCount: 1,
					hasFlagged: false,
					hasAttachments: false,
					lastMessageAt: at,
					firstMessageAt: at,
					latestSnippet: 'bulk',
					latestFromAddress: address,
					latestSubject: `bulk ${i}`,
					folderRoles: ['inbox'],
					labelIds: [],
					createdAt: at,
					updatedAt: at,
				});
				const messageId = await ctx.db.insert('mailMessages', {
					mailboxId,
					folderId,
					uid: 10_000 + i,
					modseq: 1,
					rfc822MessageId: `<thread-${i}@shop.example>`,
					threadId,
					fromAddress: address,
					toAddresses: ['me@owlat.test'],
					ccAddresses: [],
					bccAddresses: [],
					subject: `bulk ${i}`,
					normalizedSubject: `bulk ${i}`,
					snippet: 'bulk',
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
					isOpenCounted: false,
					receivedAt: at,
					internalDate: at,
					createdAt: at,
					updatedAt: at,
				});
				await ctx.db.insert('mailArrivalRecords', {
					mailboxId,
					threadId,
					messageId,
					sourceKey: `mail:${messageId}`,
					sourceOrderKey: String(at).padStart(16, '0'),
					category: 'other',
					categorySource: 'heuristic',
					modelCalls: 0,
					reasonKeys: [],
					createdAt: at,
					updatedAt: at,
					expiresAt: at + 90 * 86_400_000,
				});
				messageIds.push(messageId);
				threadIds.push(threadId);
			}
		});
	}
	return { messageIds, threadIds };
}

export {
	OWNER,
	SENDER,
	deliverHosted,
	profileOf,
	roleOf,
	seedPersonalMailbox,
	seedProfile,
	seedSenderMessages,
	type T,
} from '../../senders/__tests__/senders.testlib';

/** The operation header and its change rows. */
export async function operationOf(t: T, operationId: Id<'mailArrivalOperations'>) {
	return await t.run(async (ctx) => ({
		operation: (await ctx.db.get(operationId))!,
		changes: await ctx.db
			.query('mailArrivalOperationChanges')
			.withIndex('by_operation', (q) => q.eq('operationId', operationId))
			.collect(),
	}));
}

/** Deliver one live message and return it with its thread. */
export async function deliverLive(
	t: T,
	opts: Parameters<typeof deliverHosted>[1] = {}
): Promise<{ message: Doc<'mailMessages'>; thread: Doc<'mailThreads'> }> {
	const id = await deliverHosted(t, opts);
	if (!id) throw new Error('delivery skipped');
	return await t.run(async (ctx) => {
		const message = (await ctx.db.get(id))!;
		return { message, thread: (await ctx.db.get(message.threadId))! };
	});
}

export async function threadOf(t: T, threadId: Id<'mailThreads'>): Promise<Doc<'mailThreads'>> {
	return await t.run(async (ctx) => (await ctx.db.get(threadId))!);
}

export async function messageOf(t: T, id: Id<'mailMessages'>): Promise<Doc<'mailMessages'>> {
	return await t.run(async (ctx) => (await ctx.db.get(id))!);
}

/** Patch a message's arrival record. */
export async function patchRecord(
	t: T,
	messageId: Id<'mailMessages'>,
	patch: Partial<Doc<'mailArrivalRecords'>>
): Promise<void> {
	await t.run(async (ctx) => {
		const record = await ctx.db
			.query('mailArrivalRecords')
			.withIndex('by_message', (q) => q.eq('messageId', messageId))
			.first();
		if (!record) throw new Error('no arrival record');
		await ctx.db.patch(record._id, patch);
	});
}
