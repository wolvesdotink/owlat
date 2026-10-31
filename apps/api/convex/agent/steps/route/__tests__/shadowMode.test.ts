/**
 * Shadow ("would-have-sent") mode tests for `routeStep.execute`.
 *
 * When shadow mode is on, an auto-approve decision must NOT send: it is logged
 * as a would-have-sent observation and the message is routed to human review
 * instead (draft_ready). When shadow mode is off, the real auto-send decision
 * stands. Uses a fake ctx that dispatches on the shared `internal.*` refs, same
 * pattern as the sibling route tests.
 */

import { describe, it, expect } from 'vitest';
import { makeStepCtx, writesOf } from '../../__tests__/stepCtx';
import { getFunctionName } from 'convex/server';
import { routeStep } from '../index';
import type { Id } from '../../../../_generated/dataModel';

const messageId = 'msg_shadow' as Id<'inboundMessages'>;
const cleanDraft = 'Thanks for reaching out — happy to help with your order.';

const sampleInput = {
	inboundMessageId: messageId,
	confidence: 0.95,
	category: 'support',
	draftQuality: { score: 0.95, complete: true, grounded: true, flags: [] as string[] },
};

type Recorded = {
	inboundMessageId: Id<'inboundMessages'>;
	category: string;
	wouldHaveSent: boolean;
	reason: string;
	confidence: number;
	draftQualityScore?: number;
};

/**
 * Fake ctx where autonomy PERMITS auto-approval and the draft is clean, so the
 * decision computed by `decide()` is auto_approve — then shadow mode decides
 * whether it actually sends. `shadowEnabled` toggles the shadow gate. The step
 * returns its shadow observation as a write for the walker's commit.
 */
function makeCtx(shadowEnabled: boolean) {
	return makeStepCtx<Parameters<typeof routeStep.execute>[0]>({
		queries: {
			getBudgetStatus: { autonomousAutoSendAllowed: true },
			interpretationHold: { reason: null },
			itemCoverageCheck: { objections: [], reason: null, isEnforced: false },
			appliedVerdictInputs: {
				applied: [],
				isTruncated: false,
				isItemCoverageEnforced: false,
				current: null,
			},
			getCircuitBreakersInternal: [],
			checkPermissionInternal: { mode: 'enabled', allowed: true, reason: 'rule permits' },
			getMessage: {
				from: 'Alice Customer <alice@customer.example>',
				draftResponse: cleanDraft,
				securityFlags: { guardUnavailable: false },
			},
			getShadowMode: { enabled: shadowEnabled },
		},
		mutations: {
			incrementDailyCount: { allowed: true },
		},
	});
}

const shadowWrites = (writes: Parameters<typeof writesOf>[0]) =>
	writesOf(writes, 'shadow_decision') as Recorded[];

