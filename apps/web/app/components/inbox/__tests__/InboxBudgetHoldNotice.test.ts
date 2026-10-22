/**
 * A Team message held for a person at the AI spend budget (D1, U3): which
 * budget, which AI steps were skipped, and Retry.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import InboxBudgetHoldNotice from '../InboxBudgetHoldNotice.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { BUDGET_HOLD_REASONS, type MissingJudgment } from '@owlat/shared/aiRouting';
import type { BudgetHold } from '~/utils/aiBudget';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const AT = Date.UTC(2026, 9, 11, 8, 30);

function mountNotice(hold: Partial<BudgetHold> = {}, retrying = false) {
	return mount(InboxBudgetHoldNotice, {
		props: {
			hold: { reason: 'daily_ceiling', missingJudgments: [], at: AT, ...hold },
			retrying,
		},
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
}

describe('InboxBudgetHoldNotice', () => {
	it('says the message waits for a person because the daily budget is reached', async () => {
		const w = mountNotice({ missingJudgments: ['guard', 'draft'] });
		expect(w.text()).toContain('Waiting for a person: AI budget reached');
		expect(w.text()).toContain('for today is used up');
		expect(w.get('[data-testid="thread-budget-hold-missing"]').text()).toBe(
			'The AI skipped the safety check, the draft.'
		);
		expect(w.get('[data-testid="thread-budget-hold"]').attributes('data-reason')).toBe(
			'daily_ceiling'
		);
		// Auto-send is blocked only while held; trying again restores automation.
		expect(w.text()).toContain('Nothing is sent automatically while the message is held.');
		expect(w.text()).toContain('normal automation, so its reply can be sent on its own');
		expectFullyLocalized(w);

		await w.get('button').trigger('click');
		expect(w.emitted('retry')).toHaveLength(1);
	});

	it('omits the skipped line when no judgment is listed', () => {
		const w = mountNotice({ reason: 'monthly_ceiling' });
		expect(w.text()).toContain('for this month is used up');
		expect(w.find('[data-testid="thread-budget-hold-missing"]').exists()).toBe(false);
	});

	it('disables Retry while a retry runs', () => {
		const w = mountNotice({}, true);
		expect(w.get('button').attributes('disabled')).toBeDefined();
	});

	it('has copy for every reason and every skipped judgment', () => {
		const all: MissingJudgment[] = ['guard', 'classify', 'interpret', 'clarify', 'draft'];
		for (const reason of BUDGET_HOLD_REASONS) {
			const text = mountNotice({ reason, missingJudgments: all }).text();
			expect(text).not.toContain('shared.aiBudget');
			expect(text).not.toContain('components.inbox');
		}
	});
});
