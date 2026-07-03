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
 * whether it actually sends. `shadowEnabled` toggles the shadow gate; captured
 * `recordShadowDecision` args are pushed into `recorded`.
 */
function makeCtx(shadowEnabled: boolean, recorded: Recorded[]) {
	return {
		runQuery: async (ref: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('getCircuitBreakersInternal')) return [];
			if (name.includes('checkPermissionInternal'))
				return { mode: 'enabled', allowed: true, reason: 'rule permits' };
			if (name.includes('getMessage'))
				return {
					from: 'Alice Customer <alice@customer.example>',
					draftResponse: cleanDraft,
					securityFlags: { guardUnavailable: false },
				};
			if (name.includes('getShadowMode')) return { enabled: shadowEnabled };
			throw new Error(`unexpected runQuery: ${name}`);
		},
		runMutation: async (ref: unknown, args: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('incrementDailyCount')) return { allowed: true };
			if (name.includes('recordShadowDecision')) {
				recorded.push(args as Recorded);
				return null;
			}
			if (name.includes('recordAgentDecision')) return null;
			throw new Error(`unexpected runMutation: ${name}`);
		},
	} as unknown as Parameters<typeof routeStep.execute>[0];
}

describe('routeStep.execute — shadow mode', () => {
	it('logs a would-have-sent observation and routes to human review instead of sending', async () => {
		const recorded: Recorded[] = [];
		const ctx = makeCtx(true, recorded);

		const { output } = await routeStep.execute(ctx, sampleInput);

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
		const recorded: Recorded[] = [];
		// checkPermissionInternal denies → decision is human_review before shadow.
		const ctx = {
			runQuery: async (ref: unknown) => {
				const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
				if (name.includes('getCircuitBreakersInternal')) return [];
				if (name.includes('checkPermissionInternal'))
					return { mode: 'enabled', allowed: false, reason: 'below threshold' };
				if (name.includes('getShadowMode')) return { enabled: true };
				throw new Error(`unexpected runQuery: ${name}`);
			},
			runMutation: async (ref: unknown, args: unknown) => {
				const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
				if (name.includes('recordShadowDecision')) {
					recorded.push(args as Recorded);
					return null;
				}
				if (name.includes('recordAgentDecision')) return null;
				throw new Error(`unexpected runMutation: ${name}`);
			},
		} as unknown as Parameters<typeof routeStep.execute>[0];

		const { output } = await routeStep.execute(ctx, sampleInput);
		expect(output.decision).toBe('human_review');
		expect(recorded).toHaveLength(1);
		expect(recorded[0]!.wouldHaveSent).toBe(false);
	});

	it('sends for real (auto_approve) when shadow mode is off', async () => {
		const recorded: Recorded[] = [];
		const ctx = makeCtx(false, recorded);

		const { output } = await routeStep.execute(ctx, sampleInput);

		expect(output.decision).toBe('auto_approve');
		expect(recorded).toHaveLength(0);
	});
});
