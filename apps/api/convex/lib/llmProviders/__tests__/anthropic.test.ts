import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the @ai-sdk/anthropic boundary: createAnthropic returns a callable
// client whose call yields a tagged model, so we can assert what was built
// without any real provider construction or network. The mock handles are
// created via `vi.hoisted` so they exist before vitest hoists the `vi.mock`
// factory and the static `../anthropic` import that triggers the mocked load.
const { mockAnthropicClient, mockCreateAnthropic } = vi.hoisted(() => {
	const client = vi.fn((id: string) => ({ modelId: id, provider: 'anthropic' }));
	return { mockAnthropicClient: client, mockCreateAnthropic: vi.fn(() => client) };
});

vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: mockCreateAnthropic }));

import { anthropicLanguageAdapter } from '../anthropic';

describe('anthropicLanguageAdapter', () => {
	beforeEach(() => {
		mockCreateAnthropic.mockClear();
		mockAnthropicClient.mockClear();
	});

	it('is a hosted (non-local) provider with Claude default models', () => {
		expect(anthropicLanguageAdapter.kind).toBe('anthropic');
		expect(anthropicLanguageAdapter.isLocal).toBe(false);
		expect(anthropicLanguageAdapter.defaultModels).toEqual({
			fast: 'claude-haiku-4-5',
			capable: 'claude-opus-4-8',
		});
	});

	it('builds a model handle for a given id through the anthropic client', () => {
		const model = anthropicLanguageAdapter.buildChatModel({ apiKey: 'k' }, 'claude-opus-4-8');
		expect(mockCreateAnthropic).toHaveBeenCalledWith(
			expect.objectContaining({ apiKey: 'k', baseURL: undefined })
		);
		expect(mockAnthropicClient).toHaveBeenCalledWith('claude-opus-4-8');
		expect(model).toMatchObject({ modelId: 'claude-opus-4-8' });
	});

	it('memoizes one client per (baseUrl, key-fingerprint)', () => {
		anthropicLanguageAdapter.buildChatModel({ apiKey: 'same' }, 'claude-opus-4-8');
		anthropicLanguageAdapter.buildChatModel({ apiKey: 'same' }, 'claude-haiku-4-5');
		expect(mockCreateAnthropic).toHaveBeenCalledTimes(1);
	});

	it('requires an API key (hosted, keyed)', () => {
		expect(() => anthropicLanguageAdapter.validateCredentials({})).toThrow(/API key/);
		expect(() => anthropicLanguageAdapter.validateCredentials({ apiKey: 'k' })).not.toThrow();
	});
});
