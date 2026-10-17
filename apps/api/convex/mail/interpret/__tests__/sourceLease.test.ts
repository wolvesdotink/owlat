/**
 * The per-source run lease (lease.ts, SPEC §2.5; Sol fixes-r1 F1). Two
 * interpretation runs of one source that overlap (delivery and the category
 * wake, the stale sweep, a second dispatch) used to both pass the replay
 * dedupe before either committed, and both bought the extraction. Now the
 * first claims the source; the other answers `busy` without a model call, and
 * a run that comes later replays the stored result.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import { enableFeatures } from '../../../__tests__/factories';
import { briefModelSchema } from '../schema';
import { captureInterpretSource } from '../sources';
import { LEASE_MS } from '../lease';
import { CATEGORY_SETTLE_MS } from '../eligibility';
import { BUSY_RECHECK_MS, continuesLater } from '../../ai/needsReplyGates';
import { modules, seedMailThread, type Test } from './interpret.testlib';

const llm = vi.hoisted(() => ({
	runLlmObject: vi.fn(),
	/** Called before extraction `n` (1-based) answers. */
	beforeExtraction: undefined as undefined | ((n: number) => Promise<void>),
}));

vi.mock('../../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../../analytics/__tests__/meteredDispatch.testlib');
	return { runLlmObject: metered((opts: unknown) => llm.runLlmObject(opts)) };
});
vi.mock('../../../lib/llmProvider', () => ({
	resolveLanguageModel: vi.fn(async () => ({ modelId: 'stub-model' })),
}));

const TEXT = 'Could you send me the signed contract by Friday?';

const OUTPUT = {
	mode: 'brief',
	items: [
		{
			matchItemId: null,
			intent: 'request',
			facets: ['file'],
			consequences: ['payment'],
			assertion: 'Send the signed contract',
			display: { en: 'Send the signed contract', de: 'Schick den unterschriebenen Vertrag' },
			requester: { ref: 'p1', name: null, email: null },
			responsible: { ref: null, name: null, email: 'me@owlat.test' },
			beneficiary: null,
			due: null,
			amount: null,
			options: null,
			quotes: [{ segmentId: 's0', text: 'send me the signed contract by Friday' }],
		},
	],
	transitions: [],
	replyIntent: 'request_for_action',
	urgency: 'normal',
	meetingIntent: null,
	coverage: { segmentsRead: ['s0'], uncertain: false, overflow: false },
	latest: { en: [], de: [] },
	facts: [],
};

/** Paid extractions so far (the verifier's calls aside). */
const extractions = () =>
	llm.runLlmObject.mock.calls.filter(
		([opts]) => (opts as { schema: unknown }).schema === briefModelSchema
	).length;

beforeEach(() => {
	llm.beforeExtraction = undefined;
	llm.runLlmObject.mockReset();
	llm.runLlmObject.mockImplementation(
		async ({ schema, prompt }: { schema: unknown; prompt: string }) => {
			// A model call takes a while: long enough for a second run to overlap.
			await new Promise((resolve) => setTimeout(resolve, 20));
			if (schema === briefModelSchema) {
				await llm.beforeExtraction?.(extractions());
				return { object: OUTPUT, tokenUsage: undefined, modelUsed: 'stub-model' };
			}
			const ids = [...prompt.matchAll(/CLAIM (\S+):/g)].map((m) => m[1]);
			return {
				object: { verdicts: ids.map((claimId) => ({ claimId, verdict: 'supported' })) },
				tokenUsage: undefined,
				modelUsed: 'stub-model',
			};
		}
	);
});

async function eligibleSource(t: Test) {
	await enableFeatures(t, ['ai']);
	const seeded = await seedMailThread(t, { text: TEXT });
	const source = { kind: 'mail' as const, id: seeded.messageId };
	await t.run((ctx) => captureInterpretSource(ctx, { source, isLive: true }));
	return { ...seeded, source };
}

