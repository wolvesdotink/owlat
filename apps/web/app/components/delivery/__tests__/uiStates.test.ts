// @vitest-environment happy-dom
/**
 * THE STATES ARE THE FEATURE (plan D2, D10, D14).
 *
 * insufficient_data, zero volume, no relay, no integration and low confidence are
 * the states a real deployment spends most of its life in. Every one of them must
 * render CALMLY, with a concrete thing the operator could do if they want to —
 * never a warning, never a nag, never a "setup incomplete".
 *
 * The assertion that carries the most weight is the negative one: no error tone
 * anywhere in these states. A screen that says the right words in an alarming
 * colour has still told the operator their install is broken.
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import IndependenceTrendChart from '../IndependenceTrendChart.vue';
import RampCellsGrid from '../RampCellsGrid.vue';
import RampCellControls from '../RampCellControls.vue';
import RampDecreaseNotices from '../RampDecreaseNotices.vue';
import RampDecisionTimeline from '../RampDecisionTimeline.vue';
import MeasurementGateList from '../MeasurementGateList.vue';
import { improvementCopy, confidenceLabel } from '~/utils/deliverabilityMeasurement';
import { holdingGate } from './measurementFixtures';
import { cellControl, NOW } from './rampFixtures';

const ALARM = /text-error|bg-error|setup incomplete|action required|something went wrong/i;

describe('calm states', () => {
	it('renders a zero-volume, never-ramped cell as neutral with no warning tone', () => {
		const wrapper = mount(RampCellsGrid, {
			props: {
				cells: [cellControl({ isRampManaged: false, ownShare: 0, lastDecision: null })],
				selectedCellKey: null,
				labelledBy: 'grid',
			},
		});
		const state = wrapper.find('[data-testid="ramp-cell-state"]');
		expect(state.attributes('data-state')).toBe('unmanaged');
		expect(state.text()).toBe('Not on the ramp yet');
		expect(wrapper.find('[data-testid="ramp-cell-constraint"]').text()).toContain(
			'not being ramped yet'
		);
		expect(wrapper.html()).not.toMatch(ALARM);
		wrapper.unmount();
	});

	it('offers an improvement rather than a nag on a cell the ramp does not manage', () => {
		const wrapper = mount(RampCellControls, {
			props: { cell: cellControl({ isRampManaged: false }) },
		});
		const note = wrapper.find('[data-testid="ramp-controls-unmanaged"]').text();
		expect(note).toContain('joins on its own');
		expect(note).toContain('no setup needed');
		// Controls exist but are inert — no dead-end, no error.
		expect(wrapper.find('[data-testid="ramp-control-pause"]').attributes('disabled')).toBeDefined();
		expect(wrapper.html()).not.toMatch(ALARM);
		wrapper.unmount();
	});

	it('renders insufficient_data as a distance from a floor, in a neutral tone', () => {
		const wrapper = mount(MeasurementGateList, {
			props: { gates: [holdingGate()], failedGate: null, requiresCorroboration: false },
		});
		expect(wrapper.text()).toContain('Not enough data yet');
		expect(wrapper.html()).not.toMatch(ALARM);
		wrapper.unmount();
	});

	it('names what would improve a low-confidence measurement as an invitation', () => {
		expect(confidenceLabel('low')).toBe('Measurement confidence: low');
		expect(improvementCopy('connect_reference_transport')).toContain('Connect a relay');
		expect(improvementCopy('add_seed_mailboxes')).toContain('Add seed mailboxes');
		expect(improvementCopy('send_more_volume')).toContain('Send more');
		for (const improvement of [
			'connect_reference_transport',
			'add_seed_mailboxes',
			'send_more_volume',
		] as const) {
			expect(improvementCopy(improvement)).not.toMatch(/must|required|incomplete/i);
		}
	});

	it('draws no chart, and no alarm, with nothing or one day of history', () => {
		const empty = mount(IndependenceTrendChart, {
			props: { points: [], hasReference: false, labelledBy: 'chart' },
		});
		expect(empty.find('[data-testid="independence-chart-empty"]').text()).toContain(
			'Nothing has been sent yet'
		);
		expect(empty.html()).not.toMatch(ALARM);
		empty.unmount();

		const single = mount(IndependenceTrendChart, {
			props: {
				points: [{ day: NOW, own: 10, reference: 0 }],
				hasReference: false,
				labelledBy: 'chart',
			},
		});
		expect(single.find('[data-testid="independence-chart-empty"]').text()).toContain(
			'One day of history'
		);
		single.unmount();
	});

	it('collapses the chart to one band with no relay — a supported configuration', () => {
		const points = Array.from({ length: 5 }, (_, index) => ({
			day: NOW + index * 86_400_000,
			own: 100 + index,
			reference: 0,
		}));
		const wrapper = mount(IndependenceTrendChart, {
			props: { points, hasReference: false, labelledBy: 'chart' },
		});
		expect(wrapper.find('[data-testid="own-band"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="reference-band"]').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('Relay');
		wrapper.unmount();
	});

	it('treats "nothing has happened yet" as normal in both history surfaces', () => {
		const notices = mount(RampDecreaseNotices, { props: { notices: [], labelledBy: 'n' } });
		expect(notices.html()).not.toMatch(ALARM);
		notices.unmount();

		const timeline = mount(RampDecisionTimeline, { props: { decisions: [], labelledBy: 'h' } });
		expect(timeline.html()).not.toMatch(ALARM);
		timeline.unmount();
	});
});
