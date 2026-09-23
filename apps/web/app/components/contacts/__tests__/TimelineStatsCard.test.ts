// @vitest-environment happy-dom
/**
 * The contact's Communication card. `contacts.timeline.getStats` returns each
 * channel's count as `{ inbound, outbound }`, and the card once printed that
 * object as if it were a number: `{ "inbound": 2, "outbound": 2 }` (#804).
 */
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import TimelineStatsCard from '../TimelineStatsCard.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });

function mountCard(channelCounts: Record<string, { inbound: number; outbound: number }>) {
	vi.stubGlobal('useContactTimeline', () => ({
		stats: ref({
			totalMessages: 4,
			totalThreads: 1,
			channelCounts,
			firstInteraction: null,
			lastInteraction: null,
		}),
		statsLoading: ref(false),
		channelIcon: () => 'lucide:mail',
		channelLabel: (channel: string) => channel,
		channelColor: () => '',
	}));
	return mount(TimelineStatsCard, {
		props: { contactId: 'ct_1' as never },
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: true, UiIconBox: true, UiSpinner: true },
		},
	});
}

describe('TimelineStatsCard', () => {
	it('reads each channel as received and sent counts', () => {
		const wrapper = mountCard({ email: { inbound: 2, outbound: 3 } });

		expect(wrapper.text()).toContain('Email');
		expect(wrapper.text()).toContain('2 received · 3 sent');
		expect(wrapper.text()).not.toContain('inbound');
		expect(wrapper.text()).not.toContain('{');
		wrapper.unmount();
	});
});
