// @vitest-environment happy-dom
/**
 * The predicted sends per hour under "Optimized per contact": every state the
 * panel can be in, and that the bars and the source lines read the preview.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';

import SendTimeDistribution from '../SendTimeDistribution.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import type { SendTimePreviewData } from '~/utils/sendTimePreview';

Object.assign(globalThis, i18nStubs);

const START = Date.UTC(2026, 2, 11, 8, 0);
const HOUR = 3_600_000;

let queryArgs: unknown;
let state: { data: unknown; error: Error | null; isLoading: boolean };

beforeEach(() => {
	queryArgs = undefined;
	state = { data: undefined, error: null, isLoading: false };
	vi.stubGlobal('useOrganizationQuery', (_query: unknown, args: () => unknown) => {
		queryArgs = args();
		return {
			data: ref(state.data),
			error: ref(state.error),
			isLoading: ref(state.isLoading),
			refetch: () => {},
		};
	});
});

const barsStub = {
	props: ['data', 'ariaLabel', 'formatValue'],
	template:
		'<div class="bars-stub" :aria-label="ariaLabel"><span v-for="(b, i) in data" :key="i" class="bar">{{ b.value }}</span></div>',
};

function mountPanel(startAt: number | null = START) {
	return mount(SendTimeDistribution, {
		props: {
			campaignId: 'campaign_1' as Id<'campaigns'>,
			startAt,
			windowHours: 6,
			holdoutPercent: 10,
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiBars: barsStub,
				UiSkeleton: { template: '<div class="skeleton" />' },
				UiQueryBoundary: { props: ['error'], template: '<div class="query-error" />' },
			},
		},
	});
}

function preview(overrides: Partial<SendTimePreviewData> = {}): SendTimePreviewData {
	return {
		hours: [40, 10, 0, 0, 30, 20].map((count, i) => ({ at: START + i * HOUR, count })),
		sampleSize: 1000,
		isSample: true,
		sources: { contact: 300, organization: 600, start: 0, holdout: 100 },
		organizationBestHour: 9,
		...overrides,
	};
}

describe('SendTimeDistribution', () => {
	it('asks for a start before it predicts anything', () => {
		const wrapper = mountPanel(null);
		expect(queryArgs).toBeUndefined();
		expect(wrapper.find('[data-state="no-start"]').exists()).toBe(true);
		expectFullyLocalized(wrapper);
	});

	it('passes the start, window, comparison group and wall clock to the preview', () => {
		mountPanel();
		const start = new Date(START);
		expect(queryArgs).toEqual({
			campaignId: 'campaign_1',
			startAt: START,
			windowHours: 6,
			holdoutPercent: 10,
			scheduledHour: start.getHours(),
			scheduledMinute: start.getMinutes(),
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		});
	});

	it('shows a placeholder while loading and the error with a retry when it fails', () => {
		state.isLoading = true;
		expect(mountPanel().find('.skeleton').exists()).toBe(true);
		state = { data: undefined, error: new Error('boom'), isLoading: false };
		expect(mountPanel().find('.query-error').exists()).toBe(true);
	});

	it('says so when the campaign has nobody to send to', () => {
		state.data = preview({
			sampleSize: 0,
			isSample: false,
			sources: { contact: 0, organization: 0, start: 0, holdout: 0 },
		});
		expect(mountPanel().find('[data-state="empty"]').exists()).toBe(true);
	});

	it('draws one bar per hour and explains where the times came from', () => {
		state.data = preview();
		const wrapper = mountPanel();
		expect(wrapper.findAll('.bar').map((b) => b.text())).toEqual([
			'40',
			'10',
			'0',
			'0',
			'30',
			'20',
		]);
		const sources = wrapper.find('[data-part="sources"]').text();
		expect(sources).toContain('30% at their own usual hour');
		expect(sources).toContain("60% at your audience's busiest hour (9:00 AM)");
		expect(sources).toContain('10% as the comparison group at the start time');
		expect(sources).not.toContain('not enough history');
		expect(wrapper.text()).toContain('Based on the first 1,000 recipients');
		expectFullyLocalized(wrapper);
	});

	it('explains the fallback when nobody has history yet', () => {
		state.data = preview({
			isSample: false,
			sources: { contact: 0, organization: 0, start: 90, holdout: 10 },
			organizationBestHour: null,
		});
		const wrapper = mountPanel();
		expect(wrapper.find('[data-state="no-history"]').exists()).toBe(true);
		expect(wrapper.text()).not.toContain('Based on the first');
		expectFullyLocalized(wrapper);
	});
});
