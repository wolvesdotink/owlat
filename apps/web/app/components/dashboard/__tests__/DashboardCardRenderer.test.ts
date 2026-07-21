// @vitest-environment happy-dom
/**
 * DashboardCardRenderer routes each dashboard card through the widget registry.
 * These tests pin the behaviour the dashboard grid relied on before the move to
 * the generalised registry: known types render (behind WidgetHost), unknown
 * types show the "Unknown card type" affordance, and the size class survives.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import DashboardCardRenderer from '../DashboardCardRenderer.vue';

beforeEach(() => {
	// The renderer gates widgets on feature flags; core cards are ungated.
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => true }));
});

const stubs = {
	WidgetHost: {
		name: 'WidgetHost',
		props: ['module'],
		template: '<div data-testid="host" :data-kind="module.kind" />',
	},
	UiCard: { template: '<div class="ui-card"><slot /></div>' },
	Icon: true,
};

function renderCard(card: { type: string; size: 'small' | 'medium' | 'large' }) {
	return mount(DashboardCardRenderer, { props: { card }, global: { stubs } });
}

describe('DashboardCardRenderer', () => {
	it('renders a known card type through WidgetHost with the resolved module', () => {
		const wrapper = renderCard({ type: 'delivery_rates', size: 'medium' });
		const host = wrapper.find('[data-testid="host"]');
		expect(host.exists()).toBe(true);
		expect(host.attributes('data-kind')).toBe('delivery_rates');
		expect(wrapper.find('.ui-card').exists()).toBe(false);
	});

	it('shows the "Unknown card type" affordance for an unregistered type', () => {
		const wrapper = renderCard({ type: 'not_a_real_card', size: 'small' });
		expect(wrapper.find('[data-testid="host"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('Unknown card type: not_a_real_card');
	});

	it('applies the large size span class', () => {
		const wrapper = renderCard({ type: 'verification_queue', size: 'large' });
		expect(wrapper.get('div').classes()).toContain('lg:col-span-4');
	});

	it('applies the small size span class', () => {
		const wrapper = renderCard({ type: 'verification_queue', size: 'small' });
		expect(wrapper.get('div').classes()).toContain('col-span-1');
	});

	it('renders ungated core cards regardless of flag state (behaviour preserved)', () => {
		// Core cards carry no flag, so a fully-off flag state must not hide them —
		// the pre-registry behaviour where every renderable card always showed.
		// (The flag-gated `disabled` omit branch is covered at the resolveWidget
		// unit level, since core cards cannot exercise it.)
		vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
		const wrapper = renderCard({ type: 'verification_queue', size: 'small' });
		expect(wrapper.find('[data-testid="host"]').exists()).toBe(true);
	});
});
