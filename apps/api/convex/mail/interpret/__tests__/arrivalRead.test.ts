/**
 * Read on arrival end to end (SPEC §2): the interpretation run decides how
 * deep a display-only Postbox message is read when it arrives, with a stubbed
 * model.
 *
 *   - a display-only notification gets a gist; a newsletter is counted; a
 *     reply candidate gets the full read; a refused budget counts; the
 *     preference off keeps D10's deferral;
 *   - the per-source lease keeps two runs from buying two reads;
 *   - a later reply candidate upgrades the thread's gisted message;
 *   - the projection follows the needs-reply verdict and is never taken over
 *     by an older message's late result.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api, internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { enableFeatures } from '../../../__tests__/factories';
import { briefModelSchema } from '../schema';
import { gistOutputSchema } from '../gist';
import { addMessageToThread, modules, seedMailThread, type Test } from './interpret.testlib';
import { captureInterpretSource, loadInterpretSource } from '../sources';
import { AdmissionRefusedError } from '../../../lib/llm/admissionPort';
import { writeArrivalRecord, noteArrivalRun } from '../../arrival/records';
import { clearThreadNeedsReply } from '../../needsReply';
import { enqueueDeliveredInterpretation } from '../enqueue';
import { openMessageBody } from '../../../lib/messageBody';
import { rateLimiter } from '../../../lib/rateLimiter';
import { CATEGORY_DEPTH_WAIT_MS } from '../arrivalDecide';
import { senderKeyOf } from '../../senders/profiles';

const llm = vi.hoisted(() => ({ runLlmObject: vi.fn(), refuseNext: false }));

vi.mock('../../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../../analytics/__tests__/meteredDispatch.testlib');
	return { runLlmObject: metered((opts: unknown) => llm.runLlmObject(opts)) };
});
vi.mock('../../../lib/llmProvider', () => ({
	resolveLanguageModel: vi.fn(async () => ({ modelId: 'stub-model' })),
}));

const NOTICE = 'Your parcel was delivered to the front door at 10:42. Thanks for shopping with us.';
const ASK = 'Could you send me the signed contract by Friday?';
const SESSION = { userId: 'user-A', role: 'member', activeOrganizationId: 'org-1' };

vi.mock('../../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, getBetterAuthSessionWithRole: vi.fn(async () => SESSION) };
});

const callsFor = (schemaRef: unknown) =>
	llm.runLlmObject.mock.calls.filter(([opts]) => (opts as { schema: unknown }).schema === schemaRef)
		.length;
const gistCalls = () => callsFor(gistOutputSchema);
const extractions = () => callsFor(briefModelSchema);

function extraction(segmentId: string) {
	return {
		mode: 'brief',
		items: [],
		transitions: [],
		replyIntent: 'fyi',
		urgency: 'normal',
		meetingIntent: null,
		coverage: { segmentsRead: [segmentId], uncertain: false, overflow: false },
		latest: { en: [], de: [] },
		facts: [],
	};
}

beforeEach(() => {
	llm.refuseNext = false;
	llm.runLlmObject.mockReset();
	llm.runLlmObject.mockImplementation(async ({ schema: s }: { schema: unknown }) => {
		await new Promise((resolve) => setTimeout(resolve, 10));
		if (llm.refuseNext) throw new AdmissionRefusedError('daily_ceiling', 'stub');
		if (s === gistOutputSchema) {
			return {
				object: {
					spans: [
						{ segment: 's0', quote: 'Your parcel was delivered to the front door at 10:42.' },
					],
					fact: { kind: 'status', segment: 's0', quote: 'delivered' },
				},
				tokenUsage: undefined,
				modelUsed: 'stub-model',
			};
		}
		if (s === briefModelSchema) {
			return { object: extraction('s0'), tokenUsage: undefined, modelUsed: 'stub-model' };
		}
		return { object: { verdicts: [] }, tokenUsage: undefined, modelUsed: 'stub-model' };
	});
});

type Category = 'notification' | 'newsletter' | 'person' | 'receipt';

/** A delivered message as delivery leaves it: category, arrival record, captured source. */
async function arrive(
	t: Test,
	opts: { text?: string; category?: Category; isReadOnArrival?: boolean } = {}
) {
	await enableFeatures(t, ['ai']);
	const seeded = await seedMailThread(t, {
		text: opts.text ?? NOTICE,
		isReadOnArrival: opts.isReadOnArrival ?? true,
	});
	const source = { kind: 'mail' as const, id: seeded.messageId };
	await t.run(async (ctx) => {
		if (opts.category) {
			await ctx.db.patch(seeded.threadId, {
				category: { label: opts.category, source: 'heuristic', classifiedAt: Date.now() },
			});
		}
		await writeArrivalRecord(ctx, (await ctx.db.get(seeded.messageId))!, { isLive: true });
		await captureInterpretSource(ctx, { source, isLive: true });
	});
	return { ...seeded, source };
}

