// @vitest-environment happy-dom
/**
 * A stored budget refusal (D1) on an assistant answer, an @assistant reply or a
 * visualization carries the stable code and reason, never a sentence; the
 * notice says it from the catalog, and shows nothing for any other payload.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { AI_BUDGET_ERROR_CODE } from '@owlat/shared/aiRouting';
import BudgetRefusal from '../BudgetRefusal.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function mountNotice(refusal: unknown, variant?: 'inline' | 'panel') {
	return mount(BudgetRefusal, {
		props: { refusal, ...(variant ? { variant } : {}) },
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
}

describe('BudgetRefusal', () => {
	it('shows the reason in place of a visualization', () => {
		const w = mountNotice({ code: AI_BUDGET_ERROR_CODE, reason: 'monthly_ceiling' }, 'panel');
		const notice = w.get('[data-testid="ai-budget-refusal"]');
		expect(notice.attributes('role')).toBe('status');
		expect(notice.text()).toContain('AI budget reached.');
		expect(notice.text()).toContain('The AI spend budget for this month is used up.');
	});

	it('shows nothing for a payload that is not the budget refusal', () => {
		for (const refusal of [null, undefined, {}, { code: 'OTHER', reason: 'daily_ceiling' }]) {
			expect(mountNotice(refusal).find('[data-testid="ai-budget-refusal"]').exists()).toBe(false);
		}
		const unknownReason = { code: AI_BUDGET_ERROR_CODE, reason: 'weekly' };
		expect(mountNotice(unknownReason).find('[data-testid="ai-budget-refusal"]').exists()).toBe(
			false
		);
	});
});
