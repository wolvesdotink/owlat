/**
 * Scope change (`scopeChange.ts`): a personal mailbox turned team inbox drops
 * what brief mode produced and moves its threads to actions mode.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { threadRefToFields } from '../../../lib/validators/threadRef';
import { modules, reduceResult, seedMailThread, type Test } from './interpret.testlib';

const SENT = Date.UTC(2026, 9, 7, 9, 0);

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

async function seedBrief(t: Test) {
	const seeded = await seedMailThread(t);
	const { messageId, threadId } = seeded;
	await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
		source: { kind: 'mail', id: messageId },
		threadRef: { kind: 'mail', id: threadId },
		mode: 'brief',
		contentRevision: 'rev-1',
		extractorVersion: 1,
		expectedRevision: 0,
		deletionEpoch: 0,
		sourceAt: SENT,
		direction: 'inbound',
		status: 'complete',
		result: reduceResult({
			facts: [
				{
					key: '["contract","due",""]',
					assertion: 'The contract is due Friday',
					display: { en: 'Contract due Friday', de: 'Vertrag bis Freitag' },
					evidence: [{ segmentId: 's0', start: 0, end: 20, quote: 'send the signed contract' }],
					isVerified: true,
					isReviewNeeded: false,
				},
			],
		}),
	});
	await t.run(async (ctx) => {
		const ref = { kind: 'mail' as const, id: threadId };
		await ctx.db.insert('threadViewerState', {
			...threadRefToFields(ref),
			userId: 'user-A',
			viewOverride: 'overview',
			seenInterpretationRevision: 1,
			seenActivitySeq: 1,
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
			verdict: 'covered',
			createdAt: SENT,
			updatedAt: SENT,
		});
		const brief = await ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.first();
		await ctx.db.patch(brief!._id, {
			overview: { revision: 1, version: 1, generatedAt: SENT, en: 'sealed' },
		});
	});
	return seeded;
}

async function state(t: Test, threadId: Id<'mailThreads'>) {
	return t.run(async (ctx) => ({
		thread: await ctx.db.get(threadId),
		brief: await ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.first(),
		facts: await ctx.db
			.query('threadFacts')
			.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
			.collect(),
		items: await ctx.db
			.query('threadItems')
			.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', threadId))
			.collect(),
		interpretations: await ctx.db
			.query('messageInterpretations')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.collect(),
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

describe('scope change personal → shared', () => {
	it('drops brief-mode outputs and moves the thread to actions mode', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedBrief(t);
		const before = await state(t, threadId);
		expect(before.facts).toHaveLength(1);
		expect(before.thread?.briefTop).toMatchObject({ mode: 'brief', latest: expect.any(Object) });

		await t.run((ctx) => ctx.db.patch(mailboxId, { scope: 'shared' }));
		const out = await t.mutation(internal.mail.interpret.purgeJobs.invalidateMailboxThreads, {
			mailboxId,
			mode: 'actions',
			cursor: null,
		});
		expect(out).toEqual({ isDone: true, threads: 1 });

		const after = await state(t, threadId);
		expect(after.facts).toHaveLength(0);
		expect(after.interpretations).toHaveLength(0);
		expect(after.items).toHaveLength(1);
		expect(after.brief).toMatchObject({
			mode: 'actions',
			deletionEpoch: 1,
			interpretationRevision: 2,
			completeness: 'none',
		});
		expect(after.brief?.overview).toBeUndefined();
		expect(after.brief?.checkpoint).toBeUndefined();
		expect(after.viewers[0]?.viewOverride).toBeUndefined();
		expect(after.plans[0]?.verdict).toBe('stale');
		expect(after.thread?.briefTop).toMatchObject({ mode: 'actions', forYou: 1 });
		expect(after.thread?.briefTop?.latest).toBeUndefined();

		// A brief-mode run that loaded before the change cannot write back: the
		// reducer re-derives the mode and sends it back.
		const late = await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
			source: { kind: 'mail', id: messageId },
			threadRef: { kind: 'mail', id: threadId },
			mode: 'brief',
			contentRevision: 'rev-2',
			extractorVersion: 1,
			expectedRevision: 2,
			deletionEpoch: 0,
			sourceAt: SENT,
			direction: 'inbound',
			status: 'complete',
			result: reduceResult(),
		});
		expect(late).toEqual({ outcome: 'modeChanged' });
	});

	it('stops when the mailbox scope no longer matches the mode', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, threadId } = await seedBrief(t);
		const out = await t.mutation(internal.mail.interpret.purgeJobs.invalidateMailboxThreads, {
			mailboxId,
			mode: 'actions',
			cursor: null,
		});
		expect(out).toEqual({ isDone: true, threads: 0 });
		expect((await state(t, threadId)).facts).toHaveLength(1);
	});
});
