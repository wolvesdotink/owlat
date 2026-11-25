/**
 * The counts on the campaign report read in the singular for one: the
 * recipient count in the header and the "more links" line of a clicked
 * contact, in both locales.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import de from '~~/i18n/locales/de.json';
import ReportHeader from '../ReportHeader.vue';
import ReportClickedList from '../ReportClickedList.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

Object.assign(globalThis, {
	...i18nStubs,
	formatDateTime: () => 'Jun 1, 2026',
});

function i18nFor(locale: 'en' | 'de') {
	const i18n = createTestI18n();
	if (locale === 'de') {
		i18n.global.setLocaleMessage('de', de);
		i18n.global.locale.value = 'de';
	}
	return i18n;
}

function mountHeader(locale: 'en' | 'de', recipientCount: number) {
	return mount(ReportHeader, {
		props: {
			campaign: { name: 'Summer Sale 2026', sentAt: 1 },
			reportStatus: 'sent',
			hasSendStarted: true,
			recipientCount,
			sendPlan: undefined,
			isDuplicating: false,
		},
		global: {
			plugins: [i18nFor(locale)],
			stubs: {
				NuxtLink: { template: '<a><slot /></a>' },
				UiPageHeader: { template: '<div><slot name="meta" /><slot name="actions" /></div>' },
				UiButton: true,
				CampaignSendPlanLine: true,
				StartWaitingNote: true,
			},
		},
	});
}

function mountClicked(locale: 'en' | 'de', linkCount: number) {
	const clickedLinks = Array.from({ length: linkCount }, (_, i) => ({
		url: `https://owlat.example/${i}`,
		clickedAt: i,
	}));
	return mount(ReportClickedList, {
		props: {
			campaignId: 'c1' as never,
			contacts: {
				sends: [
					{
						_id: 's1',
						clickedAt: 1,
						clickedLinks,
						contact: { email: 'ada@owlat.example', firstName: 'Ada' },
					},
				],
				hasMore: false,
				total: 1,
			} as never,
			loading: false,
			offset: 0,
			pageSize: 25,
		},
		global: {
			plugins: [i18nFor(locale)],
			mocks: { formatCompactRelativeTime: () => '5m ago' },
			stubs: { NuxtLink: true, UiTooltip: true, UiIconBox: true, UiButton: true },
		},
	});
}

describe('ReportHeader recipient count', () => {
	it.each([
		['en', 1, '1 recipient'],
		['en', 2, '2 recipients'],
		['de', 1, '1 Empfänger'],
		['de', 2, '2 Empfänger'],
	] as const)('reads %s for %i', (locale, count, expected) => {
		const w = mountHeader(locale, count);
		expect(w.find('.tabular-nums').text()).toBe(expected);
		w.unmount();
	});
});

describe('ReportClickedList more links', () => {
	it.each([
		['en', 4, '+1 more link'],
		['en', 5, '+2 more links'],
		['de', 4, '+1 weiterer Link'],
		['de', 5, '+2 weitere Links'],
	] as const)('reads %s for %i links', (locale, links, expected) => {
		const w = mountClicked(locale, links);
		const lines = w.findAll('div').map((div) => div.text());
		expect(lines).toContain(expected);
		w.unmount();
	});
});
