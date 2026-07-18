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
 *     bucket — only the capability and the required env var);
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

/** Env var the operator sets to point the plugin at a seedbox vendor endpoint. */
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
		requiredEnvVars: [DELIVERABILITY_LAB_SEEDBOX_URL_ENV],
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
				section: 'insights',
				name: 'Deliverability',
				href: '/dashboard/plugins/deliverability-lab',
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
	settingsSchema: [
		{
			kind: 'boolean',
			key: 'holdOnFail',
			label: 'Hold sends that fail preflight',
			description: 'When on, a failing deliverability report objects to the autonomous send.',
			default: true,
		},
		{
			kind: 'secret',
			key: 'seedboxApiKey',
			label: 'Seedbox API key',
			description: 'Authenticates the optional Tier-2 seedbox score hook. Stored server-side.',
			required: false,
		},
		{
			kind: 'number',
			key: 'seedboxDeadlineMs',
			label: 'Seedbox timeout (ms)',
			description: 'How long to wait for the seedbox score before falling back to local scoring.',
			default: 5000,
			min: 500,
			max: 15000,
		},
	],
});
