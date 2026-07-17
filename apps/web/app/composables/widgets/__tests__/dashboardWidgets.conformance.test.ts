import { describe, it, expect } from 'vitest';
import { dashboardWidgetRegistry, RENDERABLE_CARD_TYPES } from '../dashboardWidgets';
import { resolveWidget } from '../registry';

/**
 * Conformance: the dashboard card surface must keep identical membership,
 * ordering, and fallback behaviour after moving onto the generalised widget
 * registry. This list is pinned to the backend `DEFAULT_CARDS` catalog in
 * `apps/api/convex/analytics/adaptiveDashboard.ts` — the two must stay in
 * lockstep (a type advertised by the backend with no renderer here would draw
 * "Unknown card type").
 */
const EXPECTED_CARD_KINDS = [
	'verification_queue',
	'campaign_performance',
	'channel_health',
	'agent_health',
	'recent_contacts',
	'recent_activity',
	'queue_depth',
	'delivery_rates',
	'pinned_visualizations',
	'knowledge_graph',
	'upcoming_campaigns',
	'cost_by_step',
	'accuracy_trend',
] as const;

describe('dashboard widget registry conformance', () => {
	it('contains exactly the canonical card kinds in canonical order', () => {
		expect(dashboardWidgetRegistry.kinds()).toEqual([...EXPECTED_CARD_KINDS]);
	});

	it('every card is a core contribution with a lazy renderer and no flag', () => {
		for (const module of dashboardWidgetRegistry.list()) {
			expect(module.source).toBe('core');
			// Core cards are ungated: nothing is hidden, so behaviour is unchanged.
			expect(module.flag).toBeUndefined();
			// A lazy loader function (`() => import(...)`), not an eagerly
			// constructed component — laziness is structural, so this pins it.
			expect(module.component).toBeTypeOf('function');
		}
	});

	it('RENDERABLE_CARD_TYPES mirrors the registry kinds', () => {
		expect([...RENDERABLE_CARD_TYPES].sort()).toEqual([...EXPECTED_CARD_KINDS].sort());
		expect(RENDERABLE_CARD_TYPES.size).toBe(EXPECTED_CARD_KINDS.length);
	});

	it('resolves a known card type to ok', () => {
		expect(resolveWidget(dashboardWidgetRegistry, 'delivery_rates', () => true).status).toBe('ok');
	});

	it('resolves an unknown card type to unknown (fallback affordance)', () => {
		expect(dashboardWidgetRegistry.get('made_up_card')).toBeNull();
		expect(resolveWidget(dashboardWidgetRegistry, 'made_up_card', () => true)).toEqual({
			status: 'unknown',
		});
	});
});