const leaseOf = (t: Test, messageId: string) =>
	t.run(async (ctx) => {
		const row = await ctx.db
			.query('interpretSources')
			.withIndex('by_source_key', (q) => q.eq('sourceKey', `mail:${messageId}`))
			.first();
		return { token: row?.leaseToken ?? null, until: row?.leaseUntil ?? null };
	});

describe('per-source lease', () => {
	it('two overlapping runs of one source buy exactly one extraction', async () => {
		const t = convexTest(schema, modules);
		const { source, messageId } = await eligibleSource(t);

		const results = await Promise.all([
			t.action(internal.mail.interpret.run.interpretMessage, { source }),
			t.action(internal.mail.interpret.run.interpretMessage, { source }),
		]);

		expect(extractions()).toBe(1);
		expect(results.map((r) => r.status).sort()).toEqual(['busy', 'complete']);
		const busy = results.find((r) => r.status === 'busy') as { retryAt: number };
		expect(busy.retryAt).toBeGreaterThan(Date.now());
		// The commit released the lease; a later run replays, with no model call.
		expect(await leaseOf(t, messageId)).toEqual({ token: null, until: null });
		const later = await t.action(internal.mail.interpret.run.interpretMessage, { source });
		expect(later).toMatchObject({ status: 'complete', isReplayed: true });
		expect(extractions()).toBe(1);
	});

	it('keeps the lease across a restart, so a run that starts meanwhile buys nothing', async () => {
		const t = convexTest(schema, modules);
		const { source, messageId } = await eligibleSource(t);
		let overlapping: Awaited<ReturnType<typeof t.action>> | undefined;
		llm.beforeExtraction = async (n) => {
			// The body changes under the first read: its commit answers
			// sourceChanged and the run starts over.
			if (n === 1) {
				await t.run((ctx) => ctx.db.patch(messageId, { textBodyInline: `${TEXT} Thanks!` }));
			}
			// While the restarted read is in flight, another run of the source starts.
			if (n === 2) {
				overlapping = await t.action(internal.mail.interpret.run.interpretMessage, { source });
			}
		};

		const out = await t.action(internal.mail.interpret.run.interpretMessage, { source });

		expect(overlapping).toMatchObject({ status: 'busy' });
		expect(out).toMatchObject({ status: 'complete', isReplayed: false });
		// The first read and the restarted one; the overlapping run bought none.
		expect(extractions()).toBe(2);
		expect(await leaseOf(t, messageId)).toEqual({ token: null, until: null });
	});

	it('refuses a commit whose lease was given up, even with nobody holding it now', async () => {
		const t = convexTest(schema, modules);
		const { source, messageId } = await eligibleSource(t);
		llm.beforeExtraction = async () => {
			// Another run took the source over and finished meanwhile.
			await t.run(async (ctx) => {
				const row = await ctx.db
					.query('interpretSources')
					.withIndex('by_source_key', (q) => q.eq('sourceKey', `mail:${messageId}`))
					.first();
				await ctx.db.patch(row!._id, { leaseToken: undefined, leaseUntil: undefined });
			});
		};

		const out = await t.action(internal.mail.interpret.run.interpretMessage, { source });

		expect(out.status).toBe('busy');
		const rows = await t.run((ctx) => ctx.db.query('messageInterpretations').collect());
		expect(rows).toEqual([]);
	});

	it('claims by compare-and-set: busy while held, free again once released or expired', async () => {
		const t = convexTest(schema, modules);
		const { source } = await eligibleSource(t);
		const claim = (args = {}) =>
			t.mutation(internal.mail.interpret.lease.claimSourceLease, { source, ...args });

		const first = await claim();
		expect(first.kind).toBe('claimed');
		const second = await claim();
		expect(second).toEqual({ kind: 'busy', retryAt: expect.any(Number) });

		// Another run's token releases nothing.
		await t.mutation(internal.mail.interpret.lease.releaseSourceLease, { source, token: 'x' });
		expect((await claim()).kind).toBe('busy');
		const token = (first as { token: string }).token;
		await t.mutation(internal.mail.interpret.lease.releaseSourceLease, { source, token });
		expect((await claim()).kind).toBe('claimed');

		// A lease outlives no action: past its end, a new run may take it.
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(Date.now() + LEASE_MS + 1);
			expect((await claim()).kind).toBe('claimed');
		} finally {
			vi.useRealTimers();
		}
	});

	it('answers done for a source already terminal at the depth asked for', async () => {
		const t = convexTest(schema, modules);
		const { source, messageId } = await eligibleSource(t);
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('interpretSources')
				.withIndex('by_source_key', (q) => q.eq('sourceKey', `mail:${messageId}`))
				.first();
			await ctx.db.patch(row!._id, { readOutcome: 'skipped' });
		});
		const claim = (depth: 'count' | 'gist' | 'full') =>
			t.mutation(internal.mail.interpret.lease.claimSourceLease, { source, depth });
		expect(await claim('count')).toEqual({ kind: 'done' });
		// A skip does not cover a gist or a full read (the upgrade rule may ask).
		expect((await claim('gist')).kind).toBe('claimed');
	});

	it('refuses a commit whose lease another run holds now', async () => {
		const t = convexTest(schema, modules);
		const { source, messageId } = await eligibleSource(t);
		// This run's lease ran out mid-run and another run took the source over.
		const theirs = await t.mutation(internal.mail.interpret.lease.claimSourceLease, { source });
		expect(theirs.kind).toBe('claimed');

		const out = await t.action(internal.mail.interpret.run.interpretMessage, { source });
		expect(out.status).toBe('busy');
		expect(extractions()).toBe(0);
		expect((await leaseOf(t, messageId)).token).toBe((theirs as { token: string }).token);
		const rows = await t.run((ctx) => ctx.db.query('messageInterpretations').collect());
		expect(rows).toEqual([]);
	});

	it('the category ceiling waits out a live lease instead of starting a run that is busy', async () => {
		const t = convexTest(schema, modules);
		const { source, messageId } = await eligibleSource(t);
		const until = Date.now() + CATEGORY_SETTLE_MS;
		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('interpretSources')
				.withIndex('by_source_key', (q) => q.eq('sourceKey', `mail:${messageId}`))
				.first();
			await ctx.db.patch(row!._id, { categoryDeferredUntil: until });
		});
		await t.mutation(internal.mail.interpret.lease.claimSourceLease, { source });

		const ceiling = await t.mutation(internal.mail.interpret.categoryDefer.settleAtCeiling, {
			source,
			until,
		});
		expect(ceiling).toEqual({ isScheduled: false });
		const jobs = await t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect()).map((job) => ({
				name: job.name,
				at: job.scheduledTime,
			}))
		);
		const lease = await leaseOf(t, messageId);
		expect(jobs).toEqual([{ name: expect.stringContaining('settleAtCeiling'), at: lease.until }]);
	});
});

