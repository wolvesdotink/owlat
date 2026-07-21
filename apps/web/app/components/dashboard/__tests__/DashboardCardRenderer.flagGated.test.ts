// @vitest-environment happy-dom
/**
 * Pins the renderer's flag-gated omit branch, which the core-card suite cannot
 * reach (core cards carry no flag). A flag-off widget must be omitted entirely —
 * no WidgetHost, no "Unknown card type" affordance, and no size-class wrapper.
 *
 * This lives in its own file because it mocks the widget registry to a single
 * flag-gated kind; the sibling suite exercises the real dashboard registry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';

vi.mock('~/composables/widgets/dashboardWidgets', async () => {
	const { createWidgetRegistry } = await import('~/composables/widgets/registry');
	const registry = createWidgetRegistry([
		{
			kind: 'flagged_widget',
			source: 'core',
			flag: 'plugin.acme',
			component: () => Promise.resolve({ template: '<div />' }),
		},
	]);
	return { dashboardWidgetRegistry: registry, RENDERABLE_CARD_TYPES: new Set(registry.kinds()) };
});

import DashboardCardRenderer from '../DashboardCardRenderer.vue';

const stubs = {
	WidgetHost: {
		name: 'WidgetHost',
		props: ['module'],
		template: '<div data-testid="host" :data-kind="module.kind" />',
	},
	UiCard: { template: '<div class="ui-card"><slot /></div>' },
	Icon: true,
};

beforeEach(() => {
	// Flag off → the gated widget resolves to `disabled`.
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
});

describe('DashboardCardRenderer — flag-gated widget', () => {
	it('omits a flag-off widget entirely', () => {
		const wrapper = mount(DashboardCardRenderer, {
			props: { card: { type: 'flagged_widget', size: 'medium' } },
			global: { stubs },
		});
		// Nothing renders: no host, no unknown-card affordance, no size-class wrapper.
		expect(wrapper.find('[data-testid="host"]').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('Unknown card type');
		expect(wrapper.find('div').exists()).toBe(false);
	});

	it('renders the gated widget through WidgetHost when its flag is on', () => {
		vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => true }));
		const wrapper = mount(DashboardCardRenderer, {
			props: { card: { type: 'flagged_widget', size: 'medium' } },
			global: { stubs },
		});
		const host = wrapper.find('[data-testid="host"]');
		expect(host.exists()).toBe(true);
		expect(host.attributes('data-kind')).toBe('flagged_widget');
	});
});
