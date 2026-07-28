export type ProviderRouteMessageType = 'campaign' | 'transactional' | 'automation';
export type ProviderRouteStrategy =
	| 'single'
	| 'priority_failover'
	| 'workload_split'
	| 'adaptive_mix';

/**
 * Strategies the ramp controller owns. They are never offered in the picker —
 * an operator cannot meaningfully choose a strategy whose control variable
 * (the per-cell own-MTA share) is written by the controller — but a route
 * already using one must still render, and must survive an unrelated edit
 * instead of being silently downgraded to the first pickable option.
 */
export const CONTROLLER_OWNED_STRATEGIES: readonly ProviderRouteStrategy[] = ['adaptive_mix'];

export function isControllerOwnedStrategy(strategy: string): boolean {
	// The haystack is widened rather than the needle narrowed: `strategy` is an
	// arbitrary caller-supplied string, and asserting it INTO the domain union
	// just to satisfy `.includes` would claim a fact we are still asking about.
	return (CONTROLLER_OWNED_STRATEGIES as readonly string[]).includes(strategy);
}

/** Label for any strategy, pickable or not. */
export const PROVIDER_ROUTE_STRATEGY_LABELS: Record<ProviderRouteStrategy, string> = {
	single: 'Single provider',
	priority_failover: 'Priority failover',
	workload_split: 'Workload split',
	adaptive_mix: 'Adaptive mix (managed)',
};

/**
 * Label for a strategy string that arrived from the server, which may name a
 * kind this build does not know yet. The lookup is widened to `string` keys so
 * the miss is TYPED as a miss and the fallback branch is reachable — indexing
 * the `Record<ProviderRouteStrategy, string>` through a cast would type the
 * result as `string` and make the fallback dead per the type while still being
 * the only thing handling an unrecognised kind.
 */
export function strategyLabelFor(strategy: string): string {
	return (PROVIDER_ROUTE_STRATEGY_LABELS as Readonly<Record<string, string>>)[strategy] ?? strategy;
}

export const PROVIDER_ROUTE_MESSAGE_TYPES: {
	value: ProviderRouteMessageType;
	label: string;
	description: string;
	icon: string;
}[] = [
	{
		value: 'transactional',
		label: 'Transactional',
		description: 'Account, confirmation, and other one-to-one emails',
		icon: 'lucide:mail-check',
	},
	{
		value: 'campaign',
		label: 'Campaigns',
		description: 'Broadcast newsletters and marketing campaigns',
		icon: 'lucide:megaphone',
	},
	{
		value: 'automation',
		label: 'Automations',
		description: 'Emails sent by automated journeys and triggers',
		icon: 'lucide:workflow',
	},
];

/** The operator-selectable strategies. Controller-owned kinds are excluded. */
export const PROVIDER_ROUTE_STRATEGIES: {
	value: ProviderRouteStrategy;
	label: string;
	description: string;
}[] = [
	{
		value: 'single',
		label: PROVIDER_ROUTE_STRATEGY_LABELS.single,
		description: 'Always send through the first enabled provider.',
	},
	{
		value: 'priority_failover',
		label: PROVIDER_ROUTE_STRATEGY_LABELS.priority_failover,
		description:
			'Try providers in order; fall over to the next on failure or when one is unhealthy.',
	},
	{
		value: 'workload_split',
		label: PROVIDER_ROUTE_STRATEGY_LABELS.workload_split,
		description: 'Distribute traffic across providers by the weights you set.',
	},
];
