import { describe, expectTypeOf, it } from 'vitest';
import {
	definePlugin,
	type JsonValue,
	type PluginCapability,
	type PluginContext,
	type PluginLlmGenerateRequest,
	type PluginId,
	type PluginManifest,
	type PluginAutonomyGateModule,
	type PluginSendTransportModule,
} from '../index';

describe('public plugin-kit types', () => {
	it('retains literal manifest and contribution types', () => {
		const plugin = definePlugin({
			id: 'typed-plugin',
			version: '1.0.0',
			capabilities: ['send:gate', 'llm:invoke'],
			flag: { default: false },
			llmBudget: { dailyUsd: 1 },
			contributes: {
				sendGates: [
					{
						id: 'policy-gate',
						label: 'Policy gate',
						module: { exportPath: './gates/policy' },
						timeoutMs: 1_000,
					},
				],
			},
		} as const);

		expectTypeOf(plugin).toMatchTypeOf<PluginManifest>();
		expectTypeOf(plugin.id).toMatchTypeOf<PluginId>();
		expectTypeOf<PluginManifest['id']>().toEqualTypeOf<PluginId>();
		expectTypeOf(plugin.capabilities[0]).toEqualTypeOf<'send:gate'>();
		expectTypeOf(plugin.contributes.sendGates[0].id).toEqualTypeOf<'policy-gate'>();
	});

	it('makes autonomy gates structurally restrict-only', () => {
		const gate: PluginAutonomyGateModule = {
			async evaluate(input, services) {
				expectTypeOf(input).not.toHaveProperty('ctx');
				expectTypeOf(services).toEqualTypeOf<{ readonly signal: AbortSignal }>();
				return { outcome: 'objection', reason: 'Manager review required' };
			},
		};
		expectTypeOf(gate.evaluate).returns.toEqualTypeOf<
			Promise<
				| { readonly outcome: 'no-objection' }
				| { readonly outcome: 'objection'; readonly reason: string }
			>
		>();
	});

	it('exposes only host-mediated context services', () => {
		expectTypeOf<PluginContext>().toHaveProperty('permissions');
		expectTypeOf<PluginContext>().toHaveProperty('storage');
		expectTypeOf<PluginContext>().toHaveProperty('llm');
		expectTypeOf<PluginContext>().toHaveProperty('logger');
		expectTypeOf<PluginContext>().toHaveProperty('scheduler');
		expectTypeOf<PluginContext>().not.toHaveProperty('db');
	});

	it('keeps LLM prompt and message inputs mutually exclusive', () => {
		const promptRequest = {
			tier: 'capable',
			prompt: 'Draft a reply',
			system: 'Be concise',
		} as const satisfies PluginLlmGenerateRequest;
		const messageRequest = {
			tier: 'fast',
			messages: [{ role: 'user', content: 'Classify this' }],
		} as const satisfies PluginLlmGenerateRequest;

		expectTypeOf(promptRequest.prompt).toEqualTypeOf<'Draft a reply'>();
		expectTypeOf(messageRequest.messages[0].role).toEqualTypeOf<'user'>();

		// @ts-expect-error prompt and messages are mutually exclusive
		const bothInputs: PluginLlmGenerateRequest = {
			tier: 'fast',
			prompt: 'Classify this',
			messages: [],
		};
		// @ts-expect-error one input form is required
		const neitherInput: PluginLlmGenerateRequest = { tier: 'fast' };
		void bothInputs;
		void neitherInput;
	});

	it('uses JSON-safe values at storage and scheduling boundaries', () => {
		expectTypeOf<PluginContext['storage']['set']>().parameter(1).toEqualTypeOf<JsonValue>();
		expectTypeOf<PluginCapability>().toMatchTypeOf<`${string}:${string}`>();
	});

	it('keeps send transport extras local to the contributed module', () => {
		interface PostmarkExtras {
			readonly messageStream: string;
		}
		const transport: PluginSendTransportModule<PostmarkExtras> = {
			parseExtras(input) {
				if (typeof input !== 'object' || input === null || !('messageStream' in input)) {
					throw new TypeError('Invalid extras');
				}
				return { messageStream: String(input.messageStream) };
			},
			async send(_params, extras) {
				expectTypeOf(extras).toEqualTypeOf<PostmarkExtras>();
				return { success: true, id: 'message-id' };
			},
		};

		expectTypeOf(transport.parseExtras).returns.toEqualTypeOf<PostmarkExtras>();
	});
});
