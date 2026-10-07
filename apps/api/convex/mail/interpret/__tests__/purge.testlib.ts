/**
 * Fixtures for the thread brief erasure tests (`purge*.test.ts`): items and
 * facts inserted the way the reducer writes them, a second message in a
 * thread, the Postbox purge sequence and a thread's brief rows. The
 * double-dot name keeps Convex from bundling it.
 */

import type { Doc, Id } from '../../../_generated/dataModel';
import type { MutationCtx } from '../../../_generated/server';
import { threadRefToFields, type ThreadRef } from '../../../lib/validators/threadRef';
import type { InterpretationSource } from '../../../lib/validators/threadBrief';
import { purgeMessageRow, purgeThreadBriefsOf, type PurgedMessages } from '../../messagePurge';
import { rebuildThreadAggregates } from '../../threadAggregates';
import { listBucketOf, recordItemChange } from '../counters';
import { reduceResult, type Test } from './interpret.testlib';

export const SENT = Date.UTC(2026, 9, 7, 9, 0);

export function evidence(source: InterpretationSource) {
	return { source, segmentId: 's0', start: 0, end: 4, contentRevision: 'rev-1', quote: 'sealed' };
}

export async function insertItem(
	ctx: MutationCtx,
	ref: ThreadRef,
	sources: InterpretationSource[],
	extra: Partial<Doc<'threadItems'>> = {}
): Promise<Id<'threadItems'>> {
	const row: Omit<Doc<'threadItems'>, '_id' | '_creationTime'> = {
		...threadRefToFields(ref),
		revision: 1,
		intent: 'request',
		facets: [],
		assertion: 'sealed',
		display: { en: 'sealed', de: 'sealed' },
		requester: { email: 'jonas@example.com', isUs: false },
		responsible: { isUs: true },
		responsibility: 'us',
		status: 'open',
		disposition: 'unanswered',
		evidence: sources.map(evidence),
		verify: 'passed',
		askedAt: SENT,
		createdAt: SENT,
		updatedAt: SENT,
		...extra,
	};
	// As the reducer: the list bucket and the brief's item counters move with the insert.
	const id = await ctx.db.insert('threadItems', { ...row, listBucket: listBucketOf(row) });
	await recordItemChange(ctx, ref, null, row);
	return id;
}

export async function insertFact(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	sources: InterpretationSource[],
	extra: Partial<Doc<'threadFacts'>> = {}
): Promise<Id<'threadFacts'>> {
	return ctx.db.insert('threadFacts', {
		threadKind: 'mail',
		mailThreadId: threadId,
		factKey: '["contract","due",""]',
		assertion: 'sealed',
		display: { en: 'sealed', de: 'sealed' },
		evidence: sources.map(evidence),
		provenance: 'reported',
		status: 'current',
		revision: 1,
		createdAt: SENT,
		updatedAt: SENT,
		...extra,
	});
}

/** A second message in the first one's thread. */
export async function addSibling(
	t: Test,
	messageId: Id<'mailMessages'>
): Promise<Id<'mailMessages'>> {
	return t.run(async (ctx) => {
		const { _id, _creationTime, ...first } = (await ctx.db.get(messageId))!;
		const id = await ctx.db.insert('mailMessages', {
			...first,
			uid: first.uid + 1,
			receivedAt: first.receivedAt + 60_000,
		});
		await ctx.db.patch(first.threadId, { messageCount: 2 });
		return id;
	});
}

export function applyArgs(messageId: Id<'mailMessages'>, threadId: Id<'mailThreads'>) {
	return {
		source: { kind: 'mail' as const, id: messageId },
		threadRef: { kind: 'mail' as const, id: threadId },
		mode: 'brief' as const,
		contentRevision: 'rev-1',
		extractorVersion: 1,
		expectedRevision: 0,
		deletionEpoch: 0,
		sourceAt: SENT,
		direction: 'inbound' as const,
		status: 'complete' as const,
		result: reduceResult(),
	};
}

/** Purge messages the way the Postbox paths do: rows, then briefs, then aggregates. */
export async function purgeMessages(t: Test, ids: Id<'mailMessages'>[]): Promise<void> {
	await t.run(async (ctx) => {
		const purged: PurgedMessages = new Map();
		const threads = new Set<Id<'mailThreads'>>();
		for (const id of ids) threads.add(await purgeMessageRow(ctx, (await ctx.db.get(id))!, purged));
		await purgeThreadBriefsOf(ctx, purged);
		for (const threadId of threads) await rebuildThreadAggregates(ctx, threadId);
	});
}

export async function mailRows(t: Test, threadId: Id<'mailThreads'>) {
	return t.run(async (ctx) => ({
		thread: await ctx.db.get(threadId),
		items: await ctx.db
			.query('threadItems')
			.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
			.collect(),
		facts: await ctx.db
			.query('threadFacts')
			.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
			.collect(),
		activity: await ctx.db
			.query('threadActivity')
			.withIndex('by_mail_thread_and_seq', (q) => q.eq('mailThreadId', threadId))
			.collect(),
		interpretations: await ctx.db
			.query('messageInterpretations')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.collect(),
		brief: await ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.first(),
		viewers: await ctx.db
			.query('threadViewerState')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.collect(),
		plans: await ctx.db
			.query('draftResponsePlans')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.collect(),
	}));
}

/** A discussion room message and a commitment that link `itemId`. */
export async function linkItem(
	ctx: MutationCtx,
	itemId: Id<'threadItems'>,
	at: { mailboxId: Id<'mailboxes'>; threadId: Id<'mailThreads'>; messageId: Id<'mailMessages'> }
) {
	const roomId = await ctx.db.insert('chatRooms', {
		kind: 'channel',
		purpose: 'mail_thread_discussion',
		linkedMailThreadId: at.threadId,
		name: 'Thread discussion',
		normalizedName: `mail-thread:${at.threadId}`,
		visibility: 'private',
		createdBy: 'user-A',
		createdAt: SENT,
		updatedAt: SENT,
		lastMessageAt: SENT,
		messageCount: 1,
	});
	const chatId = await ctx.db.insert('chatMessages', {
		roomId,
		authorId: 'user-A',
		text: 'on it',
		threadItemId: itemId,
		createdAt: SENT,
	});
	const commitmentId = await ctx.db.insert('mailCommitments', {
		mailboxId: at.mailboxId,
		threadId: at.threadId,
		messageId: at.messageId,
		direction: 'inbound',
		description: 'Send the contract',
		status: 'open',
		source: 'llm',
		threadItemId: itemId,
		createdAt: SENT,
		updatedAt: SENT,
	});
	return { chatId, commitmentId };
}
