// @vitest-environment happy-dom
/**
 * Accessibility pass on the deliverability measurement screen.
 *
 * The screen is a grid of numbers, which is exactly the kind of surface that
 * ends up unreadable without sight: a colour-coded status pill with no text, a
 * table with no header association, a heading level skipped because a card
 * "looked" like a section. The four properties that prevent that are asserted
 * here against the real mount, in the same shape as the delivery wizard's own
 * a11y pass:
 *
 *   - every cell card is a labelled landmark whose label IS its visible heading;
 *   - heading levels descend without skipping (page h1 → card h3 → group h4);
 *   - the arm comparison is a real table: a caption, column headers and row
 *     headers with explicit scopes;
 *   - status is carried by TEXT, not only by colour, and focus order is DOM
 *     order (no positive tabindex, no focus traps on a read-only page).
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import MeasurementCellCard from '../MeasurementCellCard.vue';
import MeasurementGateList from '../MeasurementGateList.vue';
import { cellView, failingGate, holdingGate } from './measurementFixtures';

const here = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(
	resolve(here, '../../../pages/dashboard/delivery/measurement.vue'),
	'utf8'
);

const stubs = { UiCard: { template: '<div><slot /></div>' }, Icon: { template: '<i />' } };

function mountCard() {
	return mount(MeasurementCellCard, {
		props: {
			cell: cellView({ gates: [failingGate(), holdingGate('deferral')], trend: [] }),
			referenceTransportId: 'ses',
		},
		global: { stubs, components: { DeliveryMeasurementGateList: MeasurementGateList } },
	});
}

describe('measurement screen — accessibility', () => {
	it('labels each cell section with its own visible heading', () => {
		const wrapper = mountCard();
		const section = wrapper.find('section');
		const labelledBy = section.attributes('aria-labelledby');
		expect(labelledBy).toBeTruthy();
		const heading = wrapper.find(`#${labelledBy}`);
		expect(heading.exists()).toBe(true);
		expect(heading.element.tagName).toBe('H3');
		expect(heading.text()).toContain('Gmail');
		wrapper.unmount();
	});

	it('descends heading levels without skipping', () => {
		const wrapper = mountCard();
		expect(wrapper.findAll('h1')).toHaveLength(0);
		expect(wrapper.findAll('h2')).toHaveLength(0);
		expect(wrapper.findAll('h3')).toHaveLength(1);
		expect(wrapper.findAll('h4').length).toBeGreaterThan(0);
		// The page owns the single h1 above these cards.
		expect(pageSource).toContain('<h1');
		wrapper.unmount();
	});

	it('renders the arm comparison as a real table with caption and scoped headers', () => {
		const wrapper = mountCard();
		const table = wrapper.find('[data-testid="measurement-arm-table"]');
		expect(table.find('caption').exists()).toBe(true);
		expect(table.findAll('thead th').every((th) => th.attributes('scope') === 'col')).toBe(true);
		expect(table.findAll('tbody th').every((th) => th.attributes('scope') === 'row')).toBe(true);
		wrapper.unmount();
	});

	it('carries every status as text, not only as colour', () => {
		const wrapper = mountCard();
		for (const gate of wrapper.findAll('[data-testid^="measurement-gate-"]')) {
			expect(gate.text().trim().length).toBeGreaterThan(0);
		}
		expect(wrapper.find('[data-testid="measurement-gate-hard_bounce"]').text()).toContain(
			'Needs attention'
		);
		expect(wrapper.find('[data-testid="measurement-gate-deferral"]').text()).toContain(
			'Not enough data yet'
		);
		wrapper.unmount();
	});

	it('leaves focus order as DOM order on a read-only page', () => {
		const wrapper = mountCard();
		expect(wrapper.html()).not.toMatch(/tabindex="[1-9]/);
		// Read-only: the card offers no controls to get stranded in.
		expect(wrapper.findAll('button')).toHaveLength(0);
		expect(wrapper.findAll('input')).toHaveLength(0);
		wrapper.unmount();
	});

	it('gives the page a loading label and a non-alarming error message', () => {
		expect(pageSource).toContain('loading-label="Loading delivery measurements…"');
		expect(pageSource).toContain('Your mail is unaffected');
	});
});