describe('verdict-dependent callers on a contended source', () => {
	const args = { threadId: 'thread' as never };
	const scheduler = () => {
		const runAfter = vi.fn(async () => undefined);
		return { ctx: { scheduler: { runAfter } } as never, runAfter };
	};

	it('continue instead of settling on the heuristic: busy soon, wait at its end', async () => {
		const now = Date.now();
		const busy = scheduler();
		expect(await continuesLater(busy.ctx, { status: 'busy', retryAt: now + LEASE_MS }, args)).toBe(
			true
		);
		const [busyDelay] = busy.runAfter.mock.calls[0] as unknown as [number];
		expect(busyDelay).toBeLessThanOrEqual(BUSY_RECHECK_MS);

		const wait = scheduler();
		const retryAt = now + CATEGORY_SETTLE_MS;
		expect(await continuesLater(wait.ctx, { status: 'wait', retryAt }, args)).toBe(true);
		const [waitDelay] = wait.runAfter.mock.calls[0] as unknown as [number];
		expect(waitDelay).toBeGreaterThan(CATEGORY_SETTLE_MS - 1_000);

		const settled = scheduler();
		expect(await continuesLater(settled.ctx, { status: 'complete' }, args)).toBe(false);
		expect(settled.runAfter).not.toHaveBeenCalled();
	});
});
