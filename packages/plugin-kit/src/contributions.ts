export const PLUGIN_CONTRIBUTION_KINDS = [
	'sendTransports',
	'agentSteps',
	'draftStrategies',
	'sendGates',
	'lifecycleEffects',
	'assistantTools',
	'automationTriggers',
	'automationSteps',
	'automationConditions',
	'inboundAdapters',
	'webhookEvents',
	'importProviders',
	'channelAdapters',
	'crons',
	'emailBlocks',
	'commands',
	'navItems',
	'settingsPanels',
	'panels',
	'widgets',
	'taskCards',
] as const;

export type PluginContributionKind = (typeof PLUGIN_CONTRIBUTION_KINDS)[number];

/**
 * Framework-specific contribution interfaces are introduced with the seam
 * that consumes them. PP-01 only fixes their manifest buckets.
 */
export type PluginContributions = Readonly<
	Partial<Record<PluginContributionKind, readonly unknown[]>>
>;