async function snapshot(t: Test, messageId: Id<'mailMessages'>) {
	return t.run(async (ctx) => {
		const message = (await ctx.db.get(messageId))!;
		const thread = (await ctx.db.get(message.threadId))!;
		const brief = await ctx.db
			.query('threadBriefs')
			.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', thread._id))
			.unique();
		const record = await ctx.db
			.query('mailArrivalRecords')
			.withIndex('by_message', (q) => q.eq('messageId', messageId))
			.first();
		return {
			source: await loadInterpretSource(ctx, { kind: 'mail', id: messageId }),
			thread,
			brief,
			record,
		};
	});
}

function setup() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

const run = (t: Test, source: { kind: 'mail'; id: Id<'mailMessages'> }) =>
	t.action(internal.mail.interpret.run.interpretMessage, { source });

describe('read on arrival: the depth of a display-only message', () => {
	it('a display-only notification gets a gist at arrival', async () => {
		const t = setup();
		const { source, messageId, threadId } = await arrive(t, { category: 'notification' });
		const out = await run(t, source);
		expect(out).toMatchObject({ status: 'skipped', errorCode: 'arrival_settled_gist' });
		expect(gistCalls()).toBe(1);
		expect(extractions()).toBe(0);
		const { source: row, thread, brief, record } = await snapshot(t, messageId);
		expect(row).toMatchObject({ readOutcome: 'gist', depth: 'gist', isUpgradeable: true });
		expect(row?.isOutstanding).toBeUndefined();
		expect(row?.leaseToken).toBeUndefined();
		expect(brief).toMatchObject({ gistSources: 1, completeness: 'complete' });
		expect(brief?.pendingSources).toBeUndefined();
		// Stored through the body seal, verbatim when opened.
		const quote = brief!.gist!.spans[0]!.quote;
		expect(await openMessageBody(quote)).toBe(
			'Your parcel was delivered to the front door at 10:42.'
		);
		expect(thread.briefTop?.gist).toBeDefined();
		expect(record).toMatchObject({ depth: 'gist', modelCalls: 1 });
		expect(thread.arrival).toMatchObject({ placement: 'updates', depth: 'gist', messageId });

		// The reader gets it from brief.get, and the list row from openBriefTop.
		const view = await t.query(api.mail.interpret.brief.get, {
			threadRef: { kind: 'mail', id: threadId },
			locale: 'en',
		});
		expect(view).toMatchObject({
			mode: 'brief',
			completeness: 'complete',
			gist: {
				spans: [
					{ segmentId: 's0', quote: 'Your parcel was delivered to the front door at 10:42.' },
				],
				fact: { kind: 'status', quote: 'delivered' },
				messageId,
			},
		});
	});

	it('a newsletter is counted, with no model call', async () => {
		const t = setup();
		const { source, messageId } = await arrive(t, { category: 'newsletter' });
		expect(await run(t, source)).toMatchObject({ errorCode: 'arrival_settled_count' });
		expect(llm.runLlmObject).not.toHaveBeenCalled();
		const { source: row, thread, brief, record } = await snapshot(t, messageId);
		expect(row).toMatchObject({ readOutcome: 'skipped', depth: 'count', isUpgradeable: true });
		expect(brief).toMatchObject({ skippedSources: 1, completeness: 'complete' });
		expect(record).toMatchObject({ depth: 'count', modelCalls: 0 });
		expect(thread.arrival).toMatchObject({ placement: 'digest', depth: 'count' });
		expect(thread.digestPendingSince).toEqual(expect.any(Number));
	});

	it('exact wording is read in full instead of gisted', async () => {
		const t = setup();
		const { source, messageId } = await arrive(t, {
			category: 'notification',
			text: 'Please note our new bank details for all future payments.',
		});
		await run(t, source);
		expect(gistCalls()).toBe(0);
		expect(extractions()).toBe(1);
		expect((await snapshot(t, messageId)).record).toMatchObject({ depth: 'full' });
	});

	it('security mail is not read at all, terminally', async () => {
		const t = setup();
		const { source, messageId } = await arrive(t, {
			category: 'notification',
			text: 'Your verification code is 482913.',
		});
		await run(t, source);
		expect(llm.runLlmObject).not.toHaveBeenCalled();
		expect((await snapshot(t, messageId)).source).toMatchObject({
			readOutcome: 'skipped',
			depth: 'none',
			isUpgradeable: false,
		});
	});

	it('a reply candidate gets the full read', async () => {
		const t = setup();
		const { source, messageId, threadId } = await arrive(t, { category: 'person', text: ASK });
		await t.run((ctx) => ctx.db.patch(threadId, { needsReplyPendingAt: Date.now() }));
		await run(t, source);
		expect(extractions()).toBe(1);
		expect(gistCalls()).toBe(0);
		const { source: row, record } = await snapshot(t, messageId);
		expect(row?.readOutcome).toBeUndefined();
		expect(record).toMatchObject({
			depth: 'full',
			reasonKeys: [{ key: 'arrival.reason.openWork' }],
		});
	});

	it('a budget refusal of the gist settles a count, never retried', async () => {
		const t = setup();
		const { source, messageId } = await arrive(t, { category: 'receipt' });
		llm.refuseNext = true;
		expect(await run(t, source)).toMatchObject({ errorCode: 'arrival_settled_count' });
		const { source: row, record } = await snapshot(t, messageId);
		expect(row).toMatchObject({ readOutcome: 'skipped', depth: 'count', isUpgradeable: true });
		expect(row?.skipReason).toEqual({ key: 'arrival.reason.budget' });
		expect(row?.isOutstanding).toBeUndefined();
		expect(record).toMatchObject({ degradedBy: 'budget' });
	});

	it('a budget refusal of a display-only full read counts too', async () => {
		const t = setup();
		const { source, messageId } = await arrive(t, { category: 'person', text: ASK });
		llm.refuseNext = true;
		expect(await run(t, source)).toMatchObject({ errorCode: 'arrival_settled_count' });
		expect((await snapshot(t, messageId)).source).toMatchObject({
			readOutcome: 'skipped',
			skipReason: { key: 'arrival.reason.budget' },
		});
	});

	it('the preference off keeps D10: the message waits for the open', async () => {
		const t = setup();
		await enableFeatures(t, ['ai']);
		const { messageId } = await seedMailThread(t, { text: NOTICE, isReadOnArrival: false });
		await t.run(async (ctx) => {
			const message = (await ctx.db.get(messageId))!;
			await enqueueDeliveredInterpretation(ctx, message, {
				isLive: true,
				isInterpretedByClassify: false,
			});
		});
		const { source: row, brief } = await snapshot(t, messageId);
		expect(row).toMatchObject({ isDeferred: true });
		expect(row?.readOutcome).toBeUndefined();
		expect(brief?.deferredSources).toBe(1);
	});

	it('the preference on schedules the read instead of deferring', async () => {
		const t = setup();
		await enableFeatures(t, ['ai']);
		const { messageId } = await seedMailThread(t, { text: NOTICE, isReadOnArrival: true });
		await t.run(async (ctx) => {
			const message = (await ctx.db.get(messageId))!;
			await enqueueDeliveredInterpretation(ctx, message, {
				isLive: true,
				isInterpretedByClassify: false,
			});
		});
		const { source: row } = await snapshot(t, messageId);
		expect(row?.isDeferred).toBeUndefined();
		expect(row?.isOutstanding).toBe(true);
	});
});

