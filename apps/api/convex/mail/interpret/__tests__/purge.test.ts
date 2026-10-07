/**
 * Thread brief erasure against a real (convex-test) database: a purged
 * message takes its extractions, evidence, evidence-less claims, activity and
 * links with it and blocks in-flight runs (`purge.ts`); a deleted thread takes
 * all seven tables (`purgeThread.ts`); a Team Inbox message does the same in
 * its thread.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Doc, Id } from '../../../_generated/dataModel';
import type { MutationCtx } from '../../../_generated/server';
import { threadRefToFields, type ThreadRef } from '../../../lib/validators/threadRef';
import type { InterpretationSource } from '../../../lib/validators/threadBrief';
import { purgeMessageRow, purgeThreadBriefsOf, type PurgedMessages } from '../../messagePurge';
import { rebuildThreadAggregates } from '../../threadAggregates';
import { completenessOfRows, purgeSourcesFromThread } from '../purge';
import { completenessOf } from '../reduceState';
import { purgeThreadBrief } from '../purgeThread';
import { seedFolder } from '../../__tests__/helpers.testlib';
import {
	modules,
	reduceResult,
	seedMailThread,
	seedTeamThread,
	type Test,
} from './interpret.testlib';

const SENT = Date.UTC(2026, 9, 7, 9, 0);

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

function evidence(source: InterpretationSource) {
	return { source, segmentId: 's0', start: 0, end: 4, contentRevision: 'rev-1', quote: 'sealed' };
}

async function insertItem(
	ctx: MutationCtx,
	ref: ThreadRef,
	sources: InterpretationSource[],
	extra: Partial<Doc<'threadItems'>> = {}
): Promise<Id<'threadItems'>> {
	return ctx.db.insert('threadItems', {
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
	});
}

async function insertFact(
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
async function addSibling(t: Test, messageId: Id<'mailMessages'>): Promise<Id<'mailMessages'>> {
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

function applyArgs(messageId: Id<'mailMessages'>, threadId: Id<'mailThreads'>) {
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
async function purgeMessages(t: Test, ids: Id<'mailMessages'>[]): Promise<void> {
	await t.run(async (ctx) => {
		const purged: PurgedMessages = new Map();
		const threads = new Set<Id<'mailThreads'>>();
		for (const id of ids) threads.add(await purgeMessageRow(ctx, (await ctx.db.get(id))!, purged));
		await purgeThreadBriefsOf(ctx, purged);
		for (const threadId of threads) await rebuildThreadAggregates(ctx, threadId);
	});
}

async function mailRows(t: Test, threadId: Id<'mailThreads'>) {
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
async function linkItem(
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

describe('message purge', () => {
	it('drops the purged message’s evidence, claims, activity and links', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		const b = await addSibling(t, a);
		const ref = { kind: 'mail' as const, id: threadId };
		const srcA = { kind: 'mail' as const, id: a };
		const srcB = { kind: 'mail' as const, id: b };

		// The reducer writes A's item, extraction, activity and the brief.
		await t.mutation(internal.mail.interpret.reduce.applyInterpretation, applyArgs(a, threadId));
		const seeded = await t.run(async (ctx) => {
			const onlyA = (await ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
				.first())!._id;
			const both = await insertItem(ctx, ref, [srcA, srcB]);
			const replacement = await insertItem(ctx, ref, [srcA]);
			const replaced = await insertItem(ctx, ref, [srcB], {
				status: 'superseded',
				replacedById: replacement,
				possibleDuplicateOfId: onlyA,
			});
			const oldFact = await insertFact(ctx, threadId, [srcB], { status: 'superseded' });
			const newFact = await insertFact(ctx, threadId, [srcA], { supersedesId: oldFact });
			const opActivity = await ctx.db.insert('threadActivity', {
				...threadRefToFields(ref),
				seq: 99,
				idempotencyKey: `mail:${threadId}|send:${a}`,
				type: 'reply_sent',
				actor: { kind: 'user', id: 'user-A' },
				provenance: 'recorded',
				visibility: 'substance',
				opRef: { kind: 'outbound', id: a },
				eventAt: SENT,
				recordedAt: SENT,
			});
			const links = await linkItem(ctx, onlyA, { mailboxId, threadId, messageId: b });
			const planId = await ctx.db.insert('draftResponsePlans', {
				...threadRefToFields(ref),
				draftKind: 'mailDraft',
				threadRevision: 1,
				itemRevisions: [
					{ itemId: onlyA, revision: 1 },
					{ itemId: both, revision: 1 },
				],
				stances: [
					{ itemId: onlyA, stance: 'answer', source: 'default' },
					{ itemId: both, stance: 'answer', source: 'default' },
				],
				ownerInputs: [{ questionId: 'q1', itemId: onlyA }],
				coverage: [{ itemId: onlyA, spans: [], verdict: 'addressed' }],
				newPromises: [],
				fileClaims: [],
				draftHash: 'h',
				verdict: 'covered',
				createdAt: SENT,
				updatedAt: SENT,
			});
			return { onlyA, both, replacement, replaced, oldFact, newFact, opActivity, planId, ...links };
		});
		expect((await mailRows(t, threadId)).thread?.briefTop?.latest).toBeDefined();

		await purgeMessages(t, [a]);

		const after = await mailRows(t, threadId);
		expect(after.thread).not.toBeNull();
		expect(after.interpretations).toHaveLength(0);
		// A's reducer activity (received, item opened) and the send naming it are gone.
		expect(after.activity).toHaveLength(0);
		const ids = after.items.map((i) => i._id);
		expect(ids).not.toContain(seeded.onlyA);
		expect(ids).not.toContain(seeded.replacement);
		const both = after.items.find((i) => i._id === seeded.both)!;
		expect(both.evidence.map((e) => e.source.id)).toEqual([b]);
		expect(both.revision).toBe(2);
		const replaced = after.items.find((i) => i._id === seeded.replaced)!;
		expect(replaced).toMatchObject({ status: 'open' });
		expect(replaced.replacedById).toBeUndefined();
		expect(replaced.possibleDuplicateOfId).toBeUndefined();
		expect(after.facts.map((f) => [f._id, f.status])).toEqual([[seeded.oldFact, 'current']]);
		expect(after.plans[0]).toMatchObject({
			verdict: 'stale',
			itemRevisions: [{ itemId: seeded.both, revision: 1 }],
			stances: [{ itemId: seeded.both }],
			ownerInputs: [{ questionId: 'q1' }],
			coverage: [],
		});
		expect(after.brief).toMatchObject({
			deletionEpoch: 1,
			interpretationRevision: 2,
			completeness: 'none',
		});
		expect(after.brief?.checkpoint).toBeUndefined();
		expect(after.thread?.briefTop).toMatchObject({
			forYou: 2,
			top: { itemId: expect.any(String) },
		});
		expect(after.thread?.briefTop?.latest).toBeUndefined();
		await t.run(async (ctx) => {
			expect((await ctx.db.get(seeded.chatId))?.threadItemId).toBeUndefined();
			expect((await ctx.db.get(seeded.commitmentId))?.threadItemId).toBeUndefined();
		});
	});

	it('makes an in-flight interpretation with the old epoch come back erased', async () => {
		const t = convexTest(schema, modules);
		const { messageId: a, threadId } = await seedMailThread(t);
		const b = await addSibling(t, a);
		await t.mutation(internal.mail.interpret.reduce.applyInterpretation, applyArgs(a, threadId));
		const loaded = (await mailRows(t, threadId)).brief!;

		await purgeMessages(t, [a]);

		const late = await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
			...applyArgs(b, threadId),
			expectedRevision: loaded.interpretationRevision + 1,
			deletionEpoch: loaded.deletionEpoch,
		});
		expect(late).toEqual({ outcome: 'erased' });
		expect((await mailRows(t, threadId)).items).toHaveLength(0);
	});

	it('runs on the trash auto-purge too', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId: a, threadId } = await seedMailThread(t);
		const b = await addSibling(t, a);
		await t.mutation(internal.mail.interpret.reduce.applyInterpretation, applyArgs(a, threadId));
		const trash = await seedFolder(t, mailboxId, 'trash');
		await t.run(async (ctx) => {
			await ctx.db.patch(a, { folderId: trash, trashedAt: 1 });
			const mailbox = (await ctx.db.get(mailboxId))!;
			await ctx.db.insert('mailUserSettings', {
				userId: mailbox.userId!,
				autoAdvance: 'next',
				trashAutoPurgeDays: 7,
				createdAt: SENT,
				updatedAt: SENT,
			});
		});

		const out = await t.mutation(internal.mail.trashRetention.sweepExpiredTrash, {});
		expect(out.purged).toBe(1);
		const after = await mailRows(t, threadId);
		expect(after.items).toHaveLength(0);
		expect(after.interpretations).toHaveLength(0);
		expect(after.brief?.deletionEpoch).toBe(1);
		expect(await t.run((ctx) => ctx.db.get(b))).not.toBeNull();
	});
});

describe('thread purge', () => {
	it('deletes every thread brief table when the last message goes', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedMailThread(t);
		const ref = { kind: 'mail' as const, id: threadId };
		await t.mutation(
			internal.mail.interpret.reduce.applyInterpretation,
			applyArgs(messageId, threadId)
		);
		const links = await t.run(async (ctx) => {
			const itemId = (await ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
				.first())!._id;
			await insertFact(ctx, threadId, [{ kind: 'mail', id: messageId }]);
			await ctx.db.insert('threadViewerState', {
				...threadRefToFields(ref),
				userId: 'user-A',
				viewOverride: 'conversation',
				seenInterpretationRevision: 1,
				seenActivitySeq: 2,
				updatedAt: SENT,
			});
			await ctx.db.insert('draftResponsePlans', {
				...threadRefToFields(ref),
				draftKind: 'mailDraft',
				threadRevision: 1,
				itemRevisions: [],
				stances: [],
				ownerInputs: [],
				coverage: [],
				newPromises: [],
				fileClaims: [],
				draftHash: 'h',
				verdict: 'pending',
				createdAt: SENT,
				updatedAt: SENT,
			});
			// The discussion message and the commitment outlive the item; only their links go.
			const links = await linkItem(ctx, itemId, { mailboxId, threadId, messageId });
			await ctx.db.insert('threadItemCorrections', {
				...threadRefToFields(ref),
				itemId,
				itemRevision: 1,
				kind: 'notARequest',
				userId: 'user-A',
				intent: 'request',
				facets: [],
				responsibility: 'us',
				verify: 'passed',
				evidenceSources: [{ sourceKey: `mail:${messageId}`, contentRevision: 'rev-1' }],
				createdAt: SENT,
			});
			await ctx.db.insert('noteReactions', {
				...threadRefToFields(ref),
				noteSource: 'chatMessage',
				chatMessageId: links.chatId,
				userId: 'user-A',
				emoji: '👍',
				createdAt: SENT,
			});
			return links;
		});

		await purgeMessages(t, [messageId]);

		const after = await mailRows(t, threadId);
		expect(after.thread).toBeNull();
		expect(after.items).toHaveLength(0);
		expect(after.facts).toHaveLength(0);
		expect(after.activity).toHaveLength(0);
		expect(after.interpretations).toHaveLength(0);
		expect(after.brief).toBeNull();
		expect(after.viewers).toHaveLength(0);
		expect(after.plans).toHaveLength(0);
		await t.run(async (ctx) => {
			expect(await ctx.db.query('threadItemCorrections').collect()).toHaveLength(0);
			expect(await ctx.db.query('noteReactions').collect()).toHaveLength(0);
			expect((await ctx.db.get(links.chatId))?.threadItemId).toBeUndefined();
			expect((await ctx.db.get(links.commitmentId))?.threadItemId).toBeUndefined();
		});
	});

	it('hands what does not fit inline to the scheduled drain', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		const ref = { kind: 'mail' as const, id: threadId };
		await t.mutation(
			internal.mail.interpret.reduce.applyInterpretation,
			applyArgs(messageId, threadId)
		);
		await t.run(async (ctx) => {
			for (let i = 0; i < 5; i++) await insertItem(ctx, ref, [{ kind: 'mail', id: messageId }]);
			await purgeThreadBrief(ctx, ref, 2);
		});
		const before = await mailRows(t, threadId);
		expect(before.brief?.deletionEpoch).toBe(1);
		expect(before.items.length).toBeGreaterThan(0);

		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const after = await mailRows(t, threadId);
		expect(after.items).toHaveLength(0);
		expect(after.activity).toHaveLength(0);
		expect(after.interpretations).toHaveLength(0);
		expect(after.brief).toBeNull();
	});
});

describe('team message purge', () => {
	it('drops the message’s evidence and unlinks the notes about deleted items', async () => {
		const t = convexTest(schema, modules);
		const { threadId, inboundId } = await seedTeamThread(t);
		const ref = { kind: 'team' as const, id: threadId };
		const src = { kind: 'inbound' as const, id: inboundId };
		const seeded = await t.run(async (ctx) => {
			const { _id, _creationTime, ...first } = (await ctx.db.get(inboundId))!;
			const other = {
				kind: 'inbound' as const,
				id: await ctx.db.insert('inboundMessages', { ...first, messageId: '<second@example.com>' }),
			};
			const gone = await insertItem(ctx, ref, [src]);
			const kept = await insertItem(ctx, ref, [src, other]);
			const noteId = await ctx.db.insert('threadNotes', {
				threadId,
				authorId: 'user-A',
				body: 'checking the refund',
				mentionedUserIds: [],
				threadItemId: gone,
				createdAt: SENT,
			});
			await ctx.db.insert('threadActivity', {
				...threadRefToFields(ref),
				seq: 1,
				idempotencyKey: `team:${threadId}|claim:${gone}`,
				type: 'item_claimed',
				actor: { kind: 'user', id: 'user-A' },
				provenance: 'recorded',
				visibility: 'housekeeping',
				itemId: gone,
				eventAt: SENT,
				recordedAt: SENT,
			});
			await ctx.db.insert('threadItemCorrections', {
				...threadRefToFields(ref),
				itemId: gone,
				itemRevision: 1,
				kind: 'notARequest',
				userId: 'user-A',
				intent: 'request',
				facets: [],
				responsibility: 'us',
				verify: 'passed',
				evidenceSources: [],
				createdAt: SENT,
			});
			await ctx.db.insert('threadActivity', {
				...threadRefToFields(ref),
				seq: 2,
				idempotencyKey: `team:${threadId}|send_queued:${inboundId}:${SENT}`,
				type: 'send_queued',
				actor: { kind: 'user', id: 'user-A' },
				provenance: 'recorded',
				visibility: 'substance',
				eventAt: SENT,
				recordedAt: SENT,
			});
			await purgeSourcesFromThread(ctx, ref, [src]);
			return { gone, kept, noteId };
		});
		await t.run(async (ctx) => {
			expect(await ctx.db.get(seeded.gone)).toBeNull();
			expect((await ctx.db.get(seeded.kept))?.evidence).toHaveLength(1);
			const note = await ctx.db.get(seeded.noteId);
			expect(note).not.toBeNull();
			expect(note?.threadItemId).toBeUndefined();
			const activity = await ctx.db
				.query('threadActivity')
				.withIndex('by_conversation_thread_and_seq', (q) => q.eq('conversationThreadId', threadId))
				.collect();
			expect(activity).toHaveLength(0);
			expect(await ctx.db.query('threadItemCorrections').collect()).toHaveLength(0);
		});
	});
});

describe('completenessOfRows', () => {
	it('agrees with the reducer’s completenessOf', () => {
		const row = (sourceKey: string, status: string, updatedAt: number, skipReason?: string) =>
			({ sourceKey, status, updatedAt, ...(skipReason ? { skipReason } : {}) }) as never;
		const cases = [
			[],
			[row('mail:a', 'complete', 1)],
			[row('mail:a', 'failed', 1), row('mail:a', 'complete', 2)],
			[row('mail:a', 'complete', 1), row('mail:b', 'partial', 1)],
			[row('mail:a', 'skipped', 1, 'undecryptable')],
			[row('mail:a', 'skipped', 1, 'short'), row('mail:b', 'complete', 3)],
		];
		for (const rows of cases) expect(completenessOfRows(rows)).toBe(completenessOf(rows));
	});
});
