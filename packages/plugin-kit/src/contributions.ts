/**
 * Every contribution bucket a manifest may name.
 *
 * Membership is the ceiling, not a promise: `contributionRequirements.ts` says
 * which of these the host actually enforces a capability for and which of those
 * it invokes. The rest are reservations — the validator accepts them as opaque
 * arrays and nothing reads them.
 *
 * A RESERVATION MUST NAME SOMETHING REAL. Per D10 of the seams program, a bucket
 * held open for a host seam that does not exist is documentation debt that reads
 * as a roadmap. `channelAdapters` was withdrawn on those grounds: the surface it
 * pointed at (a bidirectional send/parse/verify channel interface in
 * `@owlat/channels`) is gone, and the two seams that replaced it — the send
 * provider catalog and the inbound webhook adapter registry — already have their
 * own buckets. Add the name back the day a channel seam does exist.
 */
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
	| 'crons'
	| 'navItems'
	| 'settingsPanels'
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
		readonly crons?: readonly PluginCronDefinition[];
		readonly navItems?: readonly PluginNavItemDefinition[];
		readonly settingsPanels?: readonly PluginSettingsPanelDefinition[];
	} & Partial<Record<DeferredPluginContributionKind, readonly unknown[]>>
>;
import type { PluginAgentStepDefinition } from './agentStep';
import type {
	PluginAutomationConditionDefinition,
	PluginAutomationStepDefinition,
	PluginAutomationTriggerDefinition,
} from './automation';
import type { PluginAutonomyGateDefinition } from './autonomyGate';
import type { PluginCronDefinition } from './cron';
import type { PluginDraftStrategyDefinition } from './draftStrategy';
import type { PluginImportProviderDefinition } from './importProvider';
import type { PluginNavItemDefinition } from './navItem';
import type { PluginSendTransportDefinition } from './sendTransport';
import type { PluginSettingsPanelDefinition } from './settingsPanel';
import type { PluginWebhookEventDefinition } from './webhookEvent';
