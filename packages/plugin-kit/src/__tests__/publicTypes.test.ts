import { describe, expectTypeOf, it } from 'vitest';
import {
	definePlugin,
	type JsonValue,
	type PluginCapability,
	type PluginContext,
	type PluginLlmGenerateRequest,
	type PluginManifest,
} from '../index';

describe('public plugin-kit types', () => {
	it('retains literal manifest and contribution types', () => {
		const plugin = definePlugin({
			id: 'typed-plugin',
			version: '1.0.0',
			capabilities: ['send:gate', 'llm:invoke'],
			contributes: {
				sendGates: [{ id: 'policy-gate' }],
			},
		} as const);

		expectTypeOf(plugin).toMatchTypeOf<PluginManifest>();
		expectTypeOf(plugin.id).toEqualTypeOf<'typed-plugin'>();
		expectTypeOf(plugin.capabilities[0]).toEqualTypeOf<'send:gate'>();
		expectTypeOf(plugin.contributes.sendGates[0].id).toEqualTypeOf<'policy-gate'>();
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
});
