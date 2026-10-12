import { describe, it, expect } from 'vitest';
import {
	cacheableSystemMessage,
	cacheBreakpointProviderOptions,
	isPromptCacheMarked,
	joinPromptParts,
	promptInputOf,
	type CacheableSystemMessage,
} from '../promptCache';
import { cachedPromptInput } from '../promptCacheInput';
import { resolveRoutingPolicy } from '@owlat/shared/aiRouting';

describe('cacheableSystemMessage', () => {
	it('marks the stable prefix as an Anthropic ephemeral cache breakpoint', () => {
		const msg = cacheableSystemMessage('You are an AI assistant helping to draft email replies.');
		expect(msg.role).toBe('system');
		expect(msg.content).toContain('draft email replies');
		expect(msg.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
	});

	it('carries the content through verbatim so the cached prefix is what was passed', () => {
		const prefix = 'system prompt + org tone + signature + voice grounding';
		const msg: CacheableSystemMessage = cacheableSystemMessage(prefix);
		expect(msg.content).toBe(prefix);
	});

	it('exposes a shared breakpoint constant matching the provider-options shape', () => {
		expect(cacheBreakpointProviderOptions).toEqual({
			anthropic: { cacheControl: { type: 'ephemeral' } },
		});
		expect(cacheableSystemMessage('x').providerOptions).toBe(cacheBreakpointProviderOptions);
	});
});

describe('L9: cache markers per task', () => {
	const parts = { stable: 'Instructions that never change.', variable: 'The message.' };
	const anthropic = { provider: 'anthropic.messages', modelId: 'claude-haiku-5-5' };
	const openrouter = { provider: 'openrouter.chat', modelId: 'anthropic/claude-haiku-5-5' };

	it('marks only a listed task on the native Anthropic adapter', () => {
		expect(isPromptCacheMarked(anthropic, 'mail.extract', [])).toBe(false);
		expect(isPromptCacheMarked(anthropic, 'mail.extract', ['mail.classify'])).toBe(false);
		expect(isPromptCacheMarked(anthropic, 'mail.extract', ['mail.extract'])).toBe(true);
		// The Anthropic marker is not assumed to pass through OpenRouter.
		expect(isPromptCacheMarked(openrouter, 'mail.extract', ['mail.extract'])).toBe(false);
		expect(isPromptCacheMarked('claude-haiku-5-5', 'mail.extract', ['mail.extract'])).toBe(false);
	});

	it('unmarked, the input is the single joined prompt sent before the split', () => {
		expect(promptInputOf(parts, false)).toEqual({ prompt: joinPromptParts(parts) });
		expect(joinPromptParts(parts)).toBe('Instructions that never change.\n\nThe message.');
	});

	it('marked, the stable part is a cache-breakpoint system message, unpadded', () => {
		expect(promptInputOf(parts, true)).toEqual({
			messages: [cacheableSystemMessage(parts.stable), { role: 'user', content: parts.variable }],
		});
	});

	it('reads the task list from the routing policy, empty by default and when unreadable', async () => {
		const ctxWith = (runQuery: () => Promise<unknown>) =>
			({ runQuery }) as unknown as Parameters<typeof cachedPromptInput>[0];
		const byDefault = ctxWith(async () => resolveRoutingPolicy(null));
		expect(await cachedPromptInput(byDefault, 'mail.extract', anthropic, parts)).toEqual({
			prompt: joinPromptParts(parts),
		});
		const listed = ctxWith(async () =>
			resolveRoutingPolicy({ promptCacheTasks: ['mail.extract'] })
		);
		expect(await cachedPromptInput(listed, 'mail.extract', anthropic, parts)).toHaveProperty(
			'messages'
		);
		const failing = ctxWith(async () => {
			throw new Error('down');
		});
		expect(await cachedPromptInput(failing, 'mail.extract', anthropic, parts)).toEqual({
			prompt: joinPromptParts(parts),
		});
	});
});
