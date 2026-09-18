/**
 * The ctx-bound ports the dispatch is handed instead of a Convex ctx.
 *
 * Small surface, two properties worth pinning. The breaker port must read
 * "open" the way the dispatch asks the question (`isOpen`, from a status that
 * says `fallbackAllowed`) — an inversion here would turn the guard on the
 * expensive hop into permission for it. And the usage recorder must turn an
 * attempt into a row that says what happened without saying what the vendor
 * said: a 429 becomes a throttle FLAG, and the error itself is not persisted,
 * because an adapter's message can quote a vendor body and a ledger row is not
 * where anyone should discover that.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../../_generated/server';
import { decisionBreakerPort, decisionUsageRecorder } from '../ports';
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
			isFallback: false,
			isCalibrated: true,
		});
	});

	it.each([
		[429, true],
		[529, true],
		[500, false],
		[401, false],
	])('reads HTTP %i as throttled: %s', async (status, throttled) => {
		const { ctx, runMutation } = fakeCtx();

		await decisionUsageRecorder(ctx)({
			...ATTEMPT,
			outcome: 'failed',
			usage: undefined,
			calibrated: undefined,
			error: Object.assign(new Error(`HTTP ${status}`), { status }),
		});

		const args = (runMutation.mock.calls[0]?.[1] ?? {}) as Record<string, unknown>;
		expect(args['isThrottled']).toBe(throttled);
		// A failed attempt is still a row: the counters are about what the plane
		// DID, and a ledger that only sees answers cannot show an outage.
		expect(args['plane']).toBe('decision');
		expect(args['isCalibrated']).toBeUndefined();
		// The vendor's error never reaches the row.
		expect(JSON.stringify(args)).not.toContain('HTTP');
	});
});
