/**
 * Read on arrival, Sol review r1 (F1–F8, F12, F13): each case fails without
 * its fix.
 *
 *   F1  a D10-deferred source stays deferred through its category write
 *   F2  eager demand reads a gisted source in full; the full-read prerequisite
 *       upgrades a thread's gist-only mail, oldest first, and the plan says so
 *   F3  eager work over the owner limit persists its continuation
 *   F4  admission comes before any predecessor read
 *   F5  a late settlement after a team-inbox conversion writes nothing
 *   F6  a gist read from an earlier body never commits
 *   F7  grounding accepts only offered segments and characters
 *   F8  an upgrade updates the record and the projection
 *   F12 a transient gist failure retries on retry.ts's schedule
 *   F13 a refused hold counts in the refusing mutation
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { enableFeatures } from '../../../__tests__/factories';
import { briefModelSchema } from '../schema';
import { gistOutputSchema, groundGist } from '../gist';
import { addMessageToThread, modules, seedMailThread, type Test } from './interpret.testlib';
import { captureInterpretSource, loadInterpretSource } from '../sources';
import { writeArrivalRecord } from '../../arrival/records';
import { enqueueDeliveredInterpretation } from '../enqueue';
import { rateLimiter } from '../../../lib/rateLimiter';
import { reconcileSpend } from '../../../aiRouting/__tests__/spend.testlib';

const llm = vi.hoisted(() => ({ runLlmObject: vi.fn(), gistFails: false }));

vi.mock('../../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../../analytics/__tests__/meteredDispatch.testlib');
	return { runLlmObject: metered((opts: unknown) => llm.runLlmObject(opts)) };
});
vi.mock('../../../lib/llmProvider', () => ({
	resolveLanguageModel: vi.fn(async () => ({ modelId: 'stub-model' })),
}));

const NOTICE = 'Your parcel was delivered to the front door at 10:42. Thanks for shopping with us.';
const ASK = 'Could you send me the signed contract by Friday?';

const callsFor = (schemaRef: unknown) =>
	llm.runLlmObject.mock.calls.filter(([opts]) => (opts as { schema: unknown }).schema === schemaRef)
		.length;
const gistCalls = () => callsFor(gistOutputSchema);
const extractions = () => callsFor(briefModelSchema);

beforeEach(() => {
	llm.gistFails = false;
	llm.runLlmObject.mockReset();
	llm.runLlmObject.mockImplementation(async ({ schema: s }: { schema: unknown }) => {
		if (s === gistOutputSchema) {
			if (llm.gistFails) throw new Error('provider down');
			return {
				object: {
					spans: [
						{ segment: 's0', quote: 'Your parcel was delivered to the front door at 10:42.' },
					],
				},
				tokenUsage: undefined,
				modelUsed: 'stub-model',
			};
		}
		if (s === briefModelSchema) {
			return {
				object: {
					mode: 'brief',
					items: [],
					transitions: [],
					replyIntent: 'fyi',
					urgency: 'normal',
					meetingIntent: null,
					coverage: { segmentsRead: ['s0'], uncertain: false, overflow: false },
					latest: { en: [], de: [] },
					facts: [],
				},
				tokenUsage: undefined,
				modelUsed: 'stub-model',
			};
		}
		return { object: { verdicts: [] }, tokenUsage: undefined, modelUsed: 'stub-model' };
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
});

function setup() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

/** A delivered notification as delivery leaves it (record, captured source). */
async function arrive(t: Test, opts: { text?: string; isReadOnArrival?: boolean } = {}) {
	await enableFeatures(t, ['ai']);
	const seeded = await seedMailThread(t, {
		text: opts.text ?? NOTICE,
		isReadOnArrival: opts.isReadOnArrival ?? true,
	});
	const source = { kind: 'mail' as const, id: seeded.messageId };
	await t.run(async (ctx) => {
		await ctx.db.patch(seeded.threadId, {
			category: { label: 'notification', source: 'heuristic', classifiedAt: Date.now() },
		});
		await writeArrivalRecord(ctx, (await ctx.db.get(seeded.messageId))!, { isLive: true });
		await captureInterpretSource(ctx, { source, isLive: true });
	});
	return { ...seeded, source };
}

