// @vitest-environment happy-dom
/**
 * DecisionRationale read-only surfacing:
 *   - renders the "Sent because… / Held because…" line from agentDecision
 *   - renders the "Grounded in:" list from groundingSources (titles as text)
 *   - DEGRADES CLEANLY when both are absent (renders nothing) — the pre-feature
 *     message case
 *   - shows ONLY the sources it was handed (no cross-contact leak: a component
 *     handed a contact-scoped list can never invent another contact's source)
 *
 * `computed` is polyfilled by the web vitest setup (Nuxt auto-imports); <Icon>
 * is stubbed since it is a global auto-import.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import DecisionRationale from '../DecisionRationale.vue';

const mountOpts = { global: { stubs: { Icon: true } } };

describe('DecisionRationale', () => {
	it('renders the held-because reason and the grounded-in list when present', () => {
		const wrapper = mount(DecisionRationale, {
			...mountOpts,
			props: {
				decision: { decision: 'human_review', reason: 'Draft quality 0.2 < threshold 0.8. Routing to human review.', confidence: 0.9 },
				groundingSources: [
					{ type: 'thread', id: 'm1', title: 'Order 123' },
					{ type: 'knowledge', id: 'k1', title: 'Shipping policy' },
				],
			},
		});

		const text = wrapper.text();
		expect(text).toContain('Held because');
		expect(text).toContain('Draft quality 0.2 < threshold 0.8');
		expect(text).toContain('Grounded in');
		expect(text).toContain('Order 123');
		expect(text).toContain('Shipping policy');
		// One <li> per source — exactly the two it was handed, nothing more.
		expect(wrapper.findAll('li')).toHaveLength(2);
	});

	it('renders "Sent because" for an auto-approve decision', () => {
		const wrapper = mount(DecisionRationale, {
			...mountOpts,
			props: {
				decision: { decision: 'auto_approve', reason: 'Draft quality 0.92 >= threshold 0.8. Auto-approving.', confidence: 0.95 },
				groundingSources: [],
			},
		});
		expect(wrapper.text()).toContain('Sent because');
		expect(wrapper.text()).not.toContain('Grounded in');
	});

	it('degrades cleanly to nothing when both decision and sources are absent', () => {
		const wrapper = mount(DecisionRationale, {
			...mountOpts,
			props: { decision: null, groundingSources: null },
		});
		expect(wrapper.text()).toBe('');
		expect(wrapper.find('div').exists()).toBe(false);
	});

	it('shows the reason but no grounded-in list when sources are empty/absent', () => {
		const wrapper = mount(DecisionRationale, {
			...mountOpts,
			props: {
				decision: { decision: 'human_review', reason: 'Auto-reply is disabled. Routing to human review.', confidence: 0.5 },
			},
		});
		expect(wrapper.text()).toContain('Held because');
		expect(wrapper.text()).not.toContain('Grounded in');
		expect(wrapper.findAll('li')).toHaveLength(0);
	});
});
