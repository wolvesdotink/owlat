/**
 * CampaignAbComparison — the A/B fold-in inside the campaign report (UX piece
 * c3b). Verifies the block renders correctly per test state: in-progress, a
 * manual test awaiting a pick, and a decided winner.
 */
import { beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { FunctionReturnType } from 'convex/server';
import type { api } from '@owlat/api';

import CampaignAbComparison from '../CampaignAbComparison.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const confirm = vi.fn();

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n, useConfirm: () => confirm });
});

beforeEach(() => {
	confirm.mockReset().mockResolvedValue(true);
});

type AbStats = NonNullable<FunctionReturnType<typeof api.campaigns.abTest.getABTestStats>>;

const stubs = {
	UiIconBox: { template: '<i />' },
};

const variant = (openRate: number, clickRate: number) => ({
	sent: 500,
	delivered: 480,
	opened: Math.round((openRate / 100) * 480),
	clicked: Math.round((clickRate / 100) * 480),
	openRate,
	clickRate,
});

function mountBlock(stats: AbStats, isSelectingWinner = false) {
	return mount(CampaignAbComparison, {
		props: { stats, isSelectingWinner },
		global: { plugins: [createTestI18n()], stubs },
	});
}

const root = '[data-testid="ab-comparison"]';
const variantSel = '[data-testid="ab-variant"]';
const pickSel = '[data-testid="ab-pick-winner"]';

describe('CampaignAbComparison', () => {
	it('renders two variant columns and the test type', () => {
		const wrapper = mountBlock({
			status: 'testing',
			winner: undefined,
			winnerSelectedAt: undefined,
			config: { testType: 'subject', winnerCriteria: 'open_rate' },
			variantA: variant(40, 8),
			variantB: variant(45, 9),
		});
		expect(wrapper.find(root).exists()).toBe(true);
		expect(wrapper.findAll(variantSel)).toHaveLength(2);
		expect(wrapper.text()).toContain('Subject lines');
		expect(wrapper.text()).toContain('Testing in progress');
	});

	it('shows a Pick winner action only for an undecided manual test', () => {
		const wrapper = mountBlock({
			status: 'testing',
			winner: undefined,
			winnerSelectedAt: undefined,
			config: { testType: 'content', winnerCriteria: 'manual' },
			variantA: variant(40, 8),
			variantB: variant(45, 9),
		});
		expect(wrapper.findAll(pickSel)).toHaveLength(2);
	});

	it('emits select-winner with the chosen variant', async () => {
		const wrapper = mountBlock({
			status: 'testing',
			winner: undefined,
			winnerSelectedAt: undefined,
			config: { testType: 'content', winnerCriteria: 'manual' },
			variantA: variant(40, 8),
			variantB: variant(45, 9),
		});
		await wrapper.findAll(pickSel)[1]!.trigger('click');
		await flushPromises();
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(wrapper.emitted('select-winner')!.at(-1)).toEqual(['B']);
	});

	it('picks no winner when the confirmation is declined', async () => {
		confirm.mockResolvedValue(false);
		const wrapper = mountBlock({
			status: 'testing',
			winner: undefined,
			winnerSelectedAt: undefined,
			config: { testType: 'content', winnerCriteria: 'manual' },
			variantA: variant(40, 8),
			variantB: variant(45, 9),
		});
		await wrapper.findAll(pickSel)[0]!.trigger('click');
		await flushPromises();
		expect(wrapper.emitted('select-winner')).toBeUndefined();
	});

	it('renders the winner state with the deciding-metric margin and no picker', () => {
		const wrapper = mountBlock({
			status: 'winner_selected',
			winner: 'B',
			winnerSelectedAt: 1_700_000_000_000,
			config: { testType: 'subject', winnerCriteria: 'open_rate' },
			variantA: variant(40, 8),
			variantB: variant(52, 9),
		});
		expect(wrapper.find('[data-testid="ab-winner-chip"]').exists()).toBe(true);
		expect(wrapper.find(pickSel).exists()).toBe(false);
		const summary = wrapper.find('[data-testid="ab-winner-summary"]');
		expect(summary.exists()).toBe(true);
		// 52% − 40% open rate = +12.0 pts.
		expect(summary.text()).toContain('+12.0 pts');
		expect(summary.text()).toContain('open rate');
	});
});
