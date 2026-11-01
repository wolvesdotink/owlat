/**
 * The campaign report's sections reach the page's state: Duplicate runs the
 * page's operation, the archive card copies the archive link, the opens
 * timeline charts the first 48 hours, and the Opened / Clicked tabs page
 * through the page's queries with Previous and Next.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, readonly, ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';
import type { Id } from '@owlat/api/dataModel';

import CampaignReport from '../[id]/report.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs, queryResult } from '~/__tests__/a11y';
import { formatDateTime, formatCompactRelativeTime } from '~/utils/formatters';

const CAMPAIGN_ID = 'campaign_1' as Id<'campaigns'>;
const HOUR = 60 * 60 * 1000;
const START = new Date('2026-03-10T09:00:00').getTime();

const contact = (i: number) => ({
	_id: `contact_${i}`,
	email: `person${i}@owlat.example`,
	firstName: `Person${i}`,
	lastName: 'Example',
});

/** A page of a 25-row list at the requested offset. */
function page<T>(make: (i: number) => T, args: { offset: number; limit: number }) {
	const end = Math.min(args.offset + args.limit, 25);
	const sends = Array.from({ length: end - args.offset }, (_, k) => make(args.offset + k));
	return { sends, total: 25, hasMore: end < 25 };
}

const opened = (i: number) => ({
	_id: `open_${i}`,
	openedAt: START + i * HOUR,
	openCount: 1,
	contact: contact(i),
});
const clicked = (i: number) => ({
	_id: `click_${i}`,
	clickedAt: START + i * HOUR,
	clickedLinks: Array.from({ length: i === 0 ? 5 : 1 }, (_, k) => ({
		url: `https://owlat.example/link-${k}`,
		clickedAt: START,
	})),
	contact: contact(i),
});

let timeline: { timestamp: number; count: number }[];
let duplicateRuns: unknown[];
let copied: string[];
let pushed: string[];

const trendChartStub = defineComponent({
	props: { data: { type: Array, default: () => [] } },
	setup(props) {
		return () =>
			h(
				'ol',
				{ 'data-testid': 'trend' },
				(props.data as { label: string; value: number }[]).map((d) =>
					h('li', `${d.label}:${d.value}`)
				)
			);
	},
});

function mountReport(campaign: Record<string, unknown>) {
	installNuxtStubs({
		...i18nStubs,
		formatDateTime,
		formatCompactRelativeTime,
		useRouteId: () => ref(CAMPAIGN_ID),
		useRouter: () => ({ push: (to: string) => pushed.push(to) }),
		useCopyToClipboard: () => {
			const copiedKey = ref<string | null>(null);
			return {
				copy: async (text: string, key: string) => {
					copied.push(text);
					copiedKey.value = key;
				},
				copiedKey: readonly(copiedKey),
			};
		},
		useBackendOperation: (_reference: unknown, options: { label: () => string }) => ({
			run: async (args: unknown) => {
				if (options.label() === 'Duplicate campaign') duplicateRuns.push(args);
				return { ok: true, result: 'campaign_2' };
			},
		}),
		// Keyed by function NAME, and re-reading the args factory on every render
		// so paging is visible as a new page of rows.
		useConvexQuery: (reference: FunctionReference<'query'>, args?: () => unknown) => {
			const name = getFunctionName(reference);
			if (name === 'campaigns/campaigns:getWithRelations') return queryResult(campaign);
			if (name === 'delivery/sends:getOpensTimeline') return queryResult(timeline);
			if (
				name === 'delivery/sends:getOpenedContacts' ||
				name === 'delivery/sends:getClickedContacts'
			) {
				const make = name === 'delivery/sends:getOpenedContacts' ? opened : clicked;
				const data = computed(() => {
					const current = args?.();
					return current && current !== 'skip'
						? page<unknown>(make, current as { offset: number; limit: number })
						: undefined;
				});
				return { ...queryResult(undefined), data };
			}
			return queryResult(undefined);
		},
	});

	return mount(CampaignReport, {
		global: {
			plugins: [createTestI18n()],
			// Nuxt auto-imports this into templates; a plain mount has to provide it.
			mocks: { formatCompactRelativeTime },
			stubs: {
				UiQueryBoundary: { template: '<div><slot /></div>' },
				UiPageHeader: {
					props: ['title'],
					template:
						'<header><h1>{{ title }}</h1><slot name="meta" /><slot name="actions" /></header>',
				},
				UiButton: {
					props: ['disabled'],
					emits: ['click'],
					template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
				},
				UiTooltip: { template: '<span><slot /></span>' },
				NuxtLink: { props: ['to'], template: '<a :data-to="to"><slot /></a>' },
				UiTrendChart: trendChartStub,
				UiIconBox: true,
				Icon: true,
				CampaignsUndoSendToast: true,
			},
		},
	});
}

