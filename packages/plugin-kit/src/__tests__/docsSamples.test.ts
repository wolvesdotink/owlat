/**
 * Assertions for the contribution samples in the docs-site plugin chapter
 * (`apps/docs/content/en/3.developer/4*.md`).
 *
 * Documentation drifts silently: a sample that is only prose rots the moment a
 * contract changes. Each sample lives in its own module under `docsSamples/`,
 * inside a `#region <name>` marker, is compiled by this package's
 * `tsc --noEmit`, and is exercised below against the REAL exported contracts.
 * `apps/docs/__tests__/pageInvariants.test.ts` then asserts that every region
 * there appears verbatim as a fenced block in the chapter and that no fence
 * there is anything else, so a doc sample cannot claim an API that this package
 * does not compile and run.
 *
 * One sample per module, because each fence is a file a plugin author copies
 * whole: its imports are complete, and two samples never share a scope. The
 * regions are written against the public `@owlat/plugin-kit` specifier — what a
 * plugin author actually writes — which is what this package's vitest alias and
 * tsconfig self-path exist to allow; nothing is rewritten on the way out.
 *
 * Adding a sample: put it in a new module under `docsSamples/`, wrap it in a
 * region and quote it verbatim from a doc page. The doc check reads every
 * module in that directory.
 */

import { describe, expect, it } from 'vitest';
import { PluginManifestError } from '../manifest';
import { PLUGIN_SEND_FAILURE_CODES } from '../sendTransport';
import {
	definePlugin,
	PLUGIN_CRON_CAPABILITY,
	type PluginAutonomyGateInput,
	type PluginAutonomyGateServices,
} from '@owlat/plugin-kit';
import { helloPlugin } from './docsSamples/minimalManifest';
import { preflightPlugin } from './docsSamples/contributionManifest';
import { gate } from './docsSamples/gateModule';
import { cron } from './docsSamples/cronModule';
import { transport } from './docsSamples/sendTransportModule';
import { webhook } from './docsSamples/sendTransportWebhookModule';
import { domainIdentity } from './docsSamples/sendTransportDomainIdentityModule';
import { agentStep } from './docsSamples/agentStepModule';
import { automationStep } from './docsSamples/automationStepModule';
import { importProvider } from './docsSamples/importProviderModule';
import { acmeRelayPlugin } from './docsSamples/sendProviderManifest';

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

	/**
	 * The send-provider bundle's two DERIVED capability words, and the two halves
	 * that derive them. The guide's whole framing rests on this: an author deletes
	 * a half they do not need and loses the promise with it, rather than leaving a
	 * boolean behind that says a parser exists when none does.
	 */
	it('derives the bundle capability words from the halves that implement them', () => {
		const transport = acmeRelayPlugin.contributes.sendTransports[0];
		expect(transport.webhook.module.exportPath).toBe('./convex/webhook');
		expect(transport.domainIdentity.module.exportPath).toBe('./convex/domainIdentity');
		expect(transport.supportsCustomReturnPath).toBe('no');
		// The declared form writes only variables the transport reads.
		const declared = new Set<string>([...transport.requiredEnvVars, ...transport.optionalEnvVars]);
		for (const field of transport.credentialFields) expect(declared.has(field.envVar)).toBe(true);
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
			// The sample declares no configuration variables of its own, so the host
			// resolves the empty record for it — the shape every default instance of
			// a transport that keeps its endpoint in extras receives.
			const attempt = await transport.send(
				{ to: 'b@x', from: 'a@x', subject: 's', html: '<p></p>' },
				{ endpoint: 'https://relay.example' },
				{ instanceKey: null, env: {} }
			);
			expect(attempt.success).toBe(false);
			if (!attempt.success) expect(PLUGIN_SEND_FAILURE_CODES).toContain(attempt.code);
		} finally {
			globalThis.fetch = original;
		}
	});

	it('the domain identity reports observations, and never a status', async () => {
		const original = globalThis.fetch;
		const answer = (status: number, body: unknown): typeof fetch =>
			(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
		const config = { instanceKey: null, env: { PLUGIN_ACME_TOKEN: 'token' } };
		try {
			globalThis.fetch = answer(403, {});
			await expect(domainIdentity.checkDomain('example.com', config)).resolves.toEqual({
				outcome: 'auth_failed',
				error: 'the provider rejected the token',
			});

			globalThis.fetch = answer(503, {});
			await expect(domainIdentity.checkDomain('example.com', config)).resolves.toMatchObject({
				outcome: 'unavailable',
			});

			globalThis.fetch = answer(200, { owned: true, spf: true, dkim: true, selector: 'acme' });
			const observed = await domainIdentity.registerDomain('example.com', config);
			// No `status` anywhere in what a module may return: the host derives it, so
			// "verified" means the same thing at every relay tier.
			expect(observed).toEqual({
				outcome: 'ok',
				state: {
					isOwnershipVerified: true,
					spf: { isValid: true },
					dkim: { isValid: true },
					dkimSelectors: ['acme'],
					spfMechanisms: ['include:spf.example.net'],
				},
			});
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
