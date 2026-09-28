// @vitest-environment happy-dom
/**
 * The new-contacts bars label each day from the series' UTC day key, in the
 * reader's language. The server still sends an English `label` for older
 * clients (contacts/analytics.getSubscriberGrowth, one release); this panel
 * must not read it, or a German page shows English month names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, ref, type PropType } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import de from '~~/i18n/locales/de.json';
import type { MarketingDelivery } from '~/utils/marketingOverviewTypes';

/** Renders each bar's label as a list item, so the test reads what UiBars is handed. */
const UiBarsStub = defineComponent({
	name: 'UiBars',
	props: {
		data: { type: Array as PropType<{ label: string; value: number }[]>, default: () => [] },
	},
	setup: (props) => () =>
		h(
			'ul',
			props.data.map((bar) => h('li', { 'data-testid': 'bar' }, bar.label))
		),
});

const GROWTH = {
	days: [
		// `label` is deliberately wrong: the panel must build its own from `date`.
		{ date: '2026-09-02', count: 1, label: 'Sep 2 (server)' },
		{ date: '2026-09-03', count: 4, label: 'Sep 3 (server)' },
	],
	truncated: false,
};

const DELIVERY = { reputation: null } as unknown as MarketingDelivery;

async function mountPanel(locale: 'en' | 'de') {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useOrganizationQuery', () => ({ data: ref(GROWTH), isLoading: ref(false) }));
	vi.stubGlobal('useDeliveryHealth', () => ({ level: ref(null), reason: ref('') }));
	const i18n = createTestI18n();
	if (locale === 'de') {
		i18n.global.setLocaleMessage('de', de);
		i18n.global.locale.value = 'de';
	}
	const component = (await import('../MarketingAudiencePanel.vue')).default;
	return mount(component, {
		props: { delivery: DELIVERY },
		global: { plugins: [i18n], stubs: { UiBars: UiBarsStub, UiSkeleton: true } },
	});
}

function barLabels(wrapper: Awaited<ReturnType<typeof mountPanel>>): string[] {
	return wrapper.findAll('[data-testid="bar"]').map((bar) => bar.text());
}

describe('MarketingAudiencePanel new-contacts bars', () => {
	// A reader west of UTC, where a local-time formatter would print the 2nd for
	// midnight UTC on the 3rd.
	const originalTz = process.env.TZ;
	beforeEach(() => {
		process.env.TZ = 'America/Los_Angeles';
	});
	afterEach(() => {
		process.env.TZ = originalTz;
		vi.resetModules();
	});

	it('labels the bars in German from `date`, not the server label', async () => {
		const wrapper = await mountPanel('de');
		expect(barLabels(wrapper)).toEqual(['2. Sept.', '3. Sept.']);
		expect(wrapper.text()).toContain('Neue Kontakte pro Tag');
	});

	it('labels the bars in English from `date`, on the UTC day', async () => {
		const wrapper = await mountPanel('en');
		expect(barLabels(wrapper)).toEqual(['Sep 2', 'Sep 3']);
		expect(wrapper.text()).not.toContain('(server)');
	});
});
