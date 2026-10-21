/**
 * The outcome-sentiment admission hook: background work that
 * defers at the ceiling. No headroom, or a spend state that cannot be
 * verified, means no model call and nothing recorded; a refusal at the
 * dispatch itself is the same `null`; other failures are the caller's.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { withOutcomeSentimentAdmission } from '../outcomeFeedback';
import { AdmissionRefusedError } from '../../lib/llm/admissionPort';

const subject = { replyMessageId: 'reply-1' as Id<'inboundMessages'> };

function ctxWith(headroom: unknown) {
	const runQuery = vi.fn(async () => headroom);
	return { ctx: { runQuery } as unknown as ActionCtx, runQuery };
}

describe('withOutcomeSentimentAdmission', () => {
	it('runs the call with headroom, asking as background, standard work', async () => {
		const { ctx, runQuery } = ctxWith({ isAdmitted: true });
		await expect(withOutcomeSentimentAdmission(ctx, subject, async () => 'negative')).resolves.toBe(
			'negative'
		);
		expect(runQuery).toHaveBeenCalledWith(expect.anything(), {
			plane: 'language',
			budgetClass: 'standard',
			priority: 'background',
		});
	});

	it.each(['daily_ceiling', 'spend_unverifiable'] as const)(
		'makes no call and records nothing on %s',
		async (reason) => {
			const { ctx } = ctxWith({ isAdmitted: false, reason, limit: 'ceiling' });
			const call = vi.fn(async () => 'negative');
			await expect(withOutcomeSentimentAdmission(ctx, subject, call)).resolves.toBeNull();
			expect(call).not.toHaveBeenCalled();
		}
	);

	it('reads a refusal at the dispatch as the same deferral', async () => {
		const { ctx } = ctxWith({ isAdmitted: true });
		await expect(
			withOutcomeSentimentAdmission(ctx, subject, async () => {
				throw new AdmissionRefusedError('monthly_ceiling', 'ceiling');
			})
		).resolves.toBeNull();
	});

	it('lets any other failure through to the caller’s fail-soft', async () => {
		const { ctx } = ctxWith({ isAdmitted: true });
		await expect(
			withOutcomeSentimentAdmission(ctx, subject, async () => {
				throw new Error('provider down');
			})
		).rejects.toThrow('provider down');
	});
});
