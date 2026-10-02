// @vitest-environment happy-dom
/**
 * The pre-send checks panel: what needs a look comes first and passes fold
 * away, every finding with a Block offers "Show me", and the review control
 * only appears when there are warnings and nothing blocks.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import PresendChecksPanel from '../PresendChecksPanel.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { useLocalized } from '~/composables/useLocalized';
import type { PresendCheck } from '~/lib/presendChecks/types';

const KEY = 'components.campaigns.presendChecks';

const CHECKS: PresendCheck[] = [
	{
		id: 'size',
		category: 'size',
		status: 'pass',
		summary: { key: `${KEY}.size.pass`, params: { size: 40, limit: 102 } },
		items: [],
	},
	{
		id: 'links',
		category: 'links',
		status: 'warning',
		summary: { key: `${KEY}.links.broken`, params: { count: 2 } },
		items: [
			{
				label: 'https://example.com/gone',
				reason: { key: `${KEY}.reasons.httpStatus`, params: { status: 404 } },
				blockId: 'b-1',
			},
			{ label: 'https://elsewhere.example/', reason: `${KEY}.reasons.unreachable` },
		],
	},
	{
		id: 'screening',
		category: 'content',
		status: 'pending',
		summary: `${KEY}.screening.pending`,
		items: [],
	},
];

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useLocalized', useLocalized);
});

function mountPanel(props: Record<string, unknown> = {}) {
	return mount(PresendChecksPanel, {
		props: {
			checks: CHECKS,
			summary: { warnings: 1, blocking: 0, pending: 1, signature: 'links' },
			isChecking: true,
			...props,
		},
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
}

describe('PresendChecksPanel', () => {
	it('lists what needs a look and folds the passes away', async () => {
		const wrapper = mountPanel();

		expect(wrapper.find('[data-testid="presend-headline"]').text()).toBe(
			'1 thing to look at before you send.'
		);
		expect(wrapper.find('[data-testid="presend-check-links"]').text()).toContain(
			"Links that don't work: 2"
		);
		expect(wrapper.text()).toContain('https://example.com/gone · the site answers 404');
		expect(wrapper.find('[data-testid="presend-check-size"]').exists()).toBe(false);

		await wrapper.find('[data-testid="presend-toggle-passed"]').trigger('click');
		expect(wrapper.find('[data-testid="presend-check-size"]').text()).toContain(
			"under Gmail's 102 KB clipping limit"
		);
		expectFullyLocalized(wrapper);
	});

	it('offers "Show me" only where a finding has a Block', async () => {
		const wrapper = mountPanel();
		const buttons = wrapper.findAll('[data-testid="presend-show-block"]');
		expect(buttons).toHaveLength(1);

		await buttons[0]!.trigger('click');
		expect(wrapper.emitted('showBlock')).toEqual([['b-1']]);
	});

	it('lets the sender mark warnings as reviewed, and says when they are', async () => {
		const wrapper = mountPanel({ acknowledgeable: true });
		const banner = wrapper.find('[data-testid="presend-acknowledge"]');
		expect(banner.text()).toContain("Warnings don't stop the send.");

		await banner.find('button').trigger('click');
		expect(wrapper.emitted('acknowledge')).toHaveLength(1);

		const reviewed = mountPanel({ acknowledgeable: true, acknowledged: true });
		expect(reviewed.find('[data-testid="presend-acknowledge"]').text()).toBe(
			"You've reviewed these warnings."
		);
	});

	it('has nothing to review while the send is blocked', () => {
		const wrapper = mountPanel({
			acknowledgeable: true,
			summary: { warnings: 1, blocking: 1, pending: 0, signature: 'x' },
		});
		expect(wrapper.find('[data-testid="presend-headline"]').text()).toBe(
			"This campaign can't be sent yet."
		);
		expect(wrapper.find('[data-testid="presend-acknowledge"]').exists()).toBe(false);
	});

	it('runs the checks again on request', async () => {
		const wrapper = mountPanel({ isChecking: false });
		await wrapper.find('[data-testid="presend-recheck"]').trigger('click');
		expect(wrapper.emitted('retry')).toHaveLength(1);
	});
});
