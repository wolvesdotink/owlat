/**
 * The Escalation Guard manifest — the maintained TIER-1 reference.
 *
 * Tier 1 is the bundled, in-process tier: everything this plugin does runs
 * inside Owlat's own trust boundary, with no connected app, no outbound network
 * call and no sandboxed job. It is therefore the tier where the manifest itself
 * carries the entire security story:
 *
 *   - `capabilities` is the permission CEILING. The host checks it at codegen and
 *     again at runtime, and an operator grant can only narrow it. Every
 *     contribution below is paired with the capability it requires.
 *   - `flag.default: false` means an operator opts in. Until then the plugin
 *     contributes nothing at all — no agent step, no nav entry, no automation
 *     palette items.
 *   - `llmBudget` is a hard daily ceiling the host enforces on the attributed
 *     dispatch this plugin's draft strategy uses.
 *   - Every contribution is a DATA descriptor. The executable half lives at
 *     `module.exportPath` and is imported by the generated composition, never by
 *     evaluating anything from this file.
 *
 * The one agent step declares exactly one lifecycle edge, `drafting ->
 * draft_ready`, which is the restrict-only "hold this for a human" edge. There
 * is no declaration in this manifest that could approve, unblock or force a send.
 */

import {
	definePlugin,
	PLUGIN_AGENT_STEP_CAPABILITY,
	PLUGIN_AUTOMATION_CONDITION_CAPABILITY,
	PLUGIN_AUTOMATION_STEP_CAPABILITY,
	PLUGIN_AUTOMATION_TRIGGER_CAPABILITY,
	PLUGIN_DRAFT_STRATEGY_CAPABILITY,
	PLUGIN_NAV_ITEM_CAPABILITY,
	PLUGIN_SETTINGS_PANEL_CAPABILITY,
	PLUGIN_WEBHOOK_EVENT_CAPABILITY,
} from '@owlat/plugin-kit';
import { ESCALATION_STEP_LOCAL_ID } from './agentStep';
import { PRIORITY_ACCOUNT_CONDITION_LOCAL_ID } from './automationCondition';
import { ASSIGN_OWNER_STEP_LOCAL_ID } from './automationStep';
import { ESCALATION_TRIGGER_LOCAL_ID } from './automationTrigger';
import { ESCALATION_GUARD_PLUGIN_ID } from './constants';
import {
	CAREFUL_ACKNOWLEDGEMENT_LOCAL_ID,
	CAREFUL_ACKNOWLEDGEMENT_TIMEOUT_MS,
} from './draftStrategy';
import { ESCALATION_EVENT_LOCAL_ID } from './webhookEvent';

/** Hard daily LLM budget, in USD, the host enforces on this plugin's dispatch. */
export const ESCALATION_GUARD_DAILY_LLM_BUDGET_USD = 0.75;

export const escalationGuardPlugin = definePlugin({
	id: ESCALATION_GUARD_PLUGIN_ID,
	version: '0.1.0',
	capabilities: [
		PLUGIN_AGENT_STEP_CAPABILITY,
		PLUGIN_AUTOMATION_CONDITION_CAPABILITY,
		PLUGIN_AUTOMATION_STEP_CAPABILITY,
		PLUGIN_AUTOMATION_TRIGGER_CAPABILITY,
		PLUGIN_DRAFT_STRATEGY_CAPABILITY,
		PLUGIN_NAV_ITEM_CAPABILITY,
		PLUGIN_SETTINGS_PANEL_CAPABILITY,
		PLUGIN_WEBHOOK_EVENT_CAPABILITY,
		'llm:invoke',
	],
	flag: { default: false },
	llmBudget: { dailyUsd: ESCALATION_GUARD_DAILY_LLM_BUDGET_USD },
	contributes: {
		agentSteps: [
			{
				id: ESCALATION_STEP_LOCAL_ID,
				// `draft` resolves to the after_draft placement, the only placement
				// whose approved edge set contains draft_review.
				after: 'draft',
				module: { exportPath: './agentStep' },
				lifecycleEdges: [{ kind: 'draft_review', from: 'drafting', to: 'draft_ready' }],
			},
		],
		draftStrategies: [
			{
				id: CAREFUL_ACKNOWLEDGEMENT_LOCAL_ID,
				label: 'Careful acknowledgement',
				module: { exportPath: './draftStrategy' },
				timeoutMs: CAREFUL_ACKNOWLEDGEMENT_TIMEOUT_MS,
			},
		],
		automationTriggers: [
			{
				id: ESCALATION_TRIGGER_LOCAL_ID,
				label: 'Escalation raised',
				description: 'Starts when Escalation Guard flags an inbound message.',
				icon: 'siren',
				module: { exportPath: './automationTrigger' },
			},
		],
		automationConditions: [
			{
				id: PRIORITY_ACCOUNT_CONDITION_LOCAL_ID,
				label: 'Priority account',
				description: "Matches contacts whose email domain is on the operator's priority list.",
				icon: 'shield-check',
				module: { exportPath: './automationCondition' },
			},
		],
		automationSteps: [
			{
				id: ASSIGN_OWNER_STEP_LOCAL_ID,
				label: 'Require an escalation owner',
				description: 'Fails the run until the contact has a named escalation owner.',
				icon: 'user-check',
				module: { exportPath: './automationStep' },
			},
		],
		webhookEvents: [
			{
				id: ESCALATION_EVENT_LOCAL_ID,
				description: 'An inbound message was classified as an escalation.',
				subscribable: true,
			},
		],
		navItems: [
			{
				id: 'queue',
				// Must be a CORE sidebar section key; an unknown section is dropped
				// fail-closed by the host, so the entry would silently never render.
				section: 'inbox',
				name: 'Escalations',
				href: '/dashboard/settings/plugins/escalation-guard',
				icon: 'lucide:siren',
			},
		],
		settingsPanels: [
			{
				id: 'settings',
				name: 'Escalation Guard',
				href: '/dashboard/settings/plugins/escalation-guard',
				icon: 'lucide:siren',
			},
		],
	},
	// Declaration-only settings schema: it shows how a plugin describes the
	// operator-facing controls its settings panel renders, and the host validates,
	// persists and redacts these fields. It is deliberately NOT a channel into the
	// bundled modules: `PluginAgentStepModule` is `execute(input)` only, and an
	// automation module is handed the automation's own persisted
	// `step.config.pluginConfig` through its `parseConfig`, never plugin settings.
	// Configurable behaviour is composed at build time instead. Each description
	// below states that boundary rather than implying live wiring.
	settingsSchema: [
		{
			kind: 'select',
			key: 'minimumLevel',
			label: 'Hold drafts at',
			description:
				'Operator record of the severity at which an escalation draft should wait for a human. The bundled agent step uses its module default (escalate); a build that wants this configurable composes its own module with createEscalationAgentStep({ minimumLevel }).',
			options: [
				{ value: 'watch', label: 'Watch and above' },
				{ value: 'escalate', label: 'Escalate only' },
			],
			default: 'escalate',
		},
		{
			kind: 'string',
			key: 'ownerProperty',
			label: 'Escalation owner property',
			description:
				'Operator record of the contact property that should hold an escalation owner. The "Require an escalation owner" automation step takes this from its own step config, and a settings string field cannot express the parser\'s identifier rule, so parseConfig re-validates it.',
			default: 'escalationOwner',
			maxLength: 64,
		},
	],
});