/** One more delivered message in the thread, captured and recorded. */
async function arriveLater(
	t: Test,
	at: { mailboxId: Id<'mailboxes'>; threadId: Id<'mailThreads'> },
	text: string,
	hour: number
) {
	const id = await addMessageToThread(t, at, { text, receivedAt: Date.UTC(2026, 9, 7, hour, 0) });
	await t.run(async (ctx) => {
		await writeArrivalRecord(ctx, (await ctx.db.get(id))!, { isLive: true });
		await captureInterpretSource(ctx, { source: { kind: 'mail', id }, isLive: true });
	});
	return { kind: 'mail' as const, id };
}

const run = (t: Test, args: Parameters<Test['action']>[1]) =>
	t.action(internal.mail.interpret.run.interpretMessage, args as never);

const sourceRow = (t: Test, id: Id<'mailMessages'>) =>
	t.run((ctx) => loadInterpretSource(ctx, { kind: 'mail', id }));

const pendingRuns = (t: Test) =>
	t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect())
			.filter((job) => job.state.kind === 'pending' && job.name.includes('interpretMessage'))
			.map((job) => job.args[0] as Record<string, unknown>)
	);

async function exhaustOwnerBucket(t: Test, mailboxId: Id<'mailboxes'>) {
	await t.run(async (ctx) => {
		const owner = (await ctx.db.get(mailboxId))!.userId;
		for (let i = 0; i < 80; i++) {
			if (!(await rateLimiter.limit(ctx, 'arrivalReadPerOwner', { key: owner })).ok) break;
		}
	});
}

/** The run's lease, as a run would hold it before it commits. */
async function claim(t: Test, source: { kind: 'mail'; id: Id<'mailMessages'> }) {
	const claimed = await t.mutation(internal.mail.interpret.lease.claimSourceLease, { source });
	if (claimed.kind !== 'claimed') throw new Error('not claimed');
	return claimed.token;
}

async function epochOf(t: Test, threadId: Id<'mailThreads'>) {
	return t.run(async (ctx) => {
		const brief = await ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
			.unique();
		return brief!.deletionEpoch;
	});
}

describe('Sol r1 F1: D10 deferrals survive the category write', () => {
	it('a deferred source is never stamped, never woken, and a stray run reads nothing', async () => {
		const t = setup();
		await enableFeatures(t, ['ai']);
		const { messageId, threadId } = await seedMailThread(t, {
			text: NOTICE,
			isReadOnArrival: false,
		});
		await t.run(async (ctx) => {
			const message = (await ctx.db.get(messageId))!;
			await writeArrivalRecord(ctx, message, { isLive: true });
			await enqueueDeliveredInterpretation(ctx, message, {
				isLive: true,
				isInterpretedByClassify: false,
				isCategoryRefining: true,
			});
		});
		const row = await sourceRow(t, messageId);
		expect(row).toMatchObject({ isDeferred: true });
		expect(row?.categoryPendingAt).toBeUndefined();
		// Even a marker left from before: the category write wakes nothing.
		await t.run((ctx) => ctx.db.patch(row!._id, { categoryPendingAt: Date.now() }));
		await t.mutation(internal.mail.category.applyCategory, {
			threadId,
			label: 'receipt',
			source: 'llm',
		});
		expect(await pendingRuns(t)).toEqual([]);
		await run(t, { source: { kind: 'mail', id: messageId } });
		expect(llm.runLlmObject).not.toHaveBeenCalled();
		expect(await sourceRow(t, messageId)).toMatchObject({ isDeferred: true });
	});
});

