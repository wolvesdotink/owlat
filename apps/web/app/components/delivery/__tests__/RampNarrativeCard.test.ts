// @vitest-environment happy-dom
/**
 * THE RAMP NARRATIVE CARD — rendered, not linted.
 *
 * The a11y pass follows the ramp screens' own (see
 * pages/dashboard/admin/delivery/__tests__/rampScreensA11y.test.ts): heading
 * levels that descend from the page's h1 without skipping, an accessible name on
 * every focusable control, an announceable loading state, and no fact carried by
 * colour alone — the progress meter's value is a SENTENCE, not a bar width.
 *
 * Plus the state that matters most on a card made of good news: a read that
 * FAULTED must not render "no cell is on the ramp yet". That sentence is a claim
 * about a healthy deployment, and a query that never answered has no standing to
 * make it.
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import RampNarrativeCard from '../RampNarrativeCard.vue';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';
import ErrorAlert from '@owlat/ui/components/ui/ErrorAlert.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { cellControl, controlsView, decision, DAY_MS, NOW } from './rampFixtures';
import type { RampControls } from '~/utils/deliverabilityRamp';

const isLoading = ref(false);
const error: Ref<Error | null> = ref(null);
const controls: Ref<RampControls | undefined> = ref(undefined);

beforeEach(() => {
	// The card's copy flows through vue-i18n now; `useI18n` is a Nuxt auto-import,
	// so it has to exist as a bare global for the component's setup.
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	isLoading.value = false;
	error.value = null;
	controls.value = controlsView();
	vi.stubGlobal('useOrganizationQuery', () => ({
		data: controls,
		isLoading,
		error,
		refetch: vi.fn(),
	}));
});

const globalOptions = {
	stubs: {
		Icon: true,
		UiSpinner: true,
		UiCard: { template: '<div><slot /></div>' },
		UiEmptyState: true,
	},
	components: { UiQueryBoundary: QueryBoundary, UiErrorAlert: ErrorAlert },
	plugins: [createTestI18n()],
};

function mountCard() {
	return mount(RampNarrativeCard, { global: globalOptions });
}

/** Every focusable element must take an accessible name from somewhere. */
function unnamedControls(wrapper: VueWrapper): string[] {
	const offenders: string[] = [];
	for (const control of wrapper.findAll('button, a[href], input, select, textarea')) {
		const element = control.element as HTMLElement;
		const hasText = element.textContent !== null && element.textContent.trim().length > 0;
		const hasAria =
			element.getAttribute('aria-label') !== null ||
			element.getAttribute('aria-labelledby') !== null;
		if (!hasText && !hasAria) offenders.push(element.outerHTML.slice(0, 120));
	}
	return offenders;
}