describe('read on arrival: lease, upgrade, projection', () => {
	it('the lease keeps two overlapping runs from buying two gists', async () => {
		const t = setup();
		const { source } = await arrive(t, { category: 'notification' });
		const results = await Promise.all([run(t, source), run(t, source)]);
		expect(gistCalls()).toBe(1);
		expect(results.map((r) => r.status).sort()).toEqual(['busy', 'skipped']);
		// A later run finds the source terminal: nothing more is bought.
		expect(await run(t, source)).toEqual({ status: 'done' });
		expect(gistCalls()).toBe(1);
	});

	it('a later reply candidate reads the gisted message in full first', async () => {
		const t = setup();
		const first = await arrive(t, { category: 'notification' });
		await run(t, first.source);
		expect(gistCalls()).toBe(1);

		const laterId = await addMessageToThread(t, first, {
			text: ASK,
			receivedAt: Date.UTC(2026, 9, 7, 10, 0),
		});
		await t.run(async (ctx) => {
			await ctx.db.patch(first.threadId, { needsReplyPendingAt: Date.now() });
			await writeArrivalRecord(ctx, (await ctx.db.get(laterId))!, { isLive: true });
			await captureInterpretSource(ctx, { source: { kind: 'mail', id: laterId }, isLive: true });
		});
		await run(t, { kind: 'mail', id: laterId });
		// The earlier message first, then the candidate: two full reads.
		expect(extractions()).toBe(2);
		const earlier = await snapshot(t, first.messageId);
		expect(earlier.source).toMatchObject({ isUpgradeable: false, depth: 'full' });
		expect(earlier.source?.readOutcome).toBeUndefined();
		expect(earlier.brief?.gistSources).toBeUndefined();
		// The full read superseded the gist.
		expect(earlier.brief?.gist).toBeUndefined();
		expect(earlier.thread.briefTop?.gist).toBeUndefined();
	});

	it('placement follows the needs-reply verdict, and recomputes when it clears', async () => {
		const t = setup();
		const { source, messageId, threadId } = await arrive(t, { category: 'notification' });
		await run(t, source);
		expect((await snapshot(t, messageId)).thread.arrival?.placement).toBe('updates');
		await t.mutation(internal.mail.needsReply.applyResult, {
			threadId,
			needsReply: { messageId, source: 'llm', urgency: 'normal' },
		});
		expect((await snapshot(t, messageId)).thread.arrival?.placement).toBe('needs_me');
		await t.run((ctx) => clearThreadNeedsReply(ctx, threadId));
		expect((await snapshot(t, messageId)).thread.arrival?.placement).toBe('updates');
	});

	it("an older message's late result never takes the newer one's projection", async () => {
		const t = setup();
		const first = await arrive(t, { category: 'newsletter' });
		const laterId = await addMessageToThread(t, first, {
			text: NOTICE,
			receivedAt: Date.UTC(2026, 9, 7, 10, 0),
		});
		await t.run(async (ctx) => {
			await writeArrivalRecord(ctx, (await ctx.db.get(laterId))!, { isLive: true });
			await noteArrivalRun(ctx, laterId, { depth: 'gist' });
		});
		expect((await snapshot(t, laterId)).thread.arrival).toMatchObject({
			messageId: laterId,
			depth: 'gist',
		});
		// The older message's run lands late: its record changes, the projection does not move.
		await t.run((ctx) => noteArrivalRun(ctx, first.messageId, { depth: 'count' }));
		const after = await snapshot(t, laterId);
		expect(after.thread.arrival).toMatchObject({ messageId: laterId, depth: 'gist' });
		expect((await snapshot(t, first.messageId)).record).toMatchObject({ depth: 'count' });
	});
});

