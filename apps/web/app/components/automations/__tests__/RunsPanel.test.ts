/**
 * The automation detail page's runs panel reads its filter from the URL, so a
 * health count on the automations list can link to exactly the runs it
 * counted: `?runs=failed` asks for the runs a failed step ended and
 * `?runs=stalled` for the ones the stalled-run sweep ended. A status value
 * filters by status; anything else is "all". Picking a tab writes the URL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';
import { installNuxtStubs, queryResult } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import UiSegmentedControl from '@owlat/ui/components/ui/SegmentedControl.vue';
import RunsPanel from '../RunsPanel.vue';

const route = reactive<{ query: Record<string, string | undefined> }>({ query: {} });
const replace = vi.fn();
let runArgs: () => Record<string, unknown> = () => ({});

const RUNS = {
	runs: [
		{
			_id: 'run_1',
			status: 'cancelled',
			endReason: 'step_failed',
			currentStepIndex: 2,
			startedAt: Date.parse('2026-10-19T09:00:00Z'),
			contact: { _id: 'c_1', email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' },
		},
		{
			_id: 'run_2',
			status: 'cancelled',
			endReason: 'stalled',
			currentStepIndex: 0,
			startedAt: Date.parse('2026-10-18T09:00:00Z'),
			contact: { _id: 'c_2', email: 'grace@example.com', firstName: 'Grace', lastName: 'Hopper' },
		},
		{
			_id: 'run_3',
			status: 'cancelled',
			currentStepIndex: 1,
			startedAt: Date.parse('2026-10-17T09:00:00Z'),
			contact: { _id: 'c_3', email: 'alan@example.com', firstName: 'Alan', lastName: 'Turing' },
		},
	],
	hasMore: false,
};

beforeEach(() => {
	route.query = {};
	replace.mockClear();
	runArgs = () => ({});
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => route,
		useRouter: () => ({ replace, push: vi.fn() }),
		useConvexQuery: (_query: unknown, args: () => Record<string, unknown>) => {
			runArgs = args;
			return queryResult(RUNS);
		},
	});
});

async function mountPanel() {
	const wrapper = mount(RunsPanel, {
		props: { automationId: 'au_welcome' as never },
		global: {
			plugins: [createTestI18n()],
			components: { UiSegmentedControl },
			stubs: {
				Icon: true,
				UiIconBox: true,
				UiQueryBoundary: true,
				UiButton: true,
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
			},
		},
	});
	await flushPromises();
	return wrapper;
}

describe('automation runs panel filter', () => {
	it.each([
		[undefined, {}],
		['running', { status: 'running' }],
		['cancelled', { status: 'cancelled' }],
		['failed', { endReason: 'step_failed' }],
		['stalled', { endReason: 'stalled' }],
		['nonsense', {}],
	] as const)('?runs=%s reads the matching runs', async (runs, filter) => {
		route.query = { runs };
		await mountPanel();
		expect(runArgs()).toEqual({ automationId: 'au_welcome', limit: 10, offset: 0, ...filter });
	});

	it('says what a health filter lists and selects its tab', async () => {
		route.query = { runs: 'failed' };
		const wrapper = await mountPanel();
		expect(wrapper.text()).toContain('Runs a failed step ended in the last 7 days');
		const selected = wrapper.get('[role="tab"][aria-selected="true"]');
		expect(selected.text()).toBe('Failed');
	});

	it('names why a cancelled run ended', async () => {
		const wrapper = await mountPanel();
		const badges = wrapper.findAll('.rounded-full.text-xs').map((badge) => badge.text());
		expect(badges).toEqual(['Failed', 'Stalled', 'Cancelled']);
	});

	it('writes the picked filter to the URL', async () => {
		route.query = { runs: 'failed', tab: 'x' };
		const wrapper = await mountPanel();
		const all = wrapper.findAll('[role="tab"]').find((tab) => tab.text() === 'All')!;
		await all.trigger('click');
		expect(replace).toHaveBeenCalledWith({ query: { runs: undefined, tab: 'x' } });
		const stalled = wrapper.findAll('[role="tab"]').find((tab) => tab.text() === 'Stalled')!;
		await stalled.trigger('click');
		expect(replace).toHaveBeenLastCalledWith({ query: { runs: 'stalled', tab: 'x' } });
	});
});