describe('ramp narrative card — the story', () => {
	it('leads with the phase and its progress in words', () => {
		controls.value = controlsView({
			cells: [
				cellControl({ cellKey: 'campaign:gmail', graduatedAt: NOW - DAY_MS }),
				cellControl({ cellKey: 'campaign:microsoft' }),
			],
		});
		const wrapper = mountCard();
		expect(wrapper.find('h2').text()).toBe('Warming up');
		expect(wrapper.find('[data-testid="ramp-progress-label"]').text()).toBe(
			'1 of 2 cells on the ramp graduated so far'
		);
		wrapper.unmount();
	});

	it('renders the controller’s decision sentence and its notice verbatim', () => {
		controls.value = controlsView({
			cells: [
				cellControl({
					lastDecision: decision({
						direction: 'decrease',
						reason: 'hard_bounce',
						message: 'Reduced campaign mail to gmail (50% -> 25%).',
						adminNotice: 'Clean the list before it can climb again.',
					}),
				}),
			],
		});
		const wrapper = mountCard();
		const entries = wrapper.find('[data-testid="ramp-narrative-decisions"]');
		expect(entries.text()).toContain('Reduced campaign mail to gmail (50% -> 25%).');
		expect(wrapper.find('[data-testid="ramp-narrative-notice"]').text()).toBe(
			'Clean the list before it can climb again.'
		);
		expect(wrapper.find('[data-testid="ramp-narrative-direction"]').text()).toBe('Pulled back');
		wrapper.unmount();
	});

	it('says the controller has decided nothing yet without sounding broken', () => {
		controls.value = controlsView({ cells: [cellControl({ lastDecision: null })] });
		const wrapper = mountCard();
		expect(wrapper.find('[data-testid="ramp-narrative-no-decisions"]').text()).toContain(
			'fills in on its own'
		);
		wrapper.unmount();
	});

	it('offers exactly one call to action, pointed at the screen that serves it', () => {
		controls.value = controlsView({ isControllerPaused: true });
		const wrapper = mountCard();
		const cta = wrapper.find('[data-testid="ramp-next-action-cta"]');
		expect(cta.attributes('href')).toBe('/dashboard/admin/delivery/advanced/controls');
		expect(cta.text()).toBe('Open the ramp controls');
		wrapper.unmount();
	});

	it('links all four advanced screens as the way deeper', () => {
		const wrapper = mountCard();
		const hrefs = wrapper.findAll('nav a').map((link) => link.attributes('href'));
		expect(hrefs).toEqual([
			'/dashboard/admin/delivery/advanced/cells',
			'/dashboard/admin/delivery/advanced/controls',
			'/dashboard/admin/delivery/advanced/measurement',
			'/dashboard/admin/delivery/advanced/independence',
		]);
		wrapper.unmount();
	});

	it('renames the independence door on a deployment with no relay', () => {
		controls.value = controlsView({ isRelayConfigured: false });
		const wrapper = mountCard();
		expect(wrapper.find('nav').text()).toContain('Warm-up autopilot');
		wrapper.unmount();
	});
});

describe('ramp narrative card — accessibility', () => {
	it('descends from the page’s h1 without skipping a level', () => {
		const wrapper = mountCard();
		expect(wrapper.findAll('h1')).toHaveLength(0);
		expect(wrapper.findAll('h2')).toHaveLength(1);
		expect(wrapper.findAll('h3').length).toBeGreaterThan(0);
		expect(wrapper.findAll('h4')).toHaveLength(0);
		wrapper.unmount();
	});

	it('names every section by its own visible heading', () => {
		const wrapper = mountCard();
		for (const region of [...wrapper.findAll('section'), ...wrapper.findAll('nav')]) {
			const labelledBy = region.attributes('aria-labelledby');
			expect(labelledBy).toBeTruthy();
			expect(wrapper.find(`#${labelledBy}`).exists()).toBe(true);
		}
		wrapper.unmount();
	});

	it('carries the progress as a value and a sentence, not as a bar width', () => {
		const wrapper = mountCard();
		const meter = wrapper.find('[role="progressbar"]');
		expect(meter.attributes('aria-valuenow')).toBe('0');
		expect(meter.attributes('aria-valuetext')).toBe('0 of 1 cell on the ramp graduated so far');
		const labelledBy = meter.attributes('aria-labelledby');
		expect(wrapper.find(`#${labelledBy}`).element.tagName).toBe('H2');
		wrapper.unmount();
	});

	it('names every control and keeps focus order as DOM order', () => {
		const wrapper = mountCard();
		expect(unnamedControls(wrapper)).toEqual([]);
		expect(wrapper.html()).not.toMatch(/tabindex="[1-9]/);
		wrapper.unmount();
	});

	it('announces the loading state instead of labelling a bare div', () => {
		isLoading.value = true;
		controls.value = undefined;
		const wrapper = mountCard();
		const status = wrapper.find('[role="status"]');
		expect(status.attributes('aria-live')).toBe('polite');
		expect(status.attributes('aria-label')).toBe('Loading your sending ramp');
		wrapper.unmount();
	});

	it('does not claim an empty ramp when the read faulted', () => {
		error.value = new Error('ramp unavailable');
		controls.value = undefined;
		const wrapper = mountCard();
		expect(wrapper.text()).not.toContain('No cell is on the ramp yet');
		expect(wrapper.text()).not.toContain('Nothing needs you right now');
		expect(wrapper.text()).toContain('Couldn’t load the ramp');
		wrapper.unmount();
	});
});
