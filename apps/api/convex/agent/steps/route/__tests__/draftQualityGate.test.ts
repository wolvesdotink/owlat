/**
 * Draft-quality gate tests for `routeStep.execute` + `resolveAutoApproveScore`.
 *
 * These cover the change from gating auto-send on the CLASSIFIER's confidence to
 * gating on the DRAFT-QUALITY self-check:
 *   - high draft quality + autonomy on  → auto_approve
 *   - low draft quality                 → human_review, even when the classifier
 *                                         was highly confident
 *   - self-check failure (no draftQuality) → human_review; never auto-approves
 *     on unknown quality
 *
 * The fake ctx makes `checkPermissionInternal` HONOUR the confidence it is
 * passed (allowed only when confidence >= the per-category threshold), so the
 * test observes which score actually drove the decision — the classifier
 * confidence or the draft-quality score.
 */

import { describe, it, expect } from 'vitest';
import { getFunctionName } from 'convex/server';
import { routeStep, resolveAutoApproveScore, type RouteInput } from '../index';
import type { Id } from '../../../../_generated/dataModel';

const messageId = 'msg_test' as Id<'inboundMessages'>;

const cleanDraft = 'Thanks for reaching out — happy to help with your order.';

/**
 * Fake execute ctx.
 * @param opts.autonomyThreshold per-category autonomy threshold (tier 2). When
 *        set, checkPermissionInternal returns mode:'enabled' and allows only
 *        when the passed confidence >= this threshold.
 * @param opts.legacyThreshold when set (and autonomyThreshold unset), tier 2 is
 *        'disabled' and tier 3 legacy config gates on this threshold.
 */
function makeExecuteCtx(opts: {
	autonomyThreshold?: number;
	legacyThreshold?: number;
	draftResponse?: string;
}) {
	const draftResponse = opts.draftResponse ?? cleanDraft;
	return {
		runQuery: async (ref: unknown, params?: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('getCircuitBreakersInternal')) return [];
			if (name.includes('checkPermissionInternal')) {
				if (opts.autonomyThreshold === undefined) {
					return { mode: 'disabled', allowed: false };
				}
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
					draftResponse,
					securityFlags: { guardUnavailable: false },
				};
			}
			if (name.includes('getAgentConfig')) {
				if (opts.legacyThreshold === undefined) return null;
				return {
					isAutoReplyEnabled: true,
					confidenceThreshold: opts.legacyThreshold,
					dailyAutoReplyCount: 0,
					maxDailyAutoReplies: 100,
					dailyAutoReplyResetAt: 0,
				};
			}
			throw new Error(`unexpected runQuery: ${name}`);
		},
		runMutation: async (ref: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('incrementDailyCount')) return { allowed: true };
			throw new Error(`unexpected runMutation: ${name}`);
		},
	} as unknown as Parameters<typeof routeStep.execute>[0];
}

function input(over: Partial<RouteInput> = {}): RouteInput {
	return {
		inboundMessageId: messageId,
		// Classifier is HIGHLY confident by default — the tests prove auto-send no
		// longer rides on this value.
		confidence: over.confidence ?? 0.95,
		category: over.category ?? 'support',
		draftQuality: over.draftQuality,
	};
}

const highQuality = { score: 0.92, complete: true, grounded: true, flags: [] as string[] };
const lowQuality = { score: 0.2, complete: false, grounded: false, flags: ['missing order number'] };

describe('resolveAutoApproveScore', () => {
	it('returns the draft-quality score when the self-check ran', () => {
		expect(resolveAutoApproveScore(highQuality)).toBe(0.92);
		expect(resolveAutoApproveScore(lowQuality)).toBe(0.2);
	});

	it('returns LOW (0) when the self-check is unknown/failed', () => {
		expect(resolveAutoApproveScore(null)).toBe(0);
		expect(resolveAutoApproveScore(undefined)).toBe(0);
	});
});

describe('routeStep.execute — autonomy tier gates on draft quality', () => {
	it('auto-approves when draft quality is high and autonomy permits', async () => {
		const ctx = makeExecuteCtx({ autonomyThreshold: 0.7 });
		const { output } = await routeStep.execute(ctx, input({ draftQuality: highQuality }));
		expect(output.decision).toBe('auto_approve');
	});

	it('routes to human review when draft quality is LOW even though the classifier was confident', async () => {
		const ctx = makeExecuteCtx({ autonomyThreshold: 0.7 });
		// Classifier confidence 0.95 would have cleared the threshold under the old
		// behaviour; the draft-quality score 0.2 must not.
		const { output } = await routeStep.execute(ctx, input({ confidence: 0.95, draftQuality: lowQuality }));
		expect(output.decision).toBe('human_review');
	});

	it('never auto-approves when the self-check failed (unknown quality)', async () => {
		const ctx = makeExecuteCtx({ autonomyThreshold: 0.7 });
		const { output } = await routeStep.execute(ctx, input({ confidence: 0.99, draftQuality: null }));
		expect(output.decision).toBe('human_review');
	});
});

describe('routeStep.execute — legacy tier gates on draft quality', () => {
	it('auto-approves a high-quality draft under the legacy confidence threshold', async () => {
		const ctx = makeExecuteCtx({ legacyThreshold: 0.8 });
		const { output } = await routeStep.execute(ctx, input({ draftQuality: highQuality }));
		expect(output.decision).toBe('auto_approve');
		expect(output.reason).toMatch(/draft quality/i);
	});

	it('routes a LOW-quality draft to human review despite a confident classifier', async () => {
		const ctx = makeExecuteCtx({ legacyThreshold: 0.8 });
		const { output } = await routeStep.execute(ctx, input({ confidence: 0.99, draftQuality: lowQuality }));
		expect(output.decision).toBe('human_review');
		expect(output.reason).toMatch(/draft quality/i);
	});

	it('routes to human review when the self-check failed (unknown quality)', async () => {
		const ctx = makeExecuteCtx({ legacyThreshold: 0.8 });
		const { output } = await routeStep.execute(ctx, input({ confidence: 0.99, draftQuality: undefined }));
		expect(output.decision).toBe('human_review');
	});
});
