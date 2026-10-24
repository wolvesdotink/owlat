/**
 * The AI spend budget refusal as people read it: the stable code
 * and its reason become catalog keys, never the server's English sentence.
 */
import { describe, expect, it } from 'vitest';
import { ConvexError } from 'convex/values';
import { BUDGET_HOLD_REASONS, MISSING_JUDGMENTS } from '@owlat/shared/aiRouting';
import {
	BUDGET_GENERIC_KEY,
	BUDGET_REASON_KEYS,
	MISSING_JUDGMENT_KEYS,
	budgetReasonOf,
	budgetCopyKeyOfError,
	budgetReasonOfError,
	budgetRefusalReason,
	isBudgetStreamError,
} from '../aiBudget';
import { createTestI18n } from '~/__tests__/i18n';

const { t, te } = createTestI18n().global;

describe('budgetRefusalReason', () => {
	it('reads the reason of a budget refusal payload', () => {
		expect(budgetRefusalReason({ code: 'AI_BUDGET_EXHAUSTED', reason: 'daily_ceiling' })).toBe(
			'daily_ceiling'
		);
		expect(
			budgetRefusalReason({ code: 'AI_BUDGET_EXHAUSTED', reason: 'spend_unverifiable', limit: 5 })
		).toBe('spend_unverifiable');
	});

	it('is null for other codes, unknown reasons, and no payload', () => {
		expect(budgetRefusalReason({ code: 'OTHER', reason: 'daily_ceiling' })).toBeNull();
		expect(budgetRefusalReason({ code: 'AI_BUDGET_EXHAUSTED', reason: 'weekly' })).toBeNull();
		expect(budgetRefusalReason({ code: 'AI_BUDGET_EXHAUSTED' })).toBeNull();
		expect(budgetRefusalReason(undefined)).toBeNull();
		expect(budgetRefusalReason(null)).toBeNull();
	});

	it('reads a normalized operation failure and a raw ConvexError', () => {
		const data = { code: 'AI_BUDGET_EXHAUSTED', reason: 'monthly_ceiling' };
		expect(budgetReasonOf({ category: 'forbidden', message: 'x', data })).toBe('monthly_ceiling');
		expect(budgetReasonOf({ category: 'forbidden', message: 'x' })).toBeNull();
		expect(
			budgetReasonOfError(new ConvexError({ category: 'forbidden', message: 'x', data }))
		).toBe('monthly_ceiling');
		expect(budgetReasonOfError(new Error('AI_BUDGET_EXHAUSTED'))).toBeNull();
		expect(budgetReasonOfError(null)).toBeNull();
		expect(
			budgetCopyKeyOfError(new ConvexError({ category: 'forbidden', message: 'x', data }))
		).toBe(BUDGET_REASON_KEYS.monthly_ceiling);
		expect(budgetCopyKeyOfError(new Error('boom'))).toBeNull();
	});
});

describe('isBudgetStreamError', () => {
	it('matches only the stable code', () => {
		expect(isBudgetStreamError('AI_BUDGET_EXHAUSTED')).toBe(true);
		expect(isBudgetStreamError('The AI budget is used up.')).toBe(false);
		expect(isBudgetStreamError(null)).toBe(false);
		expect(isBudgetStreamError(undefined)).toBe(false);
	});
});

describe('catalog keys', () => {
	it('has English copy for every reason, every skipped judgment, and the generic line', () => {
		for (const reason of BUDGET_HOLD_REASONS) expect(te(BUDGET_REASON_KEYS[reason])).toBe(true);
		for (const j of MISSING_JUDGMENTS) expect(te(MISSING_JUDGMENT_KEYS[j])).toBe(true);
		expect(t(BUDGET_GENERIC_KEY)).toContain('budget');
	});
});
