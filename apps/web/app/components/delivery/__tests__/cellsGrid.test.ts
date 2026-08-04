// @vitest-environment happy-dom
/**
 * THE CELL GRID AND ITS DRILL-DOWN.
 *
 * Four facts per cell — share, state, BINDING CONSTRAINT, LAST DECISION REASON —
 * and the drill-down's two halves: the gate-by-gate evidence and the full
 * decision history including the no-ops.
 *
 * MOUNTED, NOT READ AS SOURCE. A binding constraint inside an HTML comment, or a
 * prop with no runtime effect, passes a substring check and fails a user.
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import RampCellsGrid from '../RampCellsGrid.vue';
import RampDecisionTimeline from '../RampDecisionTimeline.vue';
import MeasurementGateList from '../MeasurementGateList.vue';
import { cellControl, DAY_MS, decision, NOW } from './rampFixtures';
import { cellView, holdingGate } from './measurementFixtures';

function mountGrid(cells = [cellControl()]) {
	return mount(RampCellsGrid, {
		props: { cells, selectedCellKey: null, labelledBy: 'grid-heading' },
	});
}

describe('cells grid', () => {
	it('shows the share, the state, the binding constraint and the last decision', () => {
		const wrapper = mountGrid([
			cellControl({
				ownShare: 0.25,
				lastDecision: decision({
					reason: 'phase_ceiling',
					direction: 'hold',
					message: 'Held campaign mail to gmail at 25%: the cell is at its phase ceiling.',
				}),
			}),
		]);
		expect(wrapper.find('[data-testid="ramp-cell-share"]').text()).toContain('25');
		expect(wrapper.find('[data-testid="ramp-cell-state"]').text()).toBe('Holding');
		expect(wrapper.find('[data-testid="ramp-cell-constraint"]').text()).toBe('The phase ceiling');
		expect(wrapper.find('[data-testid="ramp-cell-reason"]').text()).toContain(
			'at its phase ceiling'
		);
		wrapper.unmount();
	});

	it('renders one row per cell, as a table with row and column headers', () => {
		const wrapper = mountGrid([
			cellControl(),
			cellControl({
				cell: { stream: 'transactional', destinationProvider: 'yahoo' },
				cellKey: 'transactional:yahoo',
			}),
		]);
		expect(wrapper.findAll('tbody tr')).toHaveLength(2);
		expect(wrapper.findAll('th[scope="col"]').length).toBe(5);
		expect(wrapper.findAll('th[scope="row"]').length).toBe(2);
		wrapper.unmount();
	});

	it('names an operator pause and an operator pin as the constraint, not the controller', () => {
		const paused = mountGrid([
			cellControl({ isPaused: true, lastDecision: decision({ reason: 'operator_pause' }) }),
		]);
		expect(paused.find('[data-testid="ramp-cell-state"]').text()).toBe('Paused by you');
		expect(paused.find('[data-testid="ramp-cell-constraint"]').text()).toContain('Your pause');
		paused.unmount();

		const pinned = mountGrid([
			cellControl({ pinnedShare: 0.4, lastDecision: decision({ reason: 'operator_pin' }) }),
		]);
		expect(pinned.find('[data-testid="ramp-cell-state"]').text()).toContain('Pinned at');
		pinned.unmount();
	});

	it('opens a cell through its own button and reports the expanded state', async () => {
		const wrapper = mountGrid();
		const button = wrapper.find('[data-testid="ramp-cell-open-campaign:gmail"]');
		expect(button.attributes('aria-expanded')).toBe('false');
		await button.trigger('click');
		expect(wrapper.emitted('select')?.[0]).toEqual(['campaign:gmail']);
		wrapper.unmount();
	});
});

describe('cells drill-down', () => {
	it('shows every gate with the numbers behind its verdict', () => {
		const cell = cellView();
		const wrapper = mount(MeasurementGateList, {
			props: {
				gates: cell.gates,
				failedGate: cell.failedGate,
				requiresCorroboration: cell.requiresCorroboration,
			},
		});
		expect(wrapper.findAll('li').length).toBe(cell.gates.length);
		wrapper.unmount();
	});

	it('renders a holding gate neutrally, with how far off its floor it is', () => {
		const holding = holdingGate();
		const wrapper = mount(MeasurementGateList, {
			props: { gates: [holding], failedGate: null, requiresCorroboration: false },
		});
		expect(wrapper.text()).toContain('124');
		expect(wrapper.text()).toContain('400');
		expect(wrapper.html()).not.toContain('text-error');
		wrapper.unmount();
	});

	it('shows the decision history including the no-ops', () => {
		const wrapper = mount(RampDecisionTimeline, {
			props: {
				decisions: [
					decision({ direction: 'hold', reason: 'building_confidence' }),
					decision({ direction: 'increase', reason: 'healthy' }),
				],
				labelledBy: 'history',
			},
		});
		expect(wrapper.findAll('li')).toHaveLength(2);
		expect(wrapper.find('[data-testid="ramp-decision-move"]').text()).toContain('→');
		wrapper.unmount();
	});

	it('says so plainly when a cell has no decisions yet', () => {
		const wrapper = mount(RampDecisionTimeline, {
			props: { decisions: [], labelledBy: 'history' },
		});
		expect(wrapper.find('[data-testid="ramp-timeline-empty"]').exists()).toBe(true);
		expect(wrapper.text()).not.toMatch(/error|failed|problem/i);
		wrapper.unmount();
	});
});
