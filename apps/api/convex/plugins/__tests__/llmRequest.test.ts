import { describe, expect, it } from 'vitest';
import {
	PLUGIN_LLM_MAX_INPUT_BYTES,
	PLUGIN_LLM_MAX_MESSAGE_BYTES,
	PLUGIN_LLM_MAX_MESSAGES,
	validatePluginLlmRequest,
} from '../llmRequest';

describe('plugin LLM request boundary', () => {
	it('snapshots the prompt and message variants with a conservative UTF-8 bound', () => {
		expect(validatePluginLlmRequest({ tier: 'fast', prompt: '😀', system: 's' })).toMatchObject({
			tier: 'fast',
			inputTokensUpperBound: 1029,
			dispatchInput: { prompt: '😀', system: 's' },
		});
		expect(
			validatePluginLlmRequest({
				tier: 'capable',
				messages: [
					{ role: 'system', content: 'policy' },
					{ role: 'user', content: 'hello' },
				],
			})
		).toMatchObject({ tier: 'capable' });
	});

	it.each([
		{},
		{ tier: 'fast' },
		{ tier: 'fast', prompt: '', messages: [] },
		{ tier: 'fast', prompt: 'x', system: 's', messages: [{ role: 'user', content: 'x' }] },
		{ tier: 'mystery', prompt: 'x' },
		{ tier: 'fast', messages: [] },
		{ tier: 'fast', messages: [{ role: 'tool', content: 'x' }] },
		{
			tier: 'fast',
			messages: [{ role: 'user', content: 'x'.repeat(PLUGIN_LLM_MAX_MESSAGE_BYTES + 1) }],
		},
		{ tier: 'fast', prompt: 'x'.repeat(PLUGIN_LLM_MAX_INPUT_BYTES + 1) },
		{
			tier: 'fast',
			messages: Array.from({ length: PLUGIN_LLM_MAX_MESSAGES + 1 }, () => ({
				role: 'user',
				content: 'x',
			})),
		},
	])('rejects an invalid or oversized shape without echoing input %#', (request) => {
		let error: unknown;
		try {
			validatePluginLlmRequest(request);
		} catch (cause) {
			error = cause;
		}
		expect(error).toBeInstanceOf(TypeError);
		expect((error as Error).message).toBe('Invalid plugin LLM request');
	});

	it('rejects accessors, proxies, symbols, hidden fields, and extra numeric array keys', () => {
		let getterReads = 0;
		const accessor = Object.defineProperty({ tier: 'fast' }, 'prompt', {
			enumerable: true,
			get() {
				getterReads += 1;
				return 'secret';
			},
		});
		const messages = [{ role: 'user', content: 'safe' }];
		Object.defineProperty(messages, '01', { enumerable: true, value: { secret: 'hidden' } });
		for (const request of [
			accessor,
			new Proxy(
				{ tier: 'fast', prompt: 'secret' },
				{
					ownKeys: () => {
						throw new Error('secret');
					},
				}
			),
			{ tier: 'fast', prompt: 'safe', [Symbol('secret')]: true },
			Object.defineProperty({ tier: 'fast', prompt: 'safe' }, 'hidden', { value: 'secret' }),
			{ tier: 'fast', messages },
		]) {
			expect(() => validatePluginLlmRequest(request)).toThrow('Invalid plugin LLM request');
		}
		expect(getterReads).toBe(0);
	});
});