describe('routeStep.execute — shadow mode', () => {
	it('logs a would-have-sent observation and routes to human review instead of sending', async () => {
		const ctx = makeCtx(true);

		const { output, writes } = await routeStep.execute(ctx, sampleInput);
		const recorded = shadowWrites(writes);

		// No send: decision is downgraded to human review with the shadow reason.
		expect(output.decision).toBe('human_review');
		expect(output.reason).toMatch(/shadow mode/i);

		// The would-have-sent decision was recorded for the scorecard.
		expect(recorded).toHaveLength(1);
		expect(recorded[0]!.wouldHaveSent).toBe(true);
		expect(recorded[0]!.category).toBe('support');
		expect(recorded[0]!.draftQualityScore).toBe(0.95);

		// And the terminal transition is draft_ready (human review), never approved.
		const routed = routeStep.route(output, sampleInput, {
			inboundMessageId: messageId,
			agentConfig: null,
		});
		expect(routed.kind).toBe('transition');
		if (routed.kind !== 'transition') return;
		expect(routed.transition.to).toBe('draft_ready');
	});

	it('records a would-hold observation when the decision was already human review', async () => {
		// checkPermissionInternal denies → decision is human_review before shadow.
		const ctx = {
			runQuery: async (ref: unknown) => {
				const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
				if (name.includes('getBudgetStatus')) return { autonomousAutoSendAllowed: true };
				if (name.includes('interpretationHold')) return { reason: null };
				if (name.includes('itemCoverageCheck'))
					return { objections: [], reason: null, isEnforced: false };
				if (name.includes('appliedVerdictInputs'))
					return { applied: [], isTruncated: false, isItemCoverageEnforced: false, current: null };
				if (name.includes('getCircuitBreakersInternal')) return [];
				if (name.includes('checkPermissionInternal'))
					return { mode: 'enabled', allowed: false, reason: 'below threshold' };
				if (name.includes('getShadowMode')) return { enabled: true };
				throw new Error(`unexpected runQuery: ${name}`);
			},
			runMutation: async (ref: unknown) => {
				const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
				throw new Error(`unexpected runMutation: ${name}`);
			},
		} as unknown as Parameters<typeof routeStep.execute>[0];

		const { output, writes } = await routeStep.execute(ctx, sampleInput);
		const recorded = shadowWrites(writes);
		expect(output.decision).toBe('human_review');
		expect(recorded).toHaveLength(1);
		expect(recorded[0]!.wouldHaveSent).toBe(false);
	});

	it('sends for real (auto_approve) when shadow mode is off', async () => {
		const ctx = makeCtx(false);

		const { output, writes } = await routeStep.execute(ctx, sampleInput);

		expect(output.decision).toBe('auto_approve');
		expect(shadowWrites(writes)).toHaveLength(0);
	});

	it('routes to human review before the observation is recorded, by the commit', async () => {
		// No mutation route: the step records nothing itself, so a failing shadow
		// write (best-effort in the commit) can never turn into a send.
		const ctx = makeCtx(true);

		const { output, writes } = await routeStep.execute(ctx, sampleInput);
		expect(output.decision).toBe('human_review');
		expect(writes?.map((write) => write.kind)).toEqual(['shadow_decision', 'agent_decision']);
	});

	it('treats an unreadable shadow setting as shadow on', async () => {
		const ctx = makeStepCtx<Parameters<typeof routeStep.execute>[0]>({
			queries: {
				getBudgetStatus: { autonomousAutoSendAllowed: true },
				interpretationHold: { reason: null },
				itemCoverageCheck: { objections: [], reason: null, isEnforced: false },
				appliedVerdictInputs: {
					applied: [],
					isTruncated: false,
					isItemCoverageEnforced: false,
					current: null,
				},
				getCircuitBreakersInternal: [],
				checkPermissionInternal: { mode: 'enabled', allowed: true, reason: 'rule permits' },
				getMessage: {
					from: 'Alice Customer <alice@customer.example>',
					draftResponse: cleanDraft,
					securityFlags: { guardUnavailable: false },
				},
				getShadowMode: () => {
					throw new Error('config read failed');
				},
			},
		});

		const { output, writes } = await routeStep.execute(ctx, sampleInput);
		expect(output.decision).toBe('human_review');
		expect(shadowWrites(writes)).toHaveLength(1);
	});

	it('does not charge the per-category daily cap while shadow is on', async () => {
		const charged: unknown[] = [];
		const ctx = makeStepCtx<Parameters<typeof routeStep.execute>[0]>({
			queries: {
				getBudgetStatus: { autonomousAutoSendAllowed: true },
				interpretationHold: { reason: null },
				itemCoverageCheck: { objections: [], reason: null, isEnforced: false },
				appliedVerdictInputs: {
					applied: [],
					isTruncated: false,
					isItemCoverageEnforced: false,
					current: null,
				},
				getCircuitBreakersInternal: [],
				checkPermissionInternal: { mode: 'enabled', allowed: true, reason: 'rule permits' },
				getMessage: {
					from: 'Alice Customer <alice@customer.example>',
					draftResponse: cleanDraft,
					securityFlags: { guardUnavailable: false },
				},
				getShadowMode: { enabled: true },
			},
			mutations: {
				incrementDailyCount: (args) => {
					charged.push(args);
					return { allowed: true };
				},
			},
		});

		const { output } = await routeStep.execute(ctx, sampleInput);
		expect(output.decision).toBe('human_review');
		expect(charged).toHaveLength(0);
	});
});
