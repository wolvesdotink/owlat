/**
 * Executable source for the contribution samples in the docs-site plugin
 * chapter (`apps/docs/content/3.developer/4*.md`).
 *
 * Documentation drifts silently: a sample that is only prose rots the moment a
 * contract changes. Each sample below lives inside a `#region <name>` marker,
 * is compiled by this package's `tsc --noEmit`, and is exercised by the
 * assertions at the bottom of this file against the REAL exported contracts.
 * `apps/docs/__tests__/pluginDocs.test.ts` then asserts that the corresponding
 * fenced block in each doc page is byte-identical to the region here (with the
 * relative import specifier rewritten to the public `@owlat/plugin-kit` one), so
 * a doc sample cannot claim an API that this file does not compile and run.
 *
 * Adding a sample: wrap it in a new region, quote it from a doc page, and add
 * the pair to the doc test's region map.
 */

import { describe, expect, it } from 'vitest';
import { PluginManifestError } from '../manifest';
import { PLUGIN_SEND_FAILURE_CODES } from '../sendTransport';

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
				section: 'insights',
				name: 'Preflight',
				href: '/dashboard/plugins/preflight',
				icon: 'lucide:radar',
			},
		],
		settingsPanels: [
			{
				id: 'settings',
				name: 'Preflight',
				href: '/dashboard/settings/plugins/preflight',
				icon: 'lucide:radar',
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
		{ kind: 'secret', key: 'vendorApiKey', label: 'Vendor API key', required: false },
	],
});
// #endregion contribution-manifest

// #region minimal-manifest
export const helloPlugin = definePlugin({
	id: 'hello-owlat',
	version: '0.1.0',
	capabilities: ['plugin-storage:read', 'plugin-storage:write'],
	// Storage capabilities REQUIRE a flag: access must be revocable at runtime.
	flag: { default: false },
});
// #endregion minimal-manifest

// #region gate-module
import type {
	PluginAutonomyGateInput,
	PluginAutonomyGateModule,
	PluginAutonomyGateResult,
	PluginAutonomyGateServices,
} from '@owlat/plugin-kit';

/** A gate may object or stand aside. There is deliberately no "approve" result. */
export const gate: PluginAutonomyGateModule = {
	async evaluate(
		input: PluginAutonomyGateInput,
		services: PluginAutonomyGateServices
	): Promise<PluginAutonomyGateResult> {
		if (services.signal.aborted) return { outcome: 'objection', reason: 'preflight cancelled' };
		if (input.draftBody.includes('http://')) {
			return { outcome: 'objection', reason: 'draft contains a plaintext HTTP link' };
		}
		return { outcome: 'no-objection' };
	},
};
// #endregion gate-module

// #region cron-module
import type { PluginCronModule, PluginCronServices } from '@owlat/plugin-kit';

export const cron: PluginCronModule = {
	async run(services: PluginCronServices): Promise<void> {
		// Cancellation is cooperative: the host aborts `signal` at the declared
		// timeout and stops waiting either way.
		if (services.signal.aborted) return;
		const summary = await services.llm.generate({
			tier: 'fast',
			prompt: 'Summarise this week of deliverability tips in one sentence.',
		});
		services.logger.info('refreshed preflight rules', { length: summary.text.length });
	},
};
// #endregion cron-module

// #region send-transport-module
import type {
	PluginSendAttempt,
	PluginSendTransportModule,
	PluginSendTransportParams,
} from '@owlat/plugin-kit';

interface RelayExtras {
	readonly endpoint: string;
}

/** One attempt only. Owlat owns retries, health, routing, and audit. */
export const transport: PluginSendTransportModule<RelayExtras> = {
	parseExtras(input: unknown): RelayExtras {
		if (typeof input !== 'object' || input === null) {
			throw new TypeError('extras must be an object');
		}
		const endpoint = (input as { endpoint?: unknown }).endpoint;
		if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) {
			throw new TypeError('extras.endpoint must be an https URL');
		}
		return { endpoint };
	},

	async send(params: PluginSendTransportParams, extras: RelayExtras): Promise<PluginSendAttempt> {
		const response = await fetch(extras.endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ to: params.to, from: params.from, subject: params.subject }),
		});
		if (response.status === 429) return { success: false, code: 'rate_limited' };
		if (!response.ok) return { success: false, code: 'temporary_failure' };
		return { success: true, id: response.headers.get('x-message-id') ?? '' };
	},
};
// #endregion send-transport-module

