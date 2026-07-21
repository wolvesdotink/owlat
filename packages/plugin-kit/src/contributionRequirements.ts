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
 *
 * `dispatch` says whether the host actually INVOKES the bucket today:
 *
 *   - `'wired'`    — a production host path consumes the composed catalog or the
 *                    generated module registry and runs the contribution.
 *   - `'declared'` — the manifest type, validator, capability, codegen output
 *                    and runtime-authorization seam all exist and are tested,
 *                    but no host path calls them yet, so declaring the bucket is
 *                    inert at runtime.
 *
 * Both classes keep the capability + flag requirement: a `'declared'` bucket is
 * a finished contract awaiting a call site, not an unenforced free-for-all, and
 * relaxing its capability check would widen the manifest ceiling for the day it
 * is wired. The split exists so the documentation and the conformance gate can
 * state which is which instead of implying that everything with a row runs.
 */
export const CONTRIBUTION_CAPABILITY_REQUIREMENTS = [
	{
		bucket: 'sendTransports',
		capability: PLUGIN_SEND_TRANSPORT_CAPABILITY,
		noun: 'send transports',
		dispatch: 'wired',
	},
	{
		bucket: 'agentSteps',
		capability: PLUGIN_AGENT_STEP_CAPABILITY,
		noun: 'agent steps',
		dispatch: 'wired',
	},
	{
		bucket: 'draftStrategies',
		capability: PLUGIN_DRAFT_STRATEGY_CAPABILITY,
		noun: 'draft strategies',
		dispatch: 'wired',
	},
	{
		bucket: 'sendGates',
		capability: PLUGIN_AUTONOMY_GATE_CAPABILITY,
		noun: 'autonomy gates',
		dispatch: 'wired',
	},
	{
		bucket: 'automationTriggers',
		capability: PLUGIN_AUTOMATION_TRIGGER_CAPABILITY,
		noun: 'automation triggers',
		// `firePluginTrigger` resolves and fans out a plugin trigger, but nothing
		// in the host fires it, so a contributed trigger never runs.
		dispatch: 'declared',
	},
	{
		bucket: 'automationSteps',
		capability: PLUGIN_AUTOMATION_STEP_CAPABILITY,
		noun: 'automation steps',
		dispatch: 'wired',
	},
	{
		bucket: 'automationConditions',
		capability: PLUGIN_AUTOMATION_CONDITION_CAPABILITY,
		noun: 'automation conditions',
		// `parseCondition` throws for a `plugin.*` kind: no evaluator exists.
		dispatch: 'declared',
	},
	{
		bucket: 'webhookEvents',
		capability: PLUGIN_WEBHOOK_EVENT_CAPABILITY,
		noun: 'webhook events',
		// The persisted event validator is a closed core-only union and no publish
		// path calls `webhookEventAuthorization.authorizePublish`.
		dispatch: 'declared',
	},
	{
		bucket: 'importProviders',
		capability: PLUGIN_IMPORT_PROVIDER_CAPABILITY,
		noun: 'import providers',
		// The walker dispatches through a core-only `INTEGRATION_IMPORT_PROVIDERS`
		// map and `integrationImports.provider` is a two-literal union.
		dispatch: 'declared',
	},
	{
		bucket: 'crons',
		capability: PLUGIN_CRON_CAPABILITY,
		noun: 'crons',
		dispatch: 'wired',
	},
	{
		bucket: 'navItems',
		capability: PLUGIN_NAV_ITEM_CAPABILITY,
		noun: 'navigation items',
		dispatch: 'wired',
	},
	{
		bucket: 'settingsPanels',
		capability: PLUGIN_SETTINGS_PANEL_CAPABILITY,
		noun: 'settings panels',
		dispatch: 'wired',
	},
] as const;

export type ContributionBucket = (typeof CONTRIBUTION_CAPABILITY_REQUIREMENTS)[number]['bucket'];

/** Whether the host invokes a bucket today, or only accepts and catalogues it. */
export type ContributionDispatch =
	(typeof CONTRIBUTION_CAPABILITY_REQUIREMENTS)[number]['dispatch'];

function bucketsWithDispatch(dispatch: ContributionDispatch): readonly PluginContributionKind[] {
	return Object.freeze(
		CONTRIBUTION_CAPABILITY_REQUIREMENTS.filter(
			(requirement) => requirement.dispatch === dispatch
		).map((requirement): ContributionBucket => requirement.bucket)
	);
}

/**
 * Buckets a production host path actually runs — the set a reader may treat as
 * an extension point that does something today.
 */
export const PLUGIN_DISPATCHED_CONTRIBUTION_KINDS: readonly PluginContributionKind[] =
	bucketsWithDispatch('wired');

/**
 * Buckets whose contract, capability, codegen output and authorization seam are
 * all in place but which no host path invokes yet. Declaring one is inert at
 * runtime. The conformance reachability gate asserts this is EXACTLY the set
 * with no production consumer, so wiring one up fails until its row moves to
 * `'wired'`.
 */
export const PLUGIN_UNDISPATCHED_CONTRIBUTION_KINDS: readonly PluginContributionKind[] =
	bucketsWithDispatch('declared');

/**
 * The contribution buckets whose capability the manifest validator ENFORCES,
 * derived from the requirement table above rather than written out a second
 * time. The remaining `PLUGIN_CONTRIBUTION_KINDS` are manifest-only
 * reservations: no capability, no codegen, no seam.
 *
 * This says the contract is finished, not that the host calls it — see
 * `PLUGIN_DISPATCHED_CONTRIBUTION_KINDS` for the buckets that actually run.
 */
export const PLUGIN_LIVE_CONTRIBUTION_KINDS: readonly PluginContributionKind[] = Object.freeze(
	CONTRIBUTION_CAPABILITY_REQUIREMENTS.map((requirement): ContributionBucket => requirement.bucket)
);
