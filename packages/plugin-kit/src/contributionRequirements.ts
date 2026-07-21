import { PLUGIN_AGENT_STEP_CAPABILITY } from './agentStep';
import {
	PLUGIN_AUTOMATION_CONDITION_CAPABILITY,
	PLUGIN_AUTOMATION_STEP_CAPABILITY,
	PLUGIN_AUTOMATION_TRIGGER_CAPABILITY,
} from './automation';
import { PLUGIN_AUTONOMY_GATE_CAPABILITY } from './autonomyGate';
import type { PluginContributionKind } from './contributions';
import { PLUGIN_CRON_CAPABILITY } from './cron';
import { PLUGIN_DRAFT_STRATEGY_CAPABILITY } from './draftStrategy';
import { PLUGIN_IMPORT_PROVIDER_CAPABILITY } from './importProvider';
import { PLUGIN_NAV_ITEM_CAPABILITY } from './navItem';
import { PLUGIN_SEND_TRANSPORT_CAPABILITY } from './sendTransport';
import { PLUGIN_SETTINGS_PANEL_CAPABILITY } from './settingsPanel';
import { PLUGIN_WEBHOOK_EVENT_CAPABILITY } from './webhookEvent';

/**
 * Every contribution bucket that requires a matching capability and a feature
 * flag, as one data table so the checks stay identical across registries. Adding
 * a hosted registry means adding a row here, not another copy of the two checks.
 */
export const CONTRIBUTION_CAPABILITY_REQUIREMENTS = [
	{
		bucket: 'sendTransports',
		capability: PLUGIN_SEND_TRANSPORT_CAPABILITY,
		noun: 'send transports',
	},
	{ bucket: 'agentSteps', capability: PLUGIN_AGENT_STEP_CAPABILITY, noun: 'agent steps' },
	{
		bucket: 'draftStrategies',
		capability: PLUGIN_DRAFT_STRATEGY_CAPABILITY,
		noun: 'draft strategies',
	},
	{ bucket: 'sendGates', capability: PLUGIN_AUTONOMY_GATE_CAPABILITY, noun: 'autonomy gates' },
	{
		bucket: 'automationTriggers',
		capability: PLUGIN_AUTOMATION_TRIGGER_CAPABILITY,
		noun: 'automation triggers',
	},
	{
		bucket: 'automationSteps',
		capability: PLUGIN_AUTOMATION_STEP_CAPABILITY,
		noun: 'automation steps',
	},
	{
		bucket: 'automationConditions',
		capability: PLUGIN_AUTOMATION_CONDITION_CAPABILITY,
		noun: 'automation conditions',
	},
	{
		bucket: 'webhookEvents',
		capability: PLUGIN_WEBHOOK_EVENT_CAPABILITY,
		noun: 'webhook events',
	},
	{
		bucket: 'importProviders',
		capability: PLUGIN_IMPORT_PROVIDER_CAPABILITY,
		noun: 'import providers',
	},
	{ bucket: 'crons', capability: PLUGIN_CRON_CAPABILITY, noun: 'crons' },
	{ bucket: 'navItems', capability: PLUGIN_NAV_ITEM_CAPABILITY, noun: 'navigation items' },
	{
		bucket: 'settingsPanels',
		capability: PLUGIN_SETTINGS_PANEL_CAPABILITY,
		noun: 'settings panels',
	},
] as const;

export type ContributionBucket = (typeof CONTRIBUTION_CAPABILITY_REQUIREMENTS)[number]['bucket'];

/**
 * The contribution buckets that have a live host runtime, derived from the
 * requirement table above rather than written out a second time. A bucket earns
 * a row there once a registry actually consumes it, so this is the set a
 * conformance gate has to reason about; the remaining
 * `PLUGIN_CONTRIBUTION_KINDS` are manifest-only reservations whose framework
 * interface is still deferred.
 */
export const PLUGIN_LIVE_CONTRIBUTION_KINDS: readonly PluginContributionKind[] = Object.freeze(
	CONTRIBUTION_CAPABILITY_REQUIREMENTS.map((requirement): ContributionBucket => requirement.bucket)
);