// #region agent-step-module
import type {
	PluginAgentStepInput,
	PluginAgentStepModule,
	PluginAgentStepResult,
} from '@owlat/plugin-kit';

export const agentStep: PluginAgentStepModule = {
	async execute(input: PluginAgentStepInput): Promise<PluginAgentStepResult> {
		if (input.subject.toLowerCase().startsWith('[auto-reply]')) {
			// Restrict-only: a step may request a DECLARED caution edge, but never
			// choose the next step, approve, or send.
			return { kind: 'caution', to: 'archived', reason: 'vendor auto-reply' };
		}
		return { kind: 'continue' };
	},
};
// #endregion agent-step-module

// #region automation-step-module
import type {
	PluginAutomationStepInput,
	PluginAutomationStepModule,
	PluginAutomationStepResult,
} from '@owlat/plugin-kit';

interface NotifyConfig {
	readonly channel: string;
}

export const automationStep: PluginAutomationStepModule<NotifyConfig> = {
	parseConfig(raw: unknown): NotifyConfig {
		const channel = (raw as { channel?: unknown } | null)?.channel;
		if (typeof channel !== 'string' || channel.length === 0) {
			throw new TypeError('config.channel is required');
		}
		return { channel };
	},

	async execute(
		input: PluginAutomationStepInput,
		config: NotifyConfig
	): Promise<PluginAutomationStepResult> {
		if (!input.contactEmail.includes('@')) {
			return { kind: 'failed', reason: 'contact has no address' };
		}
		await Promise.resolve(config.channel);
		return { kind: 'completed' };
	},
};
// #endregion automation-step-module

// #region import-provider-module
import type {
	JsonObject,
	PluginImportPageResult,
	PluginImportProviderInput,
	PluginImportProviderModule,
} from '@owlat/plugin-kit';

export const importProvider: PluginImportProviderModule = {
	validateConfig(config: JsonObject) {
		return typeof config['listId'] === 'string'
			? ({ ok: true } as const)
			: ({ ok: false, reason: 'listId is required' } as const);
	},

	async fetchPage(input: PluginImportProviderInput): Promise<PluginImportPageResult> {
		// `cursor` is `''` on the first page; return `null` to end the walk.
		const page = input.cursor === '' ? 1 : Number(input.cursor);
		return {
			rows: [{ email: `contact-${page}@example.com`, fields: { source: 'vendor' } }],
			nextCursor: page >= 2 ? null : String(page + 1),
		};
	},
};
// #endregion import-provider-module

describe('docs samples: the manifests validate through the shipped validator', () => {
	it('accepts the minimal manifest', () => {
		expect(helloPlugin.id).toBe('hello-owlat');
		expect(helloPlugin.capabilities).toEqual(['plugin-storage:read', 'plugin-storage:write']);
	});

	it('rejects the minimal manifest once its required flag is removed', () => {
		expect(() =>
			definePlugin({
				id: 'hello-owlat',
				version: '0.1.0',
				capabilities: ['plugin-storage:read', 'plugin-storage:write'],
			})
		).toThrow(PluginManifestError);
	});

	it('keeps every declared bucket, flag, and budget', () => {
		expect(preflightPlugin.contributes?.sendGates).toHaveLength(1);
		expect(preflightPlugin.contributes?.crons?.[0]?.schedule.intervalMinutes).toBe(360);
		expect(preflightPlugin.llmBudget?.dailyUsd).toBe(1.5);
		expect(preflightPlugin.flag?.default).toBe(false);
	});

	it('rejects the same contributions when the gate capability is not declared', () => {
		expect(() =>
			definePlugin({
				id: 'preflight',
				version: '1.0.0',
				capabilities: [PLUGIN_CRON_CAPABILITY],
				flag: { default: false },
				contributes: {
					sendGates: [
						{
							id: 'preflight',
							label: 'Pre-send preflight',
							module: { exportPath: './gate' },
							timeoutMs: 15_000,
						},
					],
				},
			})
		).toThrow(PluginManifestError);
	});

	it('rejects contributions declared without a feature flag', () => {
		expect(() =>
			definePlugin({
				id: 'preflight',
				version: '1.0.0',
				capabilities: [PLUGIN_CRON_CAPABILITY],
				contributes: {
					crons: [
						{
							id: 'refresh-rules',
							label: 'Refresh preflight rules',
							module: { exportPath: './cron' },
							schedule: { intervalMinutes: 360 },
							timeoutMs: 60_000,
						},
					],
				},
			})
		).toThrow(PluginManifestError);
	});
});

