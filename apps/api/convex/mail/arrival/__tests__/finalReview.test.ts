/**
 * Read on arrival, the whole-branch review (final r1):
 *
 *   F3  the owner's recategorization updates the arrival record, the
 *       placement and digest eligibility, and ends a depth wait, in its own
 *       mutation;
 *   F4  this message's pending rule questions are depth-decision work: a
 *       question-only R2 stamps the wait, a category write before the answers
 *       does not release it, the committed answers do, and a matching
 *       `sendToDigest` answer is in before the depth decision.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api, internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { enableFeatures } from '../../../__tests__/factories';
import { gistOutputSchema } from '../../interpret/gist';
import {
	addMessageToThread,
	modules,
	seedMailThread,
	type Test,
} from '../../interpret/__tests__/interpret.testlib';
import { captureInterpretSource, loadInterpretSource } from '../../interpret/sources';
import { writeArrivalRecord } from '../records';
import { refreshArrivalProjection } from '../projection';
import { runPostInsertInboundEffects } from '../../deliveryPipeline/afterInsert';

const session = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'owner',
	activeOrganizationId: 'org-1',
}));
vi.mock('../../../lib/sessionOrganization', async () => ({
	...(await vi.importActual<object>('../../../lib/sessionOrganization')),
	getMutationContext: vi.fn(async () => session),
	getBetterAuthSessionWithRole: vi.fn(async () => session),
}));

const llm = vi.hoisted(() => ({ runLlmObject: vi.fn() }));
vi.mock('../../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../../analytics/__tests__/meteredDispatch.testlib');
	return { runLlmObject: metered((opts: unknown) => llm.runLlmObject(opts)) };
});
vi.mock('../../../lib/llmProvider', () => ({
	resolveLanguageModel: vi.fn(async () => ({ modelId: 'stub-model' })),
}));

const NOTICE = 'Your parcel was delivered to the front door at 10:42. Thanks for shopping with us.';

beforeEach(() => {
	llm.runLlmObject.mockReset();
	llm.runLlmObject.mockImplementation(async () => ({
		object: {
			spans: [{ segment: 's0', quote: 'Your parcel was delivered to the front door at 10:42.' }],
		},
		tokenUsage: undefined,
		modelUsed: 'stub-model',
	}));
});

const gistCalls = () =>
	llm.runLlmObject.mock.calls.filter(
		([opts]) => (opts as { schema: unknown }).schema === gistOutputSchema
	).length;

function setup() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

/** A recorded, captured notification that waits for its depth decision. */
async function waiting(t: Test, opts: { label?: 'newsletter' | 'notification' } = {}) {
	await enableFeatures(t, ['ai']);
	const seeded = await seedMailThread(t, { text: NOTICE, isReadOnArrival: true });
	const source = { kind: 'mail' as const, id: seeded.messageId };
	await t.run(async (ctx) => {
		await ctx.db.patch(seeded.threadId, {
			category: {
				label: opts.label ?? 'notification',
				source: 'heuristic',
				classifiedAt: Date.now(),
			},
		});
		await writeArrivalRecord(ctx, (await ctx.db.get(seeded.messageId))!, { isLive: true });
		await captureInterpretSource(ctx, { source, isLive: true });
		const row = (await loadInterpretSource(ctx, source))!;
		await ctx.db.patch(row._id, { categoryPendingAt: Date.now() });
		await refreshArrivalProjection(ctx, seeded.threadId);
	});
	return { ...seeded, source };
}

const pendingRuns = (t: Test) =>
	t.run(
		async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect()).filter(
				(job) => job.state.kind === 'pending' && job.name.includes('interpretMessage')
			).length
	);

