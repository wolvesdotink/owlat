import { defineAsyncComponent } from 'vue';
import { createWidgetRegistry } from './registry';
import type { WidgetModule } from './types';

/**
 * The built-in dashboard card widgets. Each entry is the single source of truth
 * for *which* card types can actually be drawn: a type absent here resolves as
 * "unknown" and renders the "Unknown card type" affordance, so the add-menu
 * (`DashboardEditor`) filters its options against `RENDERABLE_CARD_TYPES` and the
 * backend's `getAvailableCards` only advertises types present here.
 *
 * Order and membership are pinned by a conformance test and MUST stay in lockstep
 * with the backend `DEFAULT_CARDS` catalog in
 * `apps/api/convex/analytics/adaptiveDashboard.ts`. Labels/descriptions for these
 * core cards are sourced from that backend catalog (surfaced via
 * `getAvailableCards`), so they are intentionally omitted here.
 */
const CORE_DASHBOARD_WIDGETS: readonly WidgetModule[] = [
	{
		kind: 'verification_queue',
		source: 'core',
		component: defineAsyncComponent(
			() => import('~/components/dashboard/cards/VerificationQueueCard.vue')
		),
	},
	{
		kind: 'campaign_performance',
		source: 'core',
		component: defineAsyncComponent(
			() => import('~/components/dashboard/cards/CampaignPerformanceCard.vue')
		),
	},
	{
		kind: 'channel_health',
		source: 'core',
		component: defineAsyncComponent(
			() => import('~/components/dashboard/cards/ChannelHealthCard.vue')
		),
	},
	{
		kind: 'agent_health',
		source: 'core',
		component: defineAsyncComponent(
			() => import('~/components/dashboard/cards/AgentHealthCard.vue')
		),
	},
	{
		kind: 'recent_contacts',
		source: 'core',
		component: defineAsyncComponent(
			() => import('~/components/dashboard/cards/RecentContactsCard.vue')
		),
	},
	{
		kind: 'recent_activity',
		source: 'core',
		component: defineAsyncComponent(
			() => import('~/components/dashboard/cards/RecentActivityCard.vue')
		),
	},
	{
		kind: 'queue_depth',
		source: 'core',
		component: defineAsyncComponent(
			() => import('~/components/dashboard/cards/QueueDepthCard.vue')
		),
	},
	{
		kind: 'delivery_rates',
		source: 'core',
		component: defineAsyncComponent(
			() => import('~/components/dashboard/cards/DeliveryRatesCard.vue')
		),
	},
	{
		kind: 'pinned_visualizations',
		source: 'core',
		component: defineAsyncComponent(
			() => import('~/components/dashboard/cards/PinnedVisualizationsCard.vue')
		),
	},
	{
		kind: 'knowledge_graph',
		source: 'core',
		component: defineAsyncComponent(
			() => import('~/components/dashboard/cards/KnowledgeCard.vue')
		),
	},
	{
		kind: 'upcoming_campaigns',
		source: 'core',
		component: defineAsyncComponent(
			() => import('~/components/dashboard/cards/UpcomingCampaignsCard.vue')
		),
	},
	{
		kind: 'cost_by_step',
		source: 'core',
		component: defineAsyncComponent(
			() => import('~/components/dashboard/cards/CostByStepCard.vue')
		),
	},
	{
		kind: 'accuracy_trend',
		source: 'core',
		component: defineAsyncComponent(
			() => import('~/components/dashboard/cards/AccuracyTrendCard.vue')
		),
	},
];

/**
 * The composed dashboard widget registry. Bundled-plugin dashboard cards will be
 * appended here through the host-composition seam; today the deployment ships
 * only core cards, so the plugin contribution list is empty.
 */
export const dashboardWidgetRegistry = createWidgetRegistry(CORE_DASHBOARD_WIDGETS);

/** The set of dashboard card types that have a renderer. */
export const RENDERABLE_CARD_TYPES: ReadonlySet<string> = new Set(
	dashboardWidgetRegistry.kinds()
);
