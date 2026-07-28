// @vitest-environment happy-dom
/**
 * The capacity refusal panel. Deliverability plan D14: a multi-day send is a
 * NORMAL, visible state for a warming deployment — never an error and never a
 * surprise. So this suite is a copy-and-treatment audit:
 *   - the panel is informational, not the error treatment
 *   - a truncated enumeration never renders a finish date
 *   - an under-counted audience is presented as a floor
 *   - the escape that actually works today (schedule it later) is named
 *   - every date is rendered in UTC, off the plan's own anchor: `finishesAt` is
 *     the EXCLUSIVE end of the last sliced day, and the slices are anchored on
 *     the SEND START rather than on `now`, so neither the viewer's timezone nor
 *     a future scheduled start may shift a single label.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import CapacitySchedulePanel from '../CapacitySchedulePanel.vue';
import type { CampaignCapacitySchedulePlan } from '~/lib/campaignCapacityRefusal';

const iconStub = { props: ['name'], template: '<span />' };

/**
 * `finishesAt` is an exact UTC midnight — the ONLY value the backend can emit
 * (`capacityPlan.ts`: `utcDayStart(startsAt) + days * MS_PER_DAY`). Five days
 * ending at Jan 10 00:00 UTC means the slices send on Jan 5..Jan 9 UTC.
 */
const BASE: CampaignCapacitySchedulePlan = {
	days: 5,
	slices: [0, 100, 200, 200, 100],
	finishesAt: Date.UTC(2026, 0, 10),
	covered: 600,
	truncated: false,
	audienceUnderCounted: false,
};

/** Midway through the plan's first day, so slice 0 is genuinely "Today". */
const NOW_ON_DAY_ZERO = Date.UTC(2026, 0, 5, 12, 0);

/**
 * Rendered text with runs of whitespace collapsed. Template line wrapping is a
 * formatting artefact; the copy assertions are about the sentence.
 */
function flat(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function mountPanel(
	plan: Partial<CampaignCapacitySchedulePlan> = {},
	dismissible = false,
	now = NOW_ON_DAY_ZERO
) {
	return mount(CapacitySchedulePanel, {
		props: { plan: { ...BASE, ...plan }, dismissible, now },
		global: { stubs: { Icon: iconStub } },
	});
}

describe('CapacitySchedulePanel', () => {
	it('renders the schedule as an offer, not an error', () => {
		const wrapper = mountPanel();
		expect(flat(wrapper.text())).toContain('Sending over 5 days');
		// Informational palette, never the error one — the whole point of D14.
		const html = wrapper.html();
		expect(html).not.toContain('text-error');
		expect(html).not.toContain('bg-error');
		expect(flat(wrapper.text()).toLowerCase()).not.toContain('error');
		expect(flat(wrapper.text()).toLowerCase()).not.toContain('failed');
	});

	it('lists the per-day slices, dated off the plan in UTC', () => {
		const wrapper = mountPanel();
		const items = wrapper.findAll('[data-testid="capacity-schedule-slices"] li');
		expect(items).toHaveLength(5);
		expect(flat(items[0]?.text() ?? '')).toContain('Today');
		expect(flat(items[1]?.text() ?? '')).toContain('Tue, Jan 6');
		expect(flat(items[1]?.text() ?? '')).toContain('100');
		expect(flat(items[4]?.text() ?? '')).toContain('Fri, Jan 9');
	});

	it('closes the half-open finish interval once, at the render boundary', () => {
		// `finishesAt` is Jan 10 00:00 UTC — the midnight that STARTS the day AFTER
		// the last sending day. Quoting it verbatim would promise Jan 10.
		expect(flat(mountPanel().text())).toContain('Everyone is reached by Friday, January 9');
	});

	it('labels "Today" off the SEND START, not off now', () => {
		// The same plan, viewed three days before it starts: nothing goes out today.
		const wrapper = mountPanel({}, false, Date.UTC(2026, 0, 2, 12, 0));
		const items = wrapper.findAll('[data-testid="capacity-schedule-slices"] li');
		expect(flat(items[0]?.text() ?? '')).toContain('Mon, Jan 5');
		expect(flat(wrapper.text())).not.toContain('Today');
	});

	it('collapses a long plan to the first five days plus a remainder count', () => {
		const wrapper = mountPanel({ days: 8, slices: [0, 1, 2, 3, 4, 5, 6, 7] });
		const items = wrapper.findAll('[data-testid="capacity-schedule-slices"] li');
		expect(items).toHaveLength(6);
		expect(flat(items[5]?.text() ?? '')).toContain('+3 more days');
	});

	it('names the escape that works today — schedule it for later', () => {
		expect(flat(mountPanel().text())).toContain('schedule the campaign for a later date');
	});

	it('never quotes a finish date for a truncated enumeration', () => {
		const wrapper = mountPanel({ truncated: true });
		expect(flat(wrapper.text())).toContain('Sending over more than 5 days');
		expect(flat(wrapper.text())).not.toContain('Everyone is reached by');
		expect(flat(wrapper.text())).toContain('600');
	});

	it('presents an under-counted audience as a floor', () => {
		const wrapper = mountPanel({ audienceUnderCounted: true });
		expect(flat(wrapper.text())).toContain('Sending over at least 5 days');
		expect(flat(wrapper.text())).toContain('the schedule above is a floor');
	});

	it('offers a dismiss affordance only when the caller can act on it', () => {
		expect(mountPanel().find('button').exists()).toBe(false);
		const wrapper = mountPanel({}, true);
		expect(wrapper.find('button').exists()).toBe(true);
		void wrapper.find('button').trigger('click');
		expect(wrapper.emitted('dismiss')).toHaveLength(1);
	});
});