describe('read on arrival: admission and the category wait', () => {
	it('over the owner limit, display-only mail is counted instead of read', async () => {
		const t = setup();
		const { source, messageId, mailboxId } = await arrive(t, { category: 'notification' });
		await t.run(async (ctx) => {
			const owner = (await ctx.db.get(mailboxId))!.userId;
			await rateLimiter.limit(ctx, 'arrivalReadPerOwner', { key: owner, count: 60 });
		});
		await run(t, source);
		expect(llm.runLlmObject).not.toHaveBeenCalled();
		const { source: row, record } = await snapshot(t, messageId);
		expect(row).toMatchObject({
			readOutcome: 'skipped',
			depth: 'count',
			isUpgradeable: true,
			skipReason: { key: 'arrival.reason.ownerLimit' },
		});
		expect(record).toMatchObject({ degradedBy: 'owner_limit' });
	});

	it('over the owner limit, eager work waits for the bucket', async () => {
		const t = setup();
		const { source, messageId, mailboxId, threadId } = await arrive(t, { text: ASK });
		await t.run(async (ctx) => {
			await ctx.db.patch(threadId, { needsReplyPendingAt: Date.now() });
			const owner = (await ctx.db.get(mailboxId))!.userId;
			await rateLimiter.limit(ctx, 'arrivalReadPerOwner', { key: owner, count: 60 });
		});
		const out = await run(t, source);
		expect(out).toMatchObject({ status: 'wait', retryAt: expect.any(Number) });
		expect(llm.runLlmObject).not.toHaveBeenCalled();
		const { source: row } = await snapshot(t, messageId);
		expect(row?.readOutcome).toBeUndefined();
		expect(row?.isOutstanding).toBe(true);
	});

	it("waits for this message's category, and the category write runs it now", async () => {
		const t = setup();
		const { source, messageId, threadId } = await arrive(t);
		await t.run(async (ctx) => {
			const row = (await loadInterpretSource(ctx, source))!;
			await ctx.db.patch(row._id, { categoryPendingAt: Date.now() });
		});
		const out = await run(t, source);
		expect(out).toMatchObject({ status: 'wait' });
		expect(llm.runLlmObject).not.toHaveBeenCalled();
		const waiting = await snapshot(t, messageId);
		expect(waiting.source?.leaseToken).toBeUndefined();
		expect(waiting.source?.categoryPendingAt).toEqual(expect.any(Number));

		await t.mutation(internal.mail.category.applyCategory, {
			threadId,
			label: 'receipt',
			source: 'llm',
		});
		const woken = await snapshot(t, messageId);
		expect(woken.source?.categoryPendingAt).toBeUndefined();
		expect(woken.record).toMatchObject({ category: 'receipt', categorySource: 'llm' });
		const jobs = await t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect())
				.filter((job) => job.state.kind === 'pending')
				.map((job) => job.name)
		);
		expect(jobs.some((name) => name.includes('interpretMessage'))).toBe(true);
		// The ceiling finds nothing to do.
		expect(
			await t.mutation(internal.mail.interpret.arrivalDecide.depthWaitCeiling, {
				source,
				pendingAt: waiting.source!.categoryPendingAt!,
			})
		).toEqual({ isScheduled: false });
		await run(t, source);
		expect(gistCalls()).toBe(1);
	});

	it('after the wait the heuristic category decides, and says so', async () => {
		const t = setup();
		const { source, messageId } = await arrive(t, { category: 'newsletter' });
		await t.run(async (ctx) => {
			const row = (await loadInterpretSource(ctx, source))!;
			await ctx.db.patch(row._id, { categoryPendingAt: Date.now() - CATEGORY_DEPTH_WAIT_MS - 1 });
		});
		await run(t, source);
		const { source: row, record } = await snapshot(t, messageId);
		expect(row).toMatchObject({ depth: 'count' });
		expect(row?.categoryPendingAt).toBeUndefined();
		expect(record?.reasonKeys[0]).toEqual({ key: 'arrival.reason.categoryTimeout' });
	});
});

