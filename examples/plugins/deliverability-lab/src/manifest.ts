/**
 * The Deliverability Lab manifest — one `definePlugin` declaration that names
 * every capability the plugin can ever exercise and every contribution it makes.
 * The host computes permissions, the settings UI, and the generated composition
 * from this data WITHOUT executing plugin code; each contribution is a data-only
 * descriptor whose executable half lives at `module.exportPath`.
 *
 * The three tiers this reference exercises show up here as:
 *   - Tier 1 (bundled, in-process): the `sendGates` restrict-only gate plus the
 *     `navItems` / `settingsPanels` UI and the budgeted `crons` job;
 *   - Tier 2 (connected hook): the `llm:invoke` + seedbox usage the gate layers
 *     on (the vendor score hook is host-mediated, so it needs no contribution
 *     bucket — only the capability; the seedbox endpoint env var is declared as a
 *     forward-looking constant but is NOT a required-env enablement gate, because
 *     the bundled gate ships with no remote hook — see the constant below);
 *   - Tier 3 (sandboxed worker): the `worker:enqueue` capability the seed-list
 *     job is enqueued under (`plugin.deliverability-lab.seed-test`).
 *
 * Capability declaration is the permission ceiling: the host rejects, at codegen
 * AND at runtime, any contribution or action that needs a capability not listed
 * here, and an operator grant can only ever narrow this set.
 */

import {
	definePlugin,
	PLUGIN_AUTONOMY_GATE_CAPABILITY,
	PLUGIN_AUTONOMY_GATE_TIMEOUT_MAX_MS,
	PLUGIN_CRON_CAPABILITY,
	PLUGIN_NAV_ITEM_CAPABILITY,
	PLUGIN_SETTINGS_PANEL_CAPABILITY,
	PLUGIN_WORKER_CAPABILITY,
} from '@owlat/plugin-kit';
import { DELIVERABILITY_LAB_PLUGIN_ID } from './constants';

/**
 * Env var an operator sets to point the plugin at a seedbox vendor endpoint.
 * Exported as the declaration of that contract, but deliberately NOT listed in
 * `flag.requiredEnvVars`: the host treats a missing required env var as an
 * enablement blocker, and the module the manifest points at is
 * `createDeliverabilityGate()` with NO remote hook, so requiring the var would
 * force operators to provision an endpoint nothing reads.
 *
 * Composing the Tier-2 hook is a build-time decision, not a runtime one. The
 * host hands a bundled gate only `{ signal }` — no settings, no connected-app
 * client, no credential — so a deployment that wants the vendor opinion builds
 * its own gate module with `createDeliverabilityGate({ remoteScoreHook })` and
 * points the manifest at that export. Delivering operator settings or a
 * connected-app client into the bundled gate/cron tiers would be a host contract
 * change (`PluginAutonomyGateServices` / `PluginCronServices`) and is a
 * deliberate non-goal of this program: it would push operator secrets into
 * in-process plugin code, which is exactly what Tier 2 exists to avoid.
 */
export const DELIVERABILITY_LAB_SEEDBOX_URL_ENV = 'DELIVERABILITY_LAB_SEEDBOX_URL';

/** Hard daily LLM budget, in USD, attributed to this plugin by the host dispatch. */
export const DELIVERABILITY_LAB_DAILY_LLM_BUDGET_USD = 1.5;

export const deliverabilityLabPlugin = definePlugin({
	id: DELIVERABILITY_LAB_PLUGIN_ID,
	version: '0.1.0',
	capabilities: [
		PLUGIN_AUTONOMY_GATE_CAPABILITY,
		PLUGIN_CRON_CAPABILITY,
		PLUGIN_NAV_ITEM_CAPABILITY,
		PLUGIN_SETTINGS_PANEL_CAPABILITY,
		PLUGIN_WORKER_CAPABILITY,
		'llm:invoke',
	],
	flag: {
		default: false,
	},
	llmBudget: { dailyUsd: DELIVERABILITY_LAB_DAILY_LLM_BUDGET_USD },
	contributes: {
		sendGates: [
			{
				id: 'seed-list-preflight',
				label: 'Deliverability preflight',
				module: { exportPath: './gate' },
				// Well under the gate ceiling so the host's own fail-closed timeout is
				// the outer bound; the gate's own seedbox deadline is smaller still.
				timeoutMs: Math.min(15_000, PLUGIN_AUTONOMY_GATE_TIMEOUT_MAX_MS),
			},
		],
		crons: [
			{
				id: 'refresh-seed-scores',
				label: 'Refresh deliverability tips',
				module: { exportPath: './cron' },
				schedule: { intervalMinutes: 360 },
				timeoutMs: 60_000,
			},
		],
		navItems: [
			{
				id: 'dashboard',
				// MUST be a CORE sidebar section key (CORE_SECTIONS in
				// apps/web/app/lib/dashboardNavigation.ts). An item targeting an
				// unknown section is dropped fail-closed, so it would never render.
				section: 'delivery',
				name: 'Deliverability',
				href: '/dashboard/settings/plugins/deliverability-lab',
				icon: 'lucide:radar',
			},
		],
		settingsPanels: [
			{
				id: 'settings',
				name: 'Deliverability Lab',
				href: '/dashboard/settings/plugins/deliverability-lab',
				icon: 'lucide:radar',
			},
		],
	},
	// Declaration-only settings schema: it shows how a plugin describes the
	// operator-facing controls its settings panel renders, and the host validates,
	// persists and redacts these fields. It is deliberately NOT consumed by the
	// bundled gate or cron: those `services` contracts expose only `{ signal }`
	// (plus logger/llm for a cron), and threading persisted settings — including a
	// SECRET — into in-process plugin modules is a documented non-goal of the
	// platform. A deployment that needs configurable behaviour composes it at
	// build time (`createDeliverabilityGate({ ... })`) or moves the work to a
	// Tier-2 connected app, which is where operator secrets are meant to live.
	// Each description below states that boundary rather than implying live wiring.
	settingsSchema: [
		{
			kind: 'boolean',
			key: 'holdOnFail',
			label: 'Hold sends that fail preflight',
			description:
				'Operator record of whether a failing preflight should hold the send. The bundled gate always objects on a fail verdict; a build that wants this configurable composes its own gate module.',
			default: true,
		},
		{
			kind: 'secret',
			key: 'seedboxApiKey',
			envVar: 'PLUGIN_SEEDBOX_API_KEY',
			label: 'Seedbox API key',
			description:
				'Credential for a Tier-2 seedbox score hook. Owlat persists no value and never hands it to in-process plugin code: the operator sets the environment variable and the settings screen reports only whether it is present.',
			required: false,
		},
		{
			kind: 'number',
			key: 'seedboxDeadlineMs',
			label: 'Seedbox timeout (ms)',
			description:
				'Operator record of the deadline, in ms, to wait for a seedbox score before falling back to local scoring. The bundled gate uses its own default deadline.',
			default: 5000,
			min: 500,
			max: 15000,
		},
	],
});
