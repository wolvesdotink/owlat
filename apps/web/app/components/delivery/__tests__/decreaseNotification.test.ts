// @vitest-environment happy-dom
/**
 * AN AUTOMATIC DECREASE PRODUCES AN ADMIN NOTIFICATION NAMING THE GATE AND THE
 * REMEDY (plan D12).
 *
 * A controller that silently retreats will be experienced as a bug. The
 * notification is not a generic "something changed": it names the CHECK that
 * broke and WHAT TO DO about it, and it is the controller's own sentence read
 * back verbatim — the screen must not be able to describe a retreat differently
 * from the audit row that recorded it.
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import RampDecreaseNotices from '../RampDecreaseNotices.vue';
import RampDecisionTimeline from '../RampDecisionTimeline.vue';
import { adminNotice, decision, NOW } from './rampFixtures';

function mountNotices(notices = [adminNotice()]) {
	return mount(RampDecreaseNotices, { props: { notices, labelledBy: 'notices' } });
}

describe('decrease notifications', () => {
	it('names the gate that broke, the move it caused, and the remedy', () => {
		const wrapper = mountNotices();
		expect(wrapper.find('[data-testid="ramp-notice-gate"]').text()).toBe('The hard-bounce gate');
		expect(wrapper.find('[data-testid="ramp-notice-move"]').text()).toContain('→');
		const text = wrapper.find('[data-testid="ramp-notice-text"]').text();
		expect(text).toContain('hard bounce gate breached');
		expect(text).toContain('Clean the list');
		wrapper.unmount();
	});

	it('renders the controller’s sentence verbatim rather than composing its own', () => {
		const notice = adminNotice({ notice: 'A very specific sentence the controller wrote.' });
		const wrapper = mountNotices([notice]);
		expect(wrapper.find('[data-testid="ramp-notice-text"]').text()).toBe(notice.notice);
		wrapper.unmount();
	});

	it('labels a hard stop as such when no gate is named', () => {
		const wrapper = mountNotices([adminNotice({ failedGate: null })]);
		expect(wrapper.find('[data-testid="ramp-notice-gate"]').text()).toBe('Hard stop');
		wrapper.unmount();
	});

	it('treats an empty list as good news, not as an empty state to apologise for', () => {
		const wrapper = mountNotices([]);
		expect(wrapper.find('[data-testid="ramp-notices-empty"]').text()).toContain(
			'Nothing has been pulled back'
		);
		expect(wrapper.html()).not.toContain('text-error');
		wrapper.unmount();
	});

	it('carries the same notice into the cell’s own decision history', () => {
		const wrapper = mount(RampDecisionTimeline, {
			props: {
				decisions: [
					decision({
						at: NOW,
						direction: 'decrease',
						fromShare: 0.5,
						toShare: 0.25,
						reason: 'hard_bounce',
						failedGate: 'hard_bounce',
						message: 'Reduced campaign mail to gmail (50% -> 25%): the hard bounce gate breached.',
						adminNotice:
							'Reduced campaign mail to gmail (50% -> 25%): the hard bounce gate breached. Clean the list.',
					}),
				],
				labelledBy: 'history',
			},
		});
		expect(wrapper.find('[data-direction="decrease"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="ramp-decision-notice"]').text()).toContain('Clean the list');
		wrapper.unmount();
	});
});
