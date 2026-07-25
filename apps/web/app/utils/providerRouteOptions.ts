export type ProviderRouteMessageType = 'campaign' | 'transactional' | 'automation';
export type ProviderRouteStrategy = 'single' | 'priority_failover' | 'workload_split';

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

export const PROVIDER_ROUTE_STRATEGIES: {
	value: ProviderRouteStrategy;
	label: string;
	description: string;
}[] = [
	{
		value: 'single',
		label: 'Single provider',
		description: 'Always send through the first enabled provider.',
	},
	{
		value: 'priority_failover',
		label: 'Priority failover',
		description:
			'Try providers in order; fall over to the next on failure or when one is unhealthy.',
	},
	{
		value: 'workload_split',
		label: 'Workload split',
		description: 'Distribute traffic across providers by the weights you set.',
	},
];