describe('Sol r1 F2: display-settled is not fully read', () => {
	it('eager demand on a gisted source reads it in full', async () => {
		const t = setup();
		const { source, threadId, messageId } = await arrive(t);
		await run(t, { source });
		expect(gistCalls()).toBe(1);
		await t.run((ctx) => ctx.db.patch(threadId, { needsReplyPendingAt: Date.now() }));
		await run(t, { source });
		expect(extractions()).toBe(1);
		const row = await sourceRow(t, messageId);
		expect(row?.readOutcome).toBeUndefined();
		expect(row).toMatchObject({ isUpgradeable: false, depth: 'full' });
	});

	it('the prerequisite upgrades the thread, oldest first, and the plan reads partial meanwhile', async () => {
		const t = setup();
		const first = await arrive(t);
		await run(t, { source: first.source });
		const second = await arriveLater(t, first, 'Your order shipped this morning, thank you.', 10);
		await run(t, { source: second });
		expect(gistCalls()).toBe(2);
		const threadRef = { kind: 'mail' as const, id: first.threadId };

		const before = await t.query(internal.mail.interpret.responsePlanDraft.loadForDraft, {
			threadRef,
		});
		// The brief is display-complete, the plan is not: partial until fully read.
		const briefCompleteness = await t.run(async (ctx) => {
			const brief = await ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', first.threadId))
				.unique();
			return brief?.completeness;
		});
		expect(briefCompleteness).toBe('complete');
		expect(before).toMatchObject({ isFullyRead: false, completeness: 'partial' });
		expect(await t.mutation(internal.mail.interpret.fullRead.prepareThread, { threadRef })).toBe(
			'preparing'
		);
		// The newest one is scheduled as an upgrade; its run reads the older one first.
		expect(await pendingRuns(t)).toEqual([{ source: second, depth: 'full', isUpgrade: true }]);
		await run(t, { source: second, depth: 'full', isUpgrade: true });
		expect(extractions()).toBe(2);

		expect(await t.mutation(internal.mail.interpret.fullRead.prepareThread, { threadRef })).toBe(
			'ready'
		);
		const after = await t.query(internal.mail.interpret.responsePlanDraft.loadForDraft, {
			threadRef,
		});
		expect(after.isFullyRead).toBe(true);

		// Sol r1 F8: the record and the projection say what was read now.
		const projected = await t.run(async (ctx) => {
			const record = await ctx.db
				.query('mailArrivalRecords')
				.withIndex('by_message', (q) => q.eq('messageId', first.messageId))
				.first();
			const thread = await ctx.db.get(first.threadId);
			return { depth: record?.depth, arrival: thread?.arrival };
		});
		expect(projected.depth).toBe('full');
		expect(projected.arrival).toMatchObject({ messageId: second.id, depth: 'full' });
	});
});

describe('Sol r1 F3/F4: one admission point before any predecessor read', () => {
	it('eager work over the owner limit persists its continuation, unless the caller resumes', async () => {
		const t = setup();
		const { source, threadId, mailboxId } = await arrive(t, { text: ASK });
		await t.run((ctx) => ctx.db.patch(threadId, { needsReplyPendingAt: Date.now() }));
		await exhaustOwnerBucket(t, mailboxId);
		expect(await run(t, { source })).toMatchObject({ status: 'wait' });
		expect(await pendingRuns(t)).toEqual([{ source }]);
		// A caller that continues itself gets the wait and no second continuation.
		const leaseToken = await claim(t, source);
		expect(
			await t.mutation(internal.mail.interpret.arrivalAdmit.admitArrivalRun, {
				source,
				leaseToken,
				isCallerResuming: true,
			})
		).toMatchObject({ kind: 'wait' });
		expect(await pendingRuns(t)).toHaveLength(1);
	});

	it('an over-limit run buys no predecessor read', async () => {
		const t = setup();
		const first = await arrive(t);
		await run(t, { source: first.source });
		expect(gistCalls()).toBe(1);
		const later = await arriveLater(t, first, ASK, 10);
		await t.run((ctx) => ctx.db.patch(first.threadId, { needsReplyPendingAt: Date.now() }));
		await exhaustOwnerBucket(t, first.mailboxId);
		expect(await run(t, { source: later })).toMatchObject({ status: 'wait' });
		expect(extractions()).toBe(0);
		expect(await sourceRow(t, first.messageId)).toMatchObject({ readOutcome: 'gist' });
	});
});

