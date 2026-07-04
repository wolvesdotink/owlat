import { describe, it, expect } from 'vitest';
import {
	cacheableSystemMessage,
	cacheBreakpointProviderOptions,
	type CacheableSystemMessage,
} from '../promptCache';

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
