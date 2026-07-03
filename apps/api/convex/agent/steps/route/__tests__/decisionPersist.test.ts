/**
 * `routeStep.execute` decision-explainability persistence.
 *
 * The route step already computes a precise human-readable reason for every
 * auto-approve / human-review outcome; this asserts that reason — plus the
 * decision and the classifier confidence — is now MIRRORED onto the inbound
 * message via `recordAgentDecision`, so the review UI can show "Sent because… /
 * Held because…". The routing decision itself is unchanged (the returned
 * output.decision matches what was persisted).
 *
 * FAIL-SOFT: a throwing `recordAgentDecision` must NOT change or block the
 * decision the step returns.
 */

import { describe, it, expect } from 'vitest';
import { getFunctionName } from 'convex/server';
import { routeStep, type RouteInput } from '../index';
import type { Id } from '../../../../_generated/dataModel';

const messageId = 'msg_test' as Id<'inboundMessages'>;
const cleanDraft = 'Thanks for reaching out — happy to help with your order.';

/** Captures the args handed to recordAgentDecision for persistence assertions. */
function makeCtx(opts: { autonomyThreshold?: number; recordThrows?: boolean }) {
	const recorded: { value: Record<string, unknown> | null } = { value: null };
	const ctx = {
		runQuery: async (ref: unknown, params?: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('getCircuitBreakersInternal')) return [];
			if (name.includes('checkPermissionInternal')) {
				if (opts.autonomyThreshold === undefined) return { mode: 'disabled', allowed: false };
				const confidence = (params as { confidence: number }).confidence;
				const allowed = confidence >= opts.autonomyThreshold;
				return {
					mode: 'enabled',
					allowed,
					reason: allowed ? 'rule permits' : 'below per-category threshold',
				};
			}
			if (name.includes('getMessage')) {
				return {
					from: 'Alice Customer <alice@customer.example>',
					draftResponse: cleanDraft,
					securityFlags: { guardUnavailable: false },
				};
			}
			if (name.includes('getAgentConfig')) return null;
			if (name.includes('getBudgetStatus')) return { autonomousAutoSendAllowed: true };
			throw new Error(`unexpected runQuery: ${name}`);
		},
		runMutation: async (ref: unknown, args: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('incrementDailyCount')) return { allowed: true };
			if (name.includes('recordAgentDecision')) {
				if (opts.recordThrows) throw new Error('boom');
				recorded.value = args as Record<string, unknown>;
				return null;
			}
			throw new Error(`unexpected runMutation: ${name}`);
		},
	} as unknown as Parameters<typeof routeStep.execute>[0];
	return { ctx, recorded };
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
		const { ctx, recorded } = makeCtx({ autonomyThreshold: 0.7 });
		const { output } = await routeStep.execute(
			ctx,
			input({ confidence: 0.81, draftQuality: highQuality })
		);

		expect(output.decision).toBe('auto_approve');
		expect(recorded.value).toEqual({
			inboundMessageId: messageId,
			decision: 'auto_approve',
			reason: output.reason,
			// The CLASSIFIER confidence (input.confidence), not the gate score.
			confidence: 0.81,
		});
	});

	it('mirrors a human_review decision + reason when the draft quality is low', async () => {
		const { ctx, recorded } = makeCtx({ autonomyThreshold: 0.7 });
		const { output } = await routeStep.execute(
			ctx,
			input({ confidence: 0.95, draftQuality: lowQuality })
		);

		expect(output.decision).toBe('human_review');
		expect(recorded.value?.['decision']).toBe('human_review');
		expect(recorded.value?.['reason']).toBe(output.reason);
	});

	it('FAILS SOFT: a throwing recordAgentDecision does not change or block the decision', async () => {
		const { ctx } = makeCtx({ autonomyThreshold: 0.7, recordThrows: true });
		const { output } = await routeStep.execute(
			ctx,
			input({ confidence: 0.81, draftQuality: highQuality })
		);
		// Decision still stands even though persistence threw.
		expect(output.decision).toBe('auto_approve');
	});
});
