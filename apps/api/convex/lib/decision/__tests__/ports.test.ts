/**
 * The ctx-bound ports the dispatch is handed instead of a Convex ctx.
 *
 * Small surface, two properties worth pinning. The breaker port must read
 * "open" the way the dispatch asks the question (`isOpen`, from a status that
 * says `fallbackAllowed`) — an inversion here would turn the guard on the
 * expensive hop into permission for it. And the usage recorder must turn each
 * provider request of an attempt into a row that says what happened without
 * saying what the vendor said: a 429 is a throttle FLAG on the request
 * (`../attemptRequests.ts`, tested beside it), and the error itself is not
 * persisted, because an adapter's message can quote a vendor body and a ledger
 * row is not where anyone should discover that.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../../_generated/server';
import { decisionBreakerPort, decisionRateLimiterPort, decisionUsageRecorder } from '../ports';
import type { DecisionAttemptRecord } from '../contract';

function fakeCtx() {
	const runQuery = vi.fn(async (_ref: unknown, _args?: unknown) => ({
		fallbackAllowed: true,
		state: 'closed',
	}));
	// Typed with both arguments so a test can read the ARGS the port sent, which
	// is the whole of what a recorder does.
	const runMutation = vi.fn(async (_ref: unknown, _args?: unknown) => undefined);
	const ctx = { runQuery, runMutation } as unknown as ActionCtx;
	return { ctx, runQuery, runMutation };
}

const ATTEMPT: DecisionAttemptRecord = {
	feature: 'inbound_triage',
	requestId: 'decision-42',
	provider: 'typesafe',
	attempt: 1,
	fallback: false,
	outcome: 'answered',
	durationMs: 180,
	usage: { promptTokens: 1200, completionTokens: 8, totalTokens: 1208 },
	modelUsed: 'jev-1.13.0',
	calibrated: true,
	requests: [
		{
			attempt: 1,
			outcome: 'ok',
			latencyMs: 180,
			usage: { promptTokens: 1200, completionTokens: 8, totalTokens: 1208 },
			modelUsed: 'jev-1.13.0',
			// Tagged by the dispatch with the attempt that made it.
			isFallback: false,
			isCalibrated: true,
		},
	],
	task: 'mail.triage',
	root: { rootRequestId: 'team:msg-1' },
};

describe('decisionBreakerPort', () => {
	it('reads a closed breaker as "not open"', async () => {
		const { ctx, runQuery } = fakeCtx();
		await expect(decisionBreakerPort(ctx).isOpen()).resolves.toBe(false);
		expect(runQuery).toHaveBeenCalledTimes(1);
	});

	it('reads a breaker that refuses the hop as open', async () => {
		const { ctx } = fakeCtx();
		(ctx.runQuery as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
			fallbackAllowed: false,
			state: 'open',
		});
		await expect(decisionBreakerPort(ctx).isOpen()).resolves.toBe(true);
	});

	it('charges a failure through the mutation, not the query', async () => {
		const { ctx, runMutation, runQuery } = fakeCtx();
		await decisionBreakerPort(ctx).recordFailure();
		expect(runMutation).toHaveBeenCalledTimes(1);
		expect(runQuery).not.toHaveBeenCalled();
	});
});

describe('decisionUsageRecorder', () => {
	it('writes one decision-tagged row carrying the logical call id', async () => {
		const { ctx, runMutation } = fakeCtx();

		await decisionUsageRecorder(ctx)(ATTEMPT);

		expect(runMutation).toHaveBeenCalledTimes(1);
		expect(runMutation.mock.calls[0]?.[1]).toMatchObject({
			feature: 'inbound_triage',
			plane: 'decision',
			requestId: 'decision-42',
			// Flags travel on each request, never as call-level tags.
			requests: [expect.objectContaining({ isFallback: false, isCalibrated: true })],
		});
		expect(runMutation.mock.calls[0]?.[1]).not.toHaveProperty('isCalibrated');
	});

	it('writes one row per provider request of the attempt, with the routing context', async () => {
		const { ctx, runMutation } = fakeCtx();

		// The language-backed adapter retried inside one attempt: two requests.
		await decisionUsageRecorder(ctx)({
			...ATTEMPT,
			provider: 'llm',
			requests: [
				{ attempt: 1, outcome: 'failed', latencyMs: 30, isThrottled: true },
				{ ...ATTEMPT.requests[0]!, attempt: 2 },
			],
		});

		expect(runMutation).toHaveBeenCalledTimes(1);
		const args = runMutation.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(args).toMatchObject({
			plane: 'decision',
			task: 'mail.triage',
			rootRequestId: 'team:msg-1',
			requests: [
				{ attempt: 1, latencyMs: 30, isThrottled: true },
				{ attempt: 2, usage: ATTEMPT.usage, modelUsed: 'jev-1.13.0' },
			],
		});
		// The dispatch's own outcome field is not a ledger column.
		expect(JSON.stringify(args)).not.toContain('outcome');
	});

	it('keeps the vendor error out of a failed attempt’s row', async () => {
		const { ctx, runMutation } = fakeCtx();

		await decisionUsageRecorder(ctx)({
			...ATTEMPT,
			outcome: 'failed',
			usage: undefined,
			calibrated: undefined,
			error: Object.assign(new Error('HTTP 429 quoted vendor body'), { status: 429 }),
			requests: [{ attempt: 1, outcome: 'failed', latencyMs: 12, isThrottled: true }],
		});

		const args = (runMutation.mock.calls[0]?.[1] ?? {}) as Record<string, unknown>;
		// A failed attempt is still a row: the counters are about what the plane
		// DID, and a ledger that only sees answers cannot show an outage.
		expect(args['plane']).toBe('decision');
		expect(args['isCalibrated']).toBeUndefined();
		expect(JSON.stringify(args)).not.toContain('HTTP');
	});

	it('writes nothing for an attempt that made no request', async () => {
		const { ctx, runMutation } = fakeCtx();
		await decisionUsageRecorder(ctx)({ ...ATTEMPT, requests: [] });
		expect(runMutation).not.toHaveBeenCalled();
	});

	it('passes each request’s own local-engine tag through', async () => {
		const { ctx, runMutation } = fakeCtx();
		await decisionUsageRecorder(ctx)({
			...ATTEMPT,
			provider: 'local',
			requests: [{ ...ATTEMPT.requests[0]!, isLocalEngine: true }],
		});
		expect(runMutation.mock.calls[0]?.[1]).toMatchObject({
			requests: [expect.objectContaining({ isLocalEngine: true })],
		});
		expect(runMutation.mock.calls[0]?.[1]).not.toHaveProperty('isLocalEngine');
	});
});

describe('decisionRateLimiterPort', () => {
	it('charges one attempt token per reserve, keyed by provider kind', async () => {
		const { ctx, runMutation } = fakeCtx();
		await decisionRateLimiterPort(ctx).reserve('typesafe');
		expect(runMutation).toHaveBeenCalledTimes(1);
		expect(runMutation.mock.calls[0]?.[1]).toEqual({ provider: 'typesafe' });
	});

	it('lets a refusal through as a throw, for the dispatch to make terminal', async () => {
		const { ctx, runMutation } = fakeCtx();
		runMutation.mockRejectedValueOnce(new Error('rate limited'));
		await expect(decisionRateLimiterPort(ctx).reserve('local')).rejects.toThrow('rate limited');
	});
});