describe('Sol r1 F5: settlements are bound to the epoch and the scope', () => {
	it('a late count after a team-inbox conversion writes nothing', async () => {
		const t = setup();
		const { source, mailboxId, messageId, threadId } = await arrive(t);
		const epoch = await epochOf(t, threadId);
		const leaseToken = await claim(t, source);
		await t.run(async (ctx) => {
			await ctx.db.patch(mailboxId, { scope: 'shared' });
		});
		expect(
			await t.mutation(internal.mail.interpret.arrivalDecide.settleArrivalCount, {
				source,
				leaseToken,
				deletionEpoch: epoch,
				reason: 'gistFailed',
			})
		).toBe('gone');
		const row = await sourceRow(t, messageId);
		expect(row?.readOutcome).toBeUndefined();
		const skipped = await t.run(async (ctx) => {
			const brief = await ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.unique();
			return brief?.skippedSources;
		});
		expect(skipped ?? null).toBeNull();
	});
});

describe('Sol r1 F6: the gist commit rechecks the body', () => {
	it('quotes from an earlier body do not commit', async () => {
		const t = setup();
		const { source, threadId } = await arrive(t);
		const epoch = await epochOf(t, threadId);
		const leaseToken = await claim(t, source);
		const out = await t.mutation(internal.mail.interpret.gistCommit.commitGist, {
			source,
			leaseToken,
			deletionEpoch: epoch,
			sourceVersion: 'an-earlier-body',
			gist: { spans: [{ segmentId: 's0', quote: 'Your parcel was delivered' }], gistVersion: 1 },
		});
		expect(out).toEqual({ kind: 'sourceChanged' });
		const gist = await t.run(async (ctx) => {
			const brief = await ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.unique();
			return brief?.gist;
		});
		expect(gist ?? null).toBeNull();
	});
});

describe('Sol r1 F7: grounding against what was offered', () => {
	const canonicalText = 'Delivered today. Thanks!\n> Earlier: please wire 500 EUR';
	const segmented = {
		canonicalText,
		uncertain: false,
		segments: [
			{ id: 's0', kind: 'fresh', start: 0, end: 24 },
			{ id: 's1', kind: 'quoted', start: 25, end: canonicalText.length },
		],
	} as never;
	// Only the first 16 characters of s0 were offered.
	const offered = [{ id: 's0', kind: 'fresh', text: 'Delivered today.', start: 0, end: 16 }];

	it('accepts a quote inside the offered characters', () => {
		expect(
			groundGist(
				{ spans: [{ segment: 's0', quote: 'Delivered today.' }] },
				{ segmented, segments: offered }
			)
		).toEqual({ spans: [{ segmentId: 's0', quote: 'Delivered today.' }] });
	});

	it('refuses a segment that was not offered and text past the cap', () => {
		expect(
			groundGist(
				{ spans: [{ segment: 's1', quote: 'please wire 500 EUR' }] },
				{ segmented, segments: offered }
			)
		).toBeNull();
		expect(
			groundGist({ spans: [{ segment: 's0', quote: 'Thanks!' }] }, { segmented, segments: offered })
		).toBeNull();
	});
});

describe('Sol r1 F12: a transient gist failure retries on schedule', () => {
	it('waits and keeps the source outstanding, then counts once the attempts are used up', async () => {
		const t = setup();
		const { source, messageId } = await arrive(t);
		llm.gistFails = true;
		expect(await run(t, { source })).toMatchObject({ status: 'wait' });
		const waiting = await sourceRow(t, messageId);
		expect(waiting?.readOutcome).toBeUndefined();
		expect(waiting?.isOutstanding).toBe(true);
		expect(await pendingRuns(t)).toEqual([{ source }]);
		// Attempts are the record's model calls: past retry.ts's last one, it counts.
		await t.run(async (ctx) => {
			const record = (await ctx.db
				.query('mailArrivalRecords')
				.withIndex('by_message', (q) => q.eq('messageId', messageId))
				.first())!;
			await ctx.db.patch(record._id, { modelCalls: 10 });
			// Its time has come (Sol r2 F5 holds an early run back).
			const source = (await loadInterpretSource(ctx, { kind: 'mail', id: messageId }))!;
			await ctx.db.patch(source._id, { arrivalRetryAt: Date.now() - 1 });
		});
		expect(await run(t, { source })).toMatchObject({ errorCode: 'arrival_settled_count' });
		expect(await sourceRow(t, messageId)).toMatchObject({
			readOutcome: 'skipped',
			skipReason: { key: 'arrival.reason.gistFailed' },
		});
	});
});

