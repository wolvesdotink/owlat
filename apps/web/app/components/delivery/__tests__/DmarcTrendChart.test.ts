// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import DmarcTrendChart from '../DmarcTrendChart.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const originalTz = process.env.TZ;

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	// West of UTC, where a local-time label shows a UTC day key as the day before.
	process.env.TZ = 'America/Los_Angeles';
});

afterAll(() => {
	process.env.TZ = originalTz;
});

const points = [
	{ date: '2026-09-03', messageCount: 100, alignedCount: 90 },
	{ date: '2026-09-04', messageCount: 0, alignedCount: 0 },
	{ date: '2026-09-05', messageCount: 1200, alignedCount: 1200 },
];

describe('DmarcTrendChart', () => {
	it('labels each bar with its UTC day and both counts', () => {
		const wrapper = mount(DmarcTrendChart, {
			props: { points },
			global: { plugins: [createTestI18n()] },
		});
		const caption = wrapper.find('figcaption').text();
		expect(caption).toContain('Sep 3');
		expect(caption).toContain('Sep 5');
		expect(caption).not.toContain('Sep 2');

		const bars = wrapper.findAll('[data-testid="dmarc-trend-bar"]');
		expect(bars).toHaveLength(3);
		expect(bars[0]?.attributes('aria-label')).toMatch(/^Sep 3: 90 .* 10 /);
		expect(wrapper.find('[data-testid="dmarc-trend"]').attributes('role')).toBe('group');

		const rows = wrapper.findAll('table tbody tr').map((row) => row.text());
		expect(rows[2]).toContain('Sep 5');
		expect(rows[2]).toContain('1,200');
	});

	it('says so when the window has no mail', () => {
		const wrapper = mount(DmarcTrendChart, {
			props: { points: [{ date: '2026-09-03', messageCount: 0, alignedCount: 0 }] },
			global: { plugins: [createTestI18n()] },
		});
		expect(wrapper.find('[data-testid="dmarc-trend-empty"]').exists()).toBe(true);
	});
});