describe('docs samples: modules behave as the chapter describes', () => {
	it('the gate objects on an insecure link and never approves', async () => {
		const input: PluginAutonomyGateInput = {
			from: 'a@example.com',
			to: 'b@example.com',
			subject: 'hi',
			draftBody: 'see http://example.com',
		};
		const services: PluginAutonomyGateServices = { signal: new AbortController().signal };
		await expect(gate.evaluate(input, services)).resolves.toEqual({
			outcome: 'objection',
			reason: 'draft contains a plaintext HTTP link',
		});
		await expect(
			gate.evaluate({ ...input, draftBody: 'see https://x' }, services)
		).resolves.toEqual({ outcome: 'no-objection' });
	});

	it('the gate returns immediately once the host aborts', async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			gate.evaluate(
				{ from: 'a@x', to: 'b@x', subject: 's', draftBody: 'https://ok' },
				{ signal: controller.signal }
			)
		).resolves.toEqual({ outcome: 'objection', reason: 'preflight cancelled' });
	});

	it('the cron uses the host LLM service and logs a bounded field', async () => {
		const logged: Array<{ message: string; fields?: unknown }> = [];
		await cron.run({
			signal: new AbortController().signal,
			llm: { generate: async () => ({ text: 'warm up your new IPs' }) },
			logger: {
				debug: () => {},
				info: (message, fields) => logged.push({ message, fields }),
				warn: () => {},
				error: () => {},
			},
		});
		expect(logged).toEqual([
			{ message: 'refreshed preflight rules', fields: { length: 'warm up your new IPs'.length } },
		]);
	});

	it('the cron does no work once the host has already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		let generated = 0;
		await cron.run({
			signal: controller.signal,
			llm: {
				generate: async () => {
					generated += 1;
					return { text: '' };
				},
			},
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		});
		expect(generated).toBe(0);
	});

	it('the transport rejects malformed extras at its only unknown-input boundary', () => {
		expect(() => transport.parseExtras({ endpoint: 'http://insecure' })).toThrow(TypeError);
		expect(() => transport.parseExtras(null)).toThrow(TypeError);
		expect(transport.parseExtras({ endpoint: 'https://relay.example' })).toEqual({
			endpoint: 'https://relay.example',
		});
	});

	it('the transport maps outcomes onto the shipped failure-code vocabulary', async () => {
		const original = globalThis.fetch;
		try {
			globalThis.fetch = (async () =>
				new Response(null, { status: 429 })) as unknown as typeof fetch;
			const attempt = await transport.send(
				{ to: 'b@x', from: 'a@x', subject: 's', html: '<p></p>' },
				{ endpoint: 'https://relay.example' }
			);
			expect(attempt.success).toBe(false);
			if (!attempt.success) expect(PLUGIN_SEND_FAILURE_CODES).toContain(attempt.code);
		} finally {
			globalThis.fetch = original;
		}
	});

	it('the agent step only ever continues or requests a declared caution edge', async () => {
		await expect(
			agentStep.execute({
				inboundMessageId: 'm1',
				from: 'a@x',
				to: 'b@x',
				subject: '[auto-reply] out of office',
			})
		).resolves.toEqual({ kind: 'caution', to: 'archived', reason: 'vendor auto-reply' });
		await expect(
			agentStep.execute({ inboundMessageId: 'm2', from: 'a@x', to: 'b@x', subject: 'question' })
		).resolves.toEqual({ kind: 'continue' });
	});

	it('the automation step parses its config and can only complete or fail', async () => {
		expect(() => automationStep.parseConfig({})).toThrow(TypeError);
		const config = automationStep.parseConfig({ channel: 'ops' });
		await expect(
			automationStep.execute({ contactEmail: 'a@x', contactProperties: {} }, config)
		).resolves.toEqual({ kind: 'completed' });
		await expect(
			automationStep.execute({ contactEmail: 'nope', contactProperties: {} }, config)
		).resolves.toEqual({ kind: 'failed', reason: 'contact has no address' });
	});

	it('the import provider walks pages and terminates with a null cursor', async () => {
		expect(importProvider.validateConfig({})).toEqual({ ok: false, reason: 'listId is required' });
		expect(importProvider.validateConfig({ listId: 'l1' })).toEqual({ ok: true });
		const first = await importProvider.fetchPage({ config: { listId: 'l1' }, cursor: '' });
		expect(first.nextCursor).toBe('2');
		const last = await importProvider.fetchPage({ config: { listId: 'l1' }, cursor: '2' });
		expect(last.nextCursor).toBeNull();
	});
});