describe('Sol r1 F13: a refused hold counts in the refusing mutation', () => {
	it('reserveArrivalRun settles the count itself', async () => {
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '0.01');
		const t = setup();
		await reconcileSpend(t);
		const { source, messageId, threadId } = await arrive(t, { text: ASK });
		const epoch = await epochOf(t, threadId);
		const leaseToken = await claim(t, source);
		const verdict = await t.mutation(internal.mail.interpret.arrivalHold.reserveArrivalRun, {
			allocations: [
				{
					reservationId: 'r1',
					rootRequestId: 'postbox:r1',
					plane: 'language',
					task: 'mail.extract',
					budgetClass: 'standard',
					priority: 'background',
					heldMicrousd: 5_000_000,
					maxRequests: 1,
					requestBound: { microusd: 5_000_000 },
					expiresAt: Date.now() + 60_000,
				},
			],
			source,
			leaseToken,
			deletionEpoch: epoch,
		});
		expect(verdict).toMatchObject({ isAdmitted: false });
		expect(await sourceRow(t, messageId)).toMatchObject({
			readOutcome: 'skipped',
			depth: 'count',
			skipReason: { key: 'arrival.reason.budget' },
		});
	});

	it('end to end: a display-only full read whose hold is refused is counted, not retried', async () => {
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '0.01');
		const t = setup();
		await reconcileSpend(t);
		const { source, messageId, threadId } = await arrive(t, { text: ASK });
		await t.run((ctx) =>
			ctx.db.patch(threadId, {
				category: { label: 'person', source: 'heuristic', classifiedAt: Date.now() },
			})
		);
		expect(await run(t, { source })).toMatchObject({ errorCode: 'arrival_settled_count' });
		expect(llm.runLlmObject).not.toHaveBeenCalled();
		expect(await sourceRow(t, messageId)).toMatchObject({
			readOutcome: 'skipped',
			skipReason: { key: 'arrival.reason.budget' },
		});
	});
});

