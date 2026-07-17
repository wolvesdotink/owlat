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

const PLUGIN_CONTRIBUTION_KIND_SET = new Set<string>(PLUGIN_CONTRIBUTION_KINDS);

export function isPluginContributionKind(value: string): value is PluginContributionKind {
	return PLUGIN_CONTRIBUTION_KIND_SET.has(value);
}

/**
 * Framework-specific contribution interfaces are introduced with the seam
 * that consumes them. PP-01 only fixes their manifest buckets.
 */
type DeferredPluginContributionKind = Exclude<
	PluginContributionKind,
	| 'sendTransports'
	| 'agentSteps'
	| 'draftStrategies'
	| 'sendGates'
	| 'automationTriggers'
	| 'automationSteps'
	| 'automationConditions'
	| 'webhookEvents'
	| 'importProviders'
>;

export type PluginContributions = Readonly<
	{
		readonly sendTransports?: readonly PluginSendTransportDefinition[];
		readonly agentSteps?: readonly PluginAgentStepDefinition[];
		readonly draftStrategies?: readonly PluginDraftStrategyDefinition[];
		readonly sendGates?: readonly PluginAutonomyGateDefinition[];
		readonly automationTriggers?: readonly PluginAutomationTriggerDefinition[];
		readonly automationSteps?: readonly PluginAutomationStepDefinition[];
		readonly automationConditions?: readonly PluginAutomationConditionDefinition[];
		readonly webhookEvents?: readonly PluginWebhookEventDefinition[];
		readonly importProviders?: readonly PluginImportProviderDefinition[];
	} & Partial<Record<DeferredPluginContributionKind, readonly unknown[]>>
>;
import type { PluginAgentStepDefinition } from './agentStep';
import type {
	PluginAutomationConditionDefinition,
	PluginAutomationStepDefinition,
	PluginAutomationTriggerDefinition,
} from './automation';
import type { PluginAutonomyGateDefinition } from './autonomyGate';
import type { PluginDraftStrategyDefinition } from './draftStrategy';
import type { PluginImportProviderDefinition } from './importProvider';
import type { PluginSendTransportDefinition } from './sendTransport';
import type { PluginWebhookEventDefinition } from './webhookEvent';