async function seedQuestion(t: Test, mailboxId: Id<'mailboxes'>, messageId: Id<'mailMessages'>) {
	return t.run(async (ctx) => {
		const filterId = await ctx.db.insert('mailFilters', {
			mailboxId,
			name: 'Shipping into the digest',
			isEnabled: true,
			priority: 1,
			conditions: [],
			actions: [{ type: 'sendToDigest' }],
			stopProcessing: false,
			aiCondition: { question: 'Is this a shipping update?', revision: 1 },
			origin: 'plain_language',
			revision: 1,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const record = (await ctx.db
			.query('mailArrivalRecords')
			.withIndex('by_message', (q) => q.eq('messageId', messageId))
			.first())!;
		await ctx.db.patch(record._id, {
			pendingAiFilters: [{ filterId, revision: 1, question: 'Is this a shipping update?' }],
		});
		return filterId;
	});
}

describe('final review F3: the owner recategorizes', () => {
	it('updates the record, the placement and digest eligibility, and ends the depth wait', async () => {
		const t = setup();
		const { threadId, messageId, source } = await waiting(t, { label: 'newsletter' });
		const before = await t.run(async (ctx) => (await ctx.db.get(threadId))!);
		expect(before.arrival?.placement).toBe('digest');
		expect(before.digestPendingSince).toEqual(expect.any(Number));

		await t.mutation(api.mail.category.recategorize, { threadId, label: 'person' });

		const after = await t.run(async (ctx) => {
			const record = await ctx.db
				.query('mailArrivalRecords')
				.withIndex('by_message', (q) => q.eq('messageId', messageId))
				.first();
			return {
				thread: (await ctx.db.get(threadId))!,
				record,
				row: await loadInterpretSource(ctx, source),
			};
		});
		expect(after.record).toMatchObject({ category: 'person', categorySource: 'user' });
		expect(after.thread.arrival?.placement).toBe('today');
		expect(after.thread.digestPendingSince).toBeUndefined();
		expect(after.row?.categoryPendingAt).toBeUndefined();
		expect(await pendingRuns(t)).toBe(1);
	});
});

describe('final review F4: pending rule questions are depth-decision work', () => {
	it('a question-only R2 at delivery stamps the depth wait', async () => {
		const t = setup();
		await enableFeatures(t, ['ai']);
		const seeded = await seedMailThread(t, { text: NOTICE, isReadOnArrival: true });
		// An automated sender: the heuristic settles the category, no refinement is queued.
		const filterId = await t.run(async (ctx) => {
			await ctx.db.patch(seeded.messageId, { fromAddress: 'no-reply@shop.example' });
			return ctx.db.insert('mailFilters', {
				mailboxId: seeded.mailboxId,
				name: 'Shipping',
				isEnabled: true,
				priority: 1,
				conditions: [],
				actions: [{ type: 'sendToDigest' }],
				stopProcessing: false,
				aiCondition: { question: 'Is this a shipping update?', revision: 1 },
				revision: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		await t.run(async (ctx) => {
			const message = (await ctx.db.get(seeded.messageId))!;
			const folder = (await ctx.db.get(message.folderId))!;
			await runPostInsertInboundEffects(ctx, {
				messageId: seeded.messageId,
				folder,
				origin: 'mx',
				arrival: {
					pendingAiFilters: [{ filterId, revision: 1, question: 'Is this a shipping update?' }],
				},
			});
		});
		const row = await t.run((ctx) =>
			loadInterpretSource(ctx, { kind: 'mail', id: seeded.messageId })
		);
		expect(row?.categoryPendingAt).toEqual(expect.any(Number));
	});

	it('the category write waits for the answers; a sendToDigest answer counts it before any read', async () => {
		const t = setup();
		const { threadId, messageId, mailboxId, source } = await waiting(t);
		const filterId = await seedQuestion(t, mailboxId, messageId);

		// The heuristic (or an override) writes the category first: not released.
		await t.mutation(internal.mail.category.applyCategory, {
			threadId,
			label: 'notification',
			source: 'heuristic',
		});
		const held = await t.run((ctx) => loadInterpretSource(ctx, source));
		expect(held?.categoryPendingAt).toEqual(expect.any(Number));
		expect(await pendingRuns(t)).toBe(0);
		expect(await t.action(internal.mail.interpret.run.interpretMessage, { source })).toMatchObject({
			status: 'wait',
		});
		expect(gistCalls()).toBe(0);

		// R2's answers commit: the wait ends, the run goes now.
		await t.mutation(internal.mail.arrival.r2.commitArrivalAiAnswers, {
			messageId,
			answers: [{ filterId, revision: 1, answer: true }],
		});
		const released = await t.run((ctx) => loadInterpretSource(ctx, source));
		expect(released?.categoryPendingAt).toBeUndefined();
		expect(await pendingRuns(t)).toBe(1);

		// The digest hint is in before the depth decision: counted, never gisted.
		expect(await t.action(internal.mail.interpret.run.interpretMessage, { source })).toMatchObject({
			errorCode: 'arrival_settled_count',
		});
		expect(gistCalls()).toBe(0);
	});
});

describe('final review r2 F1: a stranger bulk mail still settling offers nothing', () => {
	it('isOfferable is false while the category is provisional, true once it settles', async () => {
		const t = setup();
		const { messageId, threadId, source } = await waiting(t);
		await t.run(async (ctx) => {
			const row = (await loadInterpretSource(ctx, source))!;
			await ctx.db.patch(row._id, {
				eligibility: { ...row.eligibility, isBulkHeaderPresent: true, isSenderKnown: false },
			});
			await ctx.db.patch(threadId, {
				category: { label: 'other', source: 'heuristic', classifiedAt: Date.now() },
			});
		});
		expect(await t.query(internal.mail.arrival.offerable.isOfferable, { messageId })).toBe(false);
		// Settled as a person's mail: offered.
		await t.run((ctx) =>
			ctx.db.patch(threadId, {
				category: { label: 'person', source: 'llm', classifiedAt: Date.now() },
			})
		);
		expect(await t.query(internal.mail.arrival.offerable.isOfferable, { messageId })).toBe(true);
	});
});

describe('final review r2 F2: the combined R2 commit writes the category first', () => {
	it('category, answers and the release land in one mutation', async () => {
		const t = setup();
		const { threadId, messageId, mailboxId, source } = await waiting(t);
		const filterId = await seedQuestion(t, mailboxId, messageId);
		await t.run((ctx) =>
			ctx.db.patch(threadId, {
				category: { label: 'other', source: 'heuristic', classifiedAt: Date.now() },
			})
		);
		await t.mutation(internal.mail.arrival.r2.commitArrivalAiAnswers, {
			messageId,
			answers: [{ filterId, revision: 1, answer: false }],
			category: { threadId, label: 'receipt', source: 'llm' },
		});
		const state = await t.run(async (ctx) => ({
			thread: (await ctx.db.get(threadId))!,
			row: await loadInterpretSource(ctx, source),
		}));
		expect(state.thread.category).toMatchObject({ label: 'receipt', source: 'llm' });
		expect(state.row?.categoryPendingAt).toBeUndefined();
		expect(await pendingRuns(t)).toBe(1);
	});

	it('a stale category or a missing one releases nothing: the wait keeps its bound', async () => {
		const t = setup();
		const { threadId, messageId, mailboxId, source } = await waiting(t);
		const filterId = await seedQuestion(t, mailboxId, messageId);
		const newer = await addMessageToThread(
			t,
			{ mailboxId, threadId },
			{
				text: 'A newer message.',
				receivedAt: Date.UTC(2026, 9, 7, 12, 0),
			}
		);
		await t.run((ctx) => ctx.db.patch(threadId, { latestMessageId: newer }));
		// The refinement read the thread before the newer message: its category is stale.
		await t.mutation(internal.mail.arrival.r2.commitArrivalAiAnswers, {
			messageId,
			answers: [{ filterId, revision: 1, answer: false }],
			category: { threadId, expectedLatestMessageId: messageId, label: 'receipt', source: 'llm' },
		});
		expect((await t.run((ctx) => loadInterpretSource(ctx, source)))?.categoryPendingAt).toEqual(
			expect.any(Number)
		);
		expect(await pendingRuns(t)).toBe(0);
	});

	it('answers committed without the category (the model gave none) release nothing', async () => {
		const t = setup();
		const { messageId, mailboxId, source } = await waiting(t);
		const filterId = await seedQuestion(t, mailboxId, messageId);
		await t.mutation(internal.mail.arrival.r2.commitArrivalAiAnswers, {
			messageId,
			answers: [{ filterId, revision: 1, answer: false }],
			isReleasing: false,
		});
		expect((await t.run((ctx) => loadInterpretSource(ctx, source)))?.categoryPendingAt).toEqual(
			expect.any(Number)
		);
		expect(await pendingRuns(t)).toBe(0);
	});
});