const button = (wrapper: ReturnType<typeof mountReport>, text: string) => {
	const found = wrapper.findAll('button').find((b) => b.text().trim().startsWith(text));
	if (!found) throw new Error(`no "${text}" button`);
	return found;
};

const SENT = {
	_id: CAMPAIGN_ID,
	name: 'Weekly digest #34',
	status: 'sent',
	sentAt: START,
	isABTest: false,
};

beforeEach(() => {
	timeline = [];
	duplicateRuns = [];
	copied = [];
	pushed = [];
	vi.useRealTimers();
});

describe('campaign report wiring', () => {
	it('duplicates the campaign from the header and opens the copy', async () => {
		const wrapper = mountReport(SENT);
		await button(wrapper, 'Duplicate').trigger('click');
		await flushPromises();
		expect(duplicateRuns).toEqual([{ campaignId: CAMPAIGN_ID }]);
		expect(pushed).toEqual(['/dashboard/campaigns/campaign_2/edit']);
	});

	it('copies the public archive link', async () => {
		const wrapper = mountReport({ ...SENT, archiveToken: 'token_1' });
		const url = 'https://owlat.test/archive?token=token_1';
		expect(wrapper.text()).toContain(url);

		await button(wrapper, 'Copy link').trigger('click');
		expect(copied).toEqual([url]);
		expect(button(wrapper, 'Copied').exists()).toBe(true);
	});

	it('has no archive card without an archive token', () => {
		const wrapper = mountReport(SENT);
		expect(wrapper.text()).not.toContain('Public archive');
	});

	it('charts the first 48 hours of opens, or says there are none yet', () => {
		expect(mountReport(SENT).text()).toContain('No opens recorded yet');

		timeline = [
			{ timestamp: START, count: 40 },
			{ timestamp: START + 2 * HOUR, count: 12 },
			{ timestamp: START + 49 * HOUR, count: 1 },
		];
		const points = mountReport(SENT)
			.findAll('[data-testid="trend"] li')
			.map((li) => li.text());
		expect(points).toEqual(['0h:40', '2h:12']);
	});

	it('pages through the contacts who opened', async () => {
		const wrapper = mountReport(SENT);
		expect(wrapper.text()).toContain('Opened (25)');
		expect(wrapper.text()).toContain('person0@owlat.example');
		expect(wrapper.text()).toContain('1-10 of 25');
		expect(button(wrapper, 'Previous').attributes('disabled')).toBeDefined();

		await button(wrapper, 'Next').trigger('click');
		expect(wrapper.text()).toContain('person10@owlat.example');
		expect(wrapper.text()).not.toContain('person0@owlat.example');
		expect(wrapper.text()).toContain('11-20 of 25');

		await button(wrapper, 'Previous').trigger('click');
		expect(wrapper.text()).toContain('1-10 of 25');
		expect(wrapper.find('a[data-to="/dashboard/campaigns/campaign_1/sends/open_0"]').exists()).toBe(
			true
		);
	});

	it('switches to the contacts who clicked, with their links', async () => {
		const wrapper = mountReport(SENT);
		await button(wrapper, 'Clicked').trigger('click');

		const text = wrapper.text();
		expect(text).toContain('Clicked (25)');
		expect(text).toContain('https://owlat.example/link-2');
		expect(text).not.toContain('https://owlat.example/link-3');
		expect(text).toContain('+2 more links');
		expect(text).toContain('5 links');
		expect(text).not.toContain('person0@owlat.example ');

		await button(wrapper, 'Next').trigger('click');
		await button(wrapper, 'Next').trigger('click');
		expect(wrapper.text()).toContain('21-25 of 25');
		expect(button(wrapper, 'Next').attributes('disabled')).toBeDefined();
	});
});
