import { defineAsyncComponent } from 'vue';

/**
 * The dashboard card renderer registry. Each key is a card `type`; the value is
 * the component that renders it. This is the single source of truth for *which*
 * card types can actually be drawn — anything not in here renders as
 * "Unknown card type", so the add-menu (DashboardEditor) filters its options
 * against `RENDERABLE_CARD_TYPES` and the backend's `getAvailableCards` only
 * advertises types present here.
 */
export const cardComponents: Record<string, ReturnType<typeof defineAsyncComponent>> = {
	verification_queue: defineAsyncComponent(
		() => import('~/components/dashboard/cards/VerificationQueueCard.vue')
	),
	campaign_performance: defineAsyncComponent(
		() => import('~/components/dashboard/cards/CampaignPerformanceCard.vue')
	),
	channel_health: defineAsyncComponent(
		() => import('~/components/dashboard/cards/ChannelHealthCard.vue')
	),
	agent_health: defineAsyncComponent(
		() => import('~/components/dashboard/cards/AgentHealthCard.vue')
	),
	recent_contacts: defineAsyncComponent(
		() => import('~/components/dashboard/cards/RecentContactsCard.vue')
	),
	recent_activity: defineAsyncComponent(
		() => import('~/components/dashboard/cards/RecentActivityCard.vue')
	),
	queue_depth: defineAsyncComponent(
		() => import('~/components/dashboard/cards/QueueDepthCard.vue')
	),
	delivery_rates: defineAsyncComponent(
		() => import('~/components/dashboard/cards/DeliveryRatesCard.vue')
	),
	pinned_visualizations: defineAsyncComponent(
		() => import('~/components/dashboard/cards/PinnedVisualizationsCard.vue')
	),
	knowledge_graph: defineAsyncComponent(
		() => import('~/components/dashboard/cards/KnowledgeCard.vue')
	),
	upcoming_campaigns: defineAsyncComponent(
		() => import('~/components/dashboard/cards/UpcomingCampaignsCard.vue')
	),
	cost_by_step: defineAsyncComponent(
		() => import('~/components/dashboard/cards/CostByStepCard.vue')
	),
	accuracy_trend: defineAsyncComponent(
		() => import('~/components/dashboard/cards/AccuracyTrendCard.vue')
	),
};

/** The set of card types that have a renderer. */
export const RENDERABLE_CARD_TYPES = new Set(Object.keys(cardComponents));