describe('read on arrival: sender status', () => {
	it("a digest sender is counted, and the sender lane's reason key survives the run", async () => {
		const t = setup();
		const { source, messageId, mailboxId } = await arrive(t, { category: 'person', text: ASK });
		await t.run(async (ctx) => {
			const key = senderKeyOf('jonas@example.com');
			const now = Date.now();
			await ctx.db.insert('mailSenderProfiles', {
				mailboxId,
				senderDigest: key.senderDigest,
				address: key.address,
				status: 'digest',
				statusSource: 'user',
				weekAnchor: 0,
				deliveredWeeks: [],
				openedWeeks: [],
				unusedDraftStreak: 0,
				createdAt: now,
				updatedAt: now,
			});
			const record = (await ctx.db
				.query('mailArrivalRecords')
				.withIndex('by_message', (q) => q.eq('messageId', messageId))
				.first())!;
			await ctx.db.patch(record._id, {
				reasonKeys: [{ key: 'arrival.reason.senderStatus', params: { status: 'digest' } }],
			});
		});
		await run(t, source);
		expect(llm.runLlmObject).not.toHaveBeenCalled();
		const { source: row, record, thread } = await snapshot(t, messageId);
		expect(row).toMatchObject({ readOutcome: 'skipped', depth: 'count' });
		expect(record?.reasonKeys.map((r) => r.key)).toEqual([
			'arrival.reason.senderStatus',
			'arrival.reason.digest',
		]);
		expect(thread.arrival).toMatchObject({ placement: 'digest' });
	});
});
