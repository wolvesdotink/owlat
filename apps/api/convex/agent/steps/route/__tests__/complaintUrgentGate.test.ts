/**
 * Hard-rule tests: complaint / urgent mail is NEVER auto-send-eligible.
 *
 * Complaint / urgent mail now flows through the drafter (via the clarify step)
 * instead of skipping straight to a blank human-review box, so it reaches the
 * `route` step's auto-send logic for the first time. The final safety gate
 * (`assertSafeToAutoSend`) must fail closed on it regardless of autonomy tier or
 * draft-quality score — a human always reviews it.
 *
 * The fake ctx makes autonomy tier 2 ALLOW the send and the draft quality HIGH,
 * so any auto-approval that leaks through would be caught here.
 */

import { describe, it, expect } from 'vitest';
import { getFunctionName } from 'convex/server';
import { routeStep, type RouteInput } from '../index';
import type { Id } from '../../../../_generated/dataModel';

const messageId = 'msg_cu' as Id<'inboundMessages'>;
const cleanDraft = 'Thanks for reaching out — we take this seriously and will follow up.';
const highQuality = { score: 0.95, complete: true, grounded: true, flags: [] as string[] };

/** Fake ctx: autonomy PERMITS, draft is clean/high-quality, and getMessage
 * carries the given classification so the complaint/urgent hard block sees it. */
function makeCtx(classification: { category: string; priority: string } | undefined) {
	return {
		runQuery: async (ref: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('getCircuitBreakersInternal')) return [];
			if (name.includes('checkPermissionInternal')) {
				return { mode: 'enabled', allowed: true, reason: 'rule permits' };
			}
			if (name.includes('getMessage')) {
				return {
					from: 'Alice Customer <alice@customer.example>',
					draftResponse: cleanDraft,
					securityFlags: { guardUnavailable: false },
					...(classification ? { classification: { ...classification, sentiment: 'negative', intent: 'complaint', confidence: 0.9 } } : {}),
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
		confidence: 0.95,
		category: over.category ?? 'complaint',
		draftQuality: highQuality,
	};
}

describe('routeStep.execute — complaint/urgent never auto-send', () => {
	it('holds a complaint for human review even when autonomy permits and quality is high', async () => {
		const ctx = makeCtx({ category: 'complaint', priority: 'normal' });
		const { output } = await routeStep.execute(ctx, input({ category: 'complaint' }));
		expect(output.decision).toBe('human_review');
		expect(output.reason).toMatch(/never auto-sent/i);
	});

	it('holds urgent mail for human review even when the category rule permits', async () => {
		const ctx = makeCtx({ category: 'support', priority: 'urgent' });
		const { output } = await routeStep.execute(ctx, input({ category: 'support' }));
		expect(output.decision).toBe('human_review');
		expect(output.reason).toMatch(/never auto-sent/i);
	});

	it('still auto-approves ordinary mail (no complaint/urgent classification)', async () => {
		const ctx = makeCtx({ category: 'support', priority: 'normal' });
		const { output } = await routeStep.execute(ctx, input({ category: 'support' }));
		expect(output.decision).toBe('auto_approve');
	});
});
