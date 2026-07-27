// @vitest-environment happy-dom
/**
 * Deliverability measurement screen — every state (plan D2, D5, D10, D14).
 *
 * THE STATES ARE THE FEATURE, so each one is a test rather than an afterthought:
 * a healthy cell, a cell holding on thin data, a zero-volume cell, a standalone
 * cell with no reference arm, a deployment with no integrations connected, and
 * a failing gate whose NUMBERS are rendered next to its verdict.
 *
 * Plus the regression that keeps plan D5 true: NO RATE IS RECOMPUTED CLIENT
 * SIDE. The fixture at the bottom carries counters that flatly contradict its
 * rates; the component must print the server's rate, because the moment it
 * starts dividing counters itself, the screen and the ramp controller can
 * disagree about the same traffic.
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import MeasurementCellCard from '../MeasurementCellCard.vue';
import MeasurementGateList from '../MeasurementGateList.vue';
import { armSummary, cellView, failingGate, holdingGate, passingGate } from './measurementFixtures';
import type { DeliverabilityDashboardCell } from '~/utils/deliverabilityMeasurement';

const stubs = {
	UiCard: { template: '<div><slot /></div>' },
	Icon: { template: '<i />' },
};

function mountCard(cell: DeliverabilityDashboardCell, referenceTransportId: string | null = 'ses') {
	return mount(MeasurementCellCard, {
		props: { cell, referenceTransportId },
		global: {
			stubs,
			components: { DeliveryMeasurementGateList: MeasurementGateList },
		},
	});
}

describe('measurement cell card — healthy cell', () => {
	it('renders both arms side by side with the server’s counters and rates', () => {
		const wrapper = mountCard(
			cellView({
				own: armSummary({ sent: 1000, delivered: 980, hardBounced: 4, hardBounceRate: 0.004 }),
				reference: armSummary({ sent: 900, delivered: 890, hardBounced: 9, hardBounceRate: 0.01 }),
			})
		);

		const row = wrapper.find('[data-testid="measurement-metric-hardBounced"]');
		expect(row.exists()).toBe(true);
		expect(row.text()).toContain('4');
		expect(row.text()).toContain('0.40%');
		expect(row.text()).toContain('1.00%');
		expect(wrapper.find('[data-testid="measurement-own-share"]').text()).toBe('25%');
		expect(wrapper.find('[data-testid="measurement-confidence"]').text()).toContain('high');
		wrapper.unmount();
	});

	it('names the reference transport as the comparison column', () => {
		const wrapper = mountCard(cellView(), 'resend');
		expect(wrapper.find('[data-testid="measurement-arm-table"]').text()).toContain('resend');
		wrapper.unmount();
	});
});

describe('measurement cell card — insufficient data is not a failure', () => {
	it('says how far off the floor the sample is, in a neutral tone', () => {
		const wrapper = mountCard(
			cellView({
				verdict: 'insufficient_data',
				gates: [holdingGate()],
				confidence: {
					level: 'low',
					improvements: ['send_more_volume'],
					ownSample: 124,
					minSample: 400,
				},
			})
		);

		const gate = wrapper.find('[data-testid="measurement-gate-hard_bounce"]');
		expect(gate.attributes('data-status')).toBe('insufficient_data');
		expect(gate.text()).toContain('Not enough data yet');
		expect(gate.text()).toContain('124 of 400 sends this window');
		// Thin is not broken: nothing in a holding gate may render in an error tone.
		expect(gate.classes().join(' ')).not.toContain('error');
		wrapper.unmount();
	});
});

describe('measurement cell card — zero volume', () => {
	it('renders empty and calm rather than as a problem', () => {
		const wrapper = mountCard(
			cellView({
				own: armSummary(),
				reference: armSummary(),
				verdict: 'insufficient_data',
				gates: [holdingGate()],
				confidence: { level: 'none', improvements: [], ownSample: 0, minSample: 400 },
			})
		);

		expect(wrapper.find('[data-testid="measurement-empty"]').text()).toContain(
			'nothing to measure'
		);
		expect(wrapper.find('[data-testid="measurement-arm-table"]').exists()).toBe(false);
		expect(wrapper.text()).not.toMatch(/error|failed|incomplete/i);
		wrapper.unmount();
	});
});

describe('measurement cell card — standalone (no reference arm)', () => {
	it('renders one column plus the confidence caveat and a concrete next step', () => {
		const wrapper = mountCard(
			cellView({
				reference: null,
				gates: [holdingGate()],
				confidence: {
					level: 'low',
					improvements: ['connect_reference_transport', 'add_seed_mailboxes'],
					ownSample: 1000,
					minSample: 400,
				},
			}),
			null
		);

		expect(wrapper.findAll('[data-testid="measurement-reference-value"]')).toHaveLength(0);
		expect(wrapper.find('[data-testid="measurement-confidence"]').text()).toContain(
			'confidence: low'
		);
		expect(
			wrapper.find('[data-testid="measurement-improvement-connect_reference_transport"]').text()
		).toContain('Connect a relay');
		expect(
			wrapper.find('[data-testid="measurement-improvement-add_seed_mailboxes"]').text()
		).toContain('seed mailboxes');
		wrapper.unmount();
	});

	it('renders an unconnected integration as an invitation, never as a warning', () => {
		const wrapper = mountCard(
			cellView({
				reference: null,
				confidence: {
					level: 'low',
					improvements: ['connect_reference_transport'],
					ownSample: 1000,
					minSample: 400,
				},
			}),
			null
		);

		const invitation = wrapper.find('[data-testid="measurement-improvements"]');
		expect(invitation.text()).toContain('Improve this measurement');
		expect(invitation.text()).not.toMatch(/required|must|incomplete|action needed/i);
		expect(invitation.classes().join(' ')).not.toContain('warning');
		wrapper.unmount();
	});
});

describe('measurement cell card — a failing gate', () => {
	it('renders the numbers behind the verdict, not just the verdict', () => {
		const wrapper = mountCard(
			cellView({
				verdict: 'fail',
				failedGate: 'hard_bounce',
				gates: [failingGate(), passingGate('deferral')],
			})
		);

		const gate = wrapper.find('[data-testid="measurement-gate-hard_bounce"]');
		expect(gate.attributes('data-status')).toBe('fail');
		expect(gate.text()).toContain('Needs attention');
		// own rate, own sample, the threshold it breached, and the other arm.
		expect(gate.text()).toContain('4.10%');
		expect(gate.text()).toContain('1,200');
		expect(gate.text()).toContain('2.00%');
		expect(gate.text()).toContain('0.20%');
		wrapper.unmount();
	});

	it('flags a tripwire gate as needing corroboration before anything acts on it', () => {
		const wrapper = mountCard(
			cellView({
				verdict: 'fail',
				failedGate: 'seed_placement',
				requiresCorroboration: true,
				gates: [passingGate(), failingGate('seed_placement')],
			})
		);

		expect(wrapper.find('[data-testid="measurement-gate-corroboration"]').text()).toContain(
			'tripwire'
		);
		wrapper.unmount();
	});
});

describe('regression — no rate is recomputed client side (plan D5)', () => {
	it('prints the server’s rate even when the counters would imply another one', () => {
		// 500 of 1000 sends hard bounced, but the server says 1.00%. The screen is
		// NOT allowed to "fix" that: it renders what the one summarizer derived.
		const wrapper = mountCard(
			cellView({
				own: armSummary({ sent: 1000, delivered: 900, hardBounced: 500, hardBounceRate: 0.01 }),
				reference: null,
			}),
			null
		);

		const row = wrapper.find('[data-testid="measurement-metric-hardBounced"]');
		expect(row.text()).toContain('500');
		expect(row.text()).toContain('1.00%');
		expect(row.text()).not.toContain('50.00%');
		wrapper.unmount();
	});

	it('prints the gate’s own measurement verbatim', () => {
		const wrapper = mountCard(
			cellView({
				verdict: 'fail',
				failedGate: 'complaint',
				gates: [
					{
						gate: 'complaint',
						status: 'fail',
						reason: 'reference_tolerance_breached',
						measurement: {
							thresholdRate: 0.001,
							toleranceValuePp: 0.05,
							ownSample: 4000,
							referenceSample: 4000,
							minSample: 1000,
							ownRate: 0.0031,
							referenceRate: 0.0004,
						},
					},
				],
			})
		);

		const gate = wrapper.find('[data-testid="measurement-gate-complaint"]');
		expect(gate.text()).toContain('0.31%');
		expect(gate.text()).toContain('0.04%');
		expect(gate.text()).toContain('0.10%');
		wrapper.unmount();
	});
});