describe('Sol r2 F2: one owner charge per read job', () => {
	it('two threads under sustained exhaustion both make progress, one token each', async () => {
		vi.useFakeTimers();
		try {
			const t = setup();
			const a = await arrive(t);
			await run(t, { source: a.source });
			const aLater = await arriveLater(t, a, ASK, 10);
			const b = await t.run(async (ctx) => {
				// A second thread of the same owner, as delivery leaves it.
				const first = (await ctx.db.get(a.messageId))!;
				const threadId = await ctx.db.insert('mailThreads', {
					...(({ _id, _creationTime, ...rest }) => rest)((await ctx.db.get(a.threadId))!),
				});
				const id = await ctx.db.insert('mailMessages', {
					...(({ _id, _creationTime, ...rest }) => rest)(first),
					threadId,
					rfc822MessageId: '<b-1@example.com>',
					uid: 99,
				});
				return { threadId, messageId: id, mailboxId: a.mailboxId };
			});
			await t.run(async (ctx) => {
				await writeArrivalRecord(ctx, (await ctx.db.get(b.messageId))!, { isLive: true });
				await captureInterpretSource(ctx, {
					source: { kind: 'mail', id: b.messageId },
					isLive: true,
				});
			});
			await run(t, { source: { kind: 'mail', id: b.messageId } });
			const bLater = await arriveLater(t, b, ASK, 11);
			expect(gistCalls()).toBe(2);
			await t.run(async (ctx) => {
				await ctx.db.patch(a.threadId, { needsReplyPendingAt: Date.now() });
				await ctx.db.patch(b.threadId, { needsReplyPendingAt: Date.now() });
			});
			await exhaustOwnerBucket(t, a.mailboxId);

			// One token: thread A's job takes it and reads its predecessor and itself on it.
			vi.advanceTimersByTime(31_000);
			// (The stub's extraction does not parse, so a read records `failed`: still a read.)
			expect((await run(t, { source: aLater })).status).not.toBe('wait');
			expect(await run(t, { source: bLater })).toMatchObject({ status: 'wait' });
			expect(extractions()).toBe(2);
			// The next token is B's.
			vi.advanceTimersByTime(31_000);
			expect((await run(t, { source: bLater })).status).not.toBe('wait');
			expect(extractions()).toBe(4);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('Sol r2 F3: terminal exclusions are never upgraded', () => {
	it('eager demand on security mail reads nothing', async () => {
		const t = setup();
		const { source, threadId, messageId } = await arrive(t, {
			text: 'Your verification code is 482913.',
		});
		await run(t, { source });
		expect(await sourceRow(t, messageId)).toMatchObject({ depth: 'none', isUpgradeable: false });
		await t.run((ctx) => ctx.db.patch(threadId, { needsReplyPendingAt: Date.now() }));
		expect(await run(t, { source })).toEqual({ status: 'done' });
		expect(await run(t, { source, depth: 'full' })).toEqual({ status: 'done' });
		expect(llm.runLlmObject).not.toHaveBeenCalled();
	});
});

describe('Sol r2 F4: every refusal counts where it is seen', () => {
	it('the gist holds its spend through the arrival hold and counts on refusal', async () => {
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '0.0001');
		const t = setup();
		await reconcileSpend(t);
		const { source, messageId } = await arrive(t);
		expect(await run(t, { source })).toMatchObject({ errorCode: 'arrival_settled_count' });
		expect(gistCalls()).toBe(0);
		expect(await sourceRow(t, messageId)).toMatchObject({
			readOutcome: 'skipped',
			skipReason: { key: 'arrival.reason.budget' },
		});
	});

	it('the full read gate counts a display-only source in the refusing mutation', async () => {
		// A configured ceiling whose spend state is not reconciled refuses (#1333).
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '1');
		const t = setup();
		const { source, messageId, threadId } = await arrive(t, { text: ASK });
		const leaseToken = await claim(t, source);
		const out = await t.mutation(internal.mail.interpret.arrivalHold.gateOrCount, {
			source,
			leaseToken,
			deletionEpoch: await epochOf(t, threadId),
			mode: 'brief',
		});
		expect(out).toMatchObject({ isCounted: true, verdict: { isAllowed: false, code: 'budget' } });
		expect(await sourceRow(t, messageId)).toMatchObject({
			readOutcome: 'skipped',
			skipReason: { key: 'arrival.reason.budget' },
		});
	});
});

describe('Sol r2 F5: a gist retry runs only at its time', () => {
	it('the stale sweep or a duplicate cannot buy an early retry', async () => {
		const t = setup();
		const { source, messageId } = await arrive(t);
		llm.gistFails = true;
		const first = await run(t, { source });
		expect(first).toMatchObject({ status: 'wait' });
		const row = await sourceRow(t, messageId);
		expect(row?.arrivalRetryAt).toEqual(expect.any(Number));
		llm.gistFails = false;
		// Any early run (the sweep's, a duplicate) waits for the retry time, no call.
		expect(await run(t, { source })).toMatchObject({
			status: 'wait',
			retryAt: row!.arrivalRetryAt,
		});
		expect(gistCalls()).toBe(1);
		// At its time it runs.
		await t.run((ctx) => ctx.db.patch(row!._id, { arrivalRetryAt: Date.now() - 1 }));
		expect(await run(t, { source })).toMatchObject({ errorCode: 'arrival_settled_gist' });
		expect(gistCalls()).toBe(2);
	});
});
