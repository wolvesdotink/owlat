/**
 * The automation detail page's runs panel reads its filter from the URL, so a
 * health count on the automations list can link to exactly the runs it
 * counted: `?runs=failed` asks for the runs a failed step ended and
 * `?runs=stalled` for the ones the stalled-run sweep ended. A status value
 * filters by status; anything else is "all". Picking a tab writes the URL.
 *
 * A run a failed step ended says why under its row: one sentence for the coded
 * reason, the page that fixes it (admins only), and the step's stored text
 * behind a disclosure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive, ref } from 'vue';
import { installNuxtStubs, queryResult } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import UiSegmentedControl from '@owlat/ui/components/ui/SegmentedControl.vue';
import RunsPanel from '../RunsPanel.vue';
import en from '~~/i18n/locales/en.json';
import de from '~~/i18n/locales/de.json';
import { allRunFailureMessageKeys } from '~/lib/automationRunFailure';

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

let runsData: unknown = RUNS;
const isAdmin = ref(true);

/** One failed run carrying `failure`, as `getAutomationRuns` returns it. */
function failedRun(failure: { reason: string; detail: string | null }) {
	return { runs: [{ ...RUNS.runs[0], failure }], hasMore: false };
}

beforeEach(() => {
	route.query = {};
	runsData = RUNS;
	isAdmin.value = true;
	replace.mockClear();
	runArgs = () => ({});
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => route,
		useRouter: () => ({ replace, push: vi.fn() }),
		useConvexQuery: (_query: unknown, args: () => Record<string, unknown>) => {
			runArgs = args;
			return queryResult(runsData);
		},
		usePermissions: () => ({ isAdmin }),
	});
});

async function mountPanel() {
	const wrapper = mount(RunsPanel, {
		props: { automationId: 'au_welcome' as never },
		global: {
			plugins: [createTestI18n()],
			components: { UiSegmentedControl },
			stubs: {
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

describe('why a failed run failed', () => {
	it.each([
		[
			'no_delivery_provider',
			'Sending is not set up yet, so this email could not go out.',
			'/dashboard/admin/delivery/transport',
		],
		[
			'domain_not_verified',
			"The default sender's domain is not a verified sending domain, so this email could not go out.",
			'/dashboard/admin/delivery/domains',
		],
		[
			'sending_not_allowed',
			'Sending is suspended on this instance, so this email could not go out.',
			'/dashboard/admin/delivery',
		],
		[
			'no_default_sender',
			'No default sender is set, so this email could not go out.',
			'/dashboard/admin/instance/general',
		],
		[
			'plugin_denied',
			'The plugin behind this step is turned off or may not run automation steps.',
			'/dashboard/admin/instance/plugins',
		],
		[
			'template_missing',
			'This step has no email to send, or its email was deleted. Choose one in the editor.',
			null,
		],
		[
			'template_empty',
			'The email this step sends has no content. Add content to it, or choose another email in the editor.',
			null,
		],
		['contact_no_email', 'This contact has no email address.', null],
		[
			'invalid_step_config',
			"This step's settings are incomplete or invalid. Check the step in the editor.",
			null,
		],
		['plugin_failed', 'The plugin behind this step reported a failure.', null],
		['interrupted', 'This step was interrupted again and again and was given up.', null],
		[
			'step_limit',
			'This run went through too many steps and was stopped. A condition that leads back to an earlier step usually causes this.',
			null,
		],
		['unknown', 'This step failed.', null],
	] as const)('%s says why, and links the page that fixes it', async (reason, sentence, fixTo) => {
		runsData = failedRun({ reason, detail: 'stored sentence' });
		const wrapper = await mountPanel();
		const note = wrapper.get('[data-testid="run-failure"]');
		expect(note.get('p').text()).toContain(sentence);
		const fix = note.find('[data-testid="run-failure-fix"]');
		if (fixTo === null) expect(fix.exists()).toBe(false);
		else expect(fix.attributes('href')).toBe(fixTo);
	});

	it('keeps the stored text behind a closed disclosure, not in the headline', async () => {
		runsData = failedRun({ reason: 'unknown', detail: 'SMTP connection reset by peer' });
		const wrapper = await mountPanel();
		const note = wrapper.get('[data-testid="run-failure"]');
		expect(note.get('p').text()).toBe('This step failed.');
		const detail = note.get('details[data-testid="run-failure-detail"]');
		expect(detail.attributes('open')).toBeUndefined();
		expect(detail.get('summary').text()).toBe('Details');
		expect(detail.text()).toContain('SMTP connection reset by peer');
	});

	it('reads a code this build does not know as the generic reason with its text', async () => {
		runsData = failedRun({ reason: 'some_future_reason', detail: 'Newer backend text' });
		const wrapper = await mountPanel();
		const note = wrapper.get('[data-testid="run-failure"]');
		expect(note.get('p').text()).toBe('This step failed.');
		expect(note.get('details').text()).toContain('Newer backend text');
	});

	it('tells a member to ask an admin instead of linking an admin page', async () => {
		isAdmin.value = false;
		runsData = failedRun({ reason: 'domain_not_verified', detail: null });
		const wrapper = await mountPanel();
		const note = wrapper.get('[data-testid="run-failure"]');
		expect(note.find('[data-testid="run-failure-fix"]').exists()).toBe(false);
		expect(note.text()).toContain('Ask an admin of this workspace to fix this.');
		expect(note.find('details').exists()).toBe(false);
	});

	it('shows nothing under a run that did not fail', async () => {
		const wrapper = await mountPanel();
		expect(wrapper.find('[data-testid="run-failure"]').exists()).toBe(false);
	});

	it.each(allRunFailureMessageKeys())('%s is worded in English and German', (key) => {
		const lookup = (catalog: unknown) =>
			key
				.split('.')
				.reduce<unknown>(
					(node, part) =>
						node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
					catalog
				);
		expect(typeof lookup(en)).toBe('string');
		expect(typeof lookup(de)).toBe('string');
	});
});
