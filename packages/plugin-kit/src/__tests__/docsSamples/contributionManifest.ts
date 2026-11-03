// #region contribution-manifest
import {
	definePlugin,
	PLUGIN_AUTONOMY_GATE_CAPABILITY,
	PLUGIN_CRON_CAPABILITY,
	PLUGIN_NAV_ITEM_CAPABILITY,
	PLUGIN_SETTINGS_PANEL_CAPABILITY,
	PLUGIN_WORKER_CAPABILITY,
} from '@owlat/plugin-kit';

export const preflightPlugin = definePlugin({
	id: 'preflight',
	version: '1.0.0',
	capabilities: [
		PLUGIN_AUTONOMY_GATE_CAPABILITY,
		PLUGIN_CRON_CAPABILITY,
		PLUGIN_NAV_ITEM_CAPABILITY,
		PLUGIN_SETTINGS_PANEL_CAPABILITY,
		PLUGIN_WORKER_CAPABILITY,
		'llm:invoke',
	],
	// Contributions REQUIRE an explicit flag: an operator must be able to turn
	// the plugin off without a redeploy.
	flag: { default: false, requiredEnvVars: ['PREFLIGHT_API_KEY'] },
	// `llm:invoke` additionally requires a hard daily budget in USD.
	llmBudget: { dailyUsd: 1.5 },
	contributes: {
		sendGates: [
			{
				id: 'preflight',
				label: 'Pre-send preflight',
				module: { exportPath: './gate' },
				timeoutMs: 15_000,
			},
		],
		crons: [
			{
				id: 'refresh-rules',
				label: 'Refresh preflight rules',
				module: { exportPath: './cron' },
				schedule: { intervalMinutes: 360 },
				timeoutMs: 60_000,
			},
		],
		navItems: [
			{
				id: 'dashboard',
				section: 'administration',
				name: 'Preflight',
				href: '/dashboard/admin/instance/plugins/preflight',
				icon: 'coolicons:radar',
			},
		],
		settingsPanels: [
			{
				id: 'settings',
				name: 'Preflight',
				href: '/dashboard/admin/instance/plugins/preflight',
				icon: 'coolicons:radar',
			},
		],
	},
	settingsSchema: [
		{
			kind: 'boolean',
			key: 'holdOnFail',
			label: 'Hold sends that fail preflight',
			default: true,
		},
		{
			kind: 'secret',
			key: 'vendorApiKey',
			envVar: 'PLUGIN_VENDOR_API_KEY',
			label: 'Vendor API key',
			required: false,
		},
	],
});
// #endregion contribution-manifest
