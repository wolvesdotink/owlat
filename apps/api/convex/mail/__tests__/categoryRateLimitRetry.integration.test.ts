/**
 * A rate-limited category refinement is tried again. Keeping the `other`
 * baseline for good would let a stranger's newsletter through the
 * interpretation bulk rule, so a rate-limited gate schedules the same
 * refinement again, backed off, at most `MAX_RATE_LIMIT_RETRIES` times;
 * a budget refusal still defers the run instead.
 *
 * Runs the real action with no session (a scheduled function) and the model
 * seam mocked. Only `Date` is faked, so the token bucket refills when the
 * clock moves and convex-test's own timers stay real.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { enableFeatures } from '../../__tests__/factories';
import { AdmissionRefusedError } from '../../lib/llm/admissionPort';
import { modules, seedFolder, seedMailbox, seedMessage } from './helpers.testlib';
import { MAX_RATE_LIMIT_RETRIES, rateLimitRetryDelayMs } from '../ai/categoryClassify';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return { ...actual, getBetterAuthSessionWithRole: vi.fn(async () => null) };
});

const runLlmObjectMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/llmProvider', async () => {
	const actual = await vi.importActual<object>('../../lib/llmProvider');
	return { ...actual, resolveLanguageModel: vi.fn(() => 'test-model') };
});

vi.mock('../../lib/llm/dispatch', async () => {
	const actual = await vi.importActual<object>('../../lib/llm/dispatch');
	return { ...actual, runLlmObject: runLlmObjectMock };
});

type T = TestConvex<typeof schema>;

const T0 = Date.UTC(2026, 9, 17, 8, 0);

beforeEach(() => {
	runLlmObjectMock.mockReset();
	runLlmObjectMock.mockResolvedValue({
		object: { category: 'newsletter' },
		tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
		modelUsed: 'test-model',
	});
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T0);
});
afterEach(() => {
	vi.useRealTimers();
});

async function ambiguousThread(t: T): Promise<Id<'mailThreads'>> {
	const mailboxId = await seedMailbox(t, { userId: 'owner-a', address: 'a@owlat.test' });
	await seedFolder(t, mailboxId, 'inbox');
	const messageId = await seedMessage(t, mailboxId, { subject: 'Quick question' });
	return t.run(async (ctx) => (await ctx.db.get(messageId))!.threadId);
}

async function setup(): Promise<{ t: T; threadId: Id<'mailThreads'> }> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['ai']);
	return { t, threadId: await ambiguousThread(t) };
}

async function drainOwnerBucket(t: T): Promise<void> {
	for (let i = 0; i < 200; i++) {
		const isRefused = await t
			.mutation(internal.mail.ai.gate.assertAiAllowed, { ownerUserId: 'owner-a' })
			.then(
				() => false,
				() => true
			);
		if (isRefused) return;
	}
	throw new Error('the background bucket never refused');
}

async function classifyJobs(t: T) {
	return t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect())
			.filter((job) => job.name.includes('categoryClassify'))
			.map((job) => ({
				at: job.scheduledTime,
				args: (job.args[0] ?? {}) as Record<string, unknown>,
			}))
	);
}

const categoryOf = (t: T, threadId: Id<'mailThreads'>) =>
	t.run(async (ctx) => (await ctx.db.get(threadId))?.category);

describe('category refinement: rate-limit retry', () => {
	it('tries a rate-limited refinement again later, and the retry refines', async () => {
		const { t, threadId } = await setup();
		await drainOwnerBucket(t);

		await t.action(internal.mail.ai.categoryClassify.classifyThread, { threadId });

		expect(await categoryOf(t, threadId)).toMatchObject({ label: 'other', source: 'heuristic' });
		expect(runLlmObjectMock).not.toHaveBeenCalled();
		const [retry, ...rest] = await classifyJobs(t);
		expect(rest).toEqual([]);
		expect(retry!.args).toEqual({ threadId, baselineApplied: true, rateLimitRetries: 1 });
		expect(retry!.at - T0).toBeGreaterThanOrEqual(30_000);
		expect(retry!.at - T0).toBeLessThan(45_000);

		// The bucket refills while the retry waits; the retry gets its answer.
		vi.setSystemTime(retry!.at);
		await t.action(internal.mail.ai.categoryClassify.classifyThread, {
			...(retry!.args as { threadId: Id<'mailThreads'> }),
		});
		expect(await categoryOf(t, threadId)).toMatchObject({ label: 'newsletter', source: 'llm' });
	});

	it('keeps the baseline once the retries are used up', async () => {
		const { t, threadId } = await setup();
		await drainOwnerBucket(t);

		await t.action(internal.mail.ai.categoryClassify.classifyThread, {
			threadId,
			baselineApplied: true,
			rateLimitRetries: MAX_RATE_LIMIT_RETRIES,
		});

		expect(await classifyJobs(t)).toEqual([]);
		expect(runLlmObjectMock).not.toHaveBeenCalled();
	});

	it('defers a budget refusal instead of retrying it as a rate limit', async () => {
		const { t, threadId } = await setup();
		runLlmObjectMock.mockRejectedValue(new AdmissionRefusedError('daily_ceiling', 'ceiling'));

		await t.action(internal.mail.ai.categoryClassify.classifyThread, { threadId });

		const jobs = await classifyJobs(t);
		expect(jobs.map((job) => job.args)).toEqual([{ threadId, deferrals: 1 }]);
	});
});

describe('rateLimitRetryDelayMs', () => {
	it('doubles from 30 s, honours a longer retryAfter, caps each wait, and jitters', () => {
		const none = () => 0;
		expect([0, 1, 2].map((attempt) => rateLimitRetryDelayMs(attempt, undefined, none))).toEqual([
			30_000, 60_000, 120_000,
		]);
		expect(rateLimitRetryDelayMs(0, 90_000, none)).toBe(90_000);
		expect(rateLimitRetryDelayMs(0, 60 * 60_000, none)).toBe(4 * 60_000);
		expect(rateLimitRetryDelayMs(0, undefined, () => 0.999)).toBeLessThan(45_000);
		// All tries together stay inside the 10-minute category settle time.
		const worst = [0, 1, 2].reduce(
			(sum, attempt) => sum + rateLimitRetryDelayMs(attempt, undefined, () => 0.999),
			0
		);
		expect(worst).toBeLessThan(10 * 60_000);
	});
});
