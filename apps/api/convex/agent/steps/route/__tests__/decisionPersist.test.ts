/**
 * `routeStep.execute` decision-explainability persistence.
 *
 * The route step already computes a precise human-readable reason for every
 * auto-approve / human-review outcome; this asserts that reason — plus the
 * decision and the classifier confidence — is MIRRORED onto the inbound
 * message by an `agent_decision` write the walker's step commit applies, so the
 * review UI can show "Sent because… / Held because…". The routing decision
 * itself is unchanged (the returned output.decision matches the write). The
 * commit applies it best-effort (agent/__tests__/stepWrites.test.ts).
 */

import { describe, it, expect } from 'vitest';
import { makeStepCtx, writeOf } from '../../__tests__/stepCtx';
import { routeStep, type RouteInput } from '../index';
import type { Id } from '../../../../_generated/dataModel';

const messageId = 'msg_test' as Id<'inboundMessages'>;
const cleanDraft = 'Thanks for reaching out — happy to help with your order.';

function makeCtx(opts: { autonomyThreshold?: number }) {
	const ctx = makeStepCtx<Parameters<typeof routeStep.execute>[0]>({
		queries: {
			getCircuitBreakersInternal: [],
			checkPermissionInternal: (params) => {
				if (opts.autonomyThreshold === undefined) return { mode: 'disabled', allowed: false };
				const confidence = (params as { confidence: number }).confidence;
				const allowed = confidence >= opts.autonomyThreshold;
				return {
					mode: 'enabled',
					allowed,
					reason: allowed ? 'rule permits' : 'below per-category threshold',
				};
			},
			getMessage: {
				from: 'Alice Customer <alice@customer.example>',
				draftResponse: cleanDraft,
				securityFlags: { guardUnavailable: false },
			},
			getAgentConfig: null,
			getBudgetStatus: { autonomousAutoSendAllowed: true },
			interpretationHold: { reason: null },
			itemCoverageCheck: { objections: [], reason: null, isEnforced: false },
			appliedVerdictInputs: {
				applied: [],
				isTruncated: false,
				isItemCoverageEnforced: false,
				current: null,
			},
			// Shadow off: these cases exercise the real send decision.
			getShadowMode: { enabled: false },
		},
		mutations: {
			incrementDailyCount: { allowed: true },
		},
	});
	return { ctx };
}

function input(over: Partial<RouteInput> = {}): RouteInput {
	return {
		inboundMessageId: messageId,
		confidence: over.confidence ?? 0.95,
		category: over.category ?? 'support',
		draftQuality: over.draftQuality,
	};
}

const highQuality = { score: 0.92, complete: true, grounded: true, flags: [] as string[] };
const lowQuality = {
	score: 0.2,
	complete: false,
	grounded: false,
	flags: ['missing order number'],
};

describe('routeStep.execute — decision persistence', () => {
	it('mirrors an auto_approve decision + reason + confidence onto the message', async () => {
		const { ctx } = makeCtx({ autonomyThreshold: 0.7 });
		const { output, writes } = await routeStep.execute(
			ctx,
			input({ confidence: 0.81, draftQuality: highQuality })
		);

		expect(output.decision).toBe('auto_approve');
		expect(writeOf(writes, 'agent_decision')).toEqual({
			decision: 'auto_approve',
			reason: output.reason,
			// The CLASSIFIER confidence (input.confidence), not the gate score.
			confidence: 0.81,
		});
	});

	it('mirrors a human_review decision + reason when the draft quality is low', async () => {
		const { ctx } = makeCtx({ autonomyThreshold: 0.7 });
		const { output, writes } = await routeStep.execute(
			ctx,
			input({ confidence: 0.95, draftQuality: lowQuality })
		);

		expect(output.decision).toBe('human_review');
		const recorded = writeOf(writes, 'agent_decision');
		expect(recorded?.['decision']).toBe('human_review');
		expect(recorded?.['reason']).toBe(output.reason);
	});

	it('records nothing itself: the decision is a write for the commit', async () => {
		// No mutation route answers `recordAgentDecision`: calling it would throw.
		const { ctx } = makeCtx({ autonomyThreshold: 0.7 });
		const { writes } = await routeStep.execute(
			ctx,
			input({ confidence: 0.81, draftQuality: highQuality })
		);
		expect(writes?.map((write) => write.kind)).toEqual(['agent_decision']);
	});
});
