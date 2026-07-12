import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the @ai-sdk/google boundary: createGoogleGenerativeAI returns a callable
// client whose call yields a tagged model, so we can assert what was built
// without any real provider construction or network. The mock handles are made
// via `vi.hoisted` so they exist before vitest hoists the `vi.mock` factory and
// the static `../google` import that triggers the mocked-module load.
const { mockGoogleClient, mockCreateGoogle } = vi.hoisted(() => {
	const client = vi.fn((id: string) => ({ modelId: id, provider: 'google' }));
	return { mockGoogleClient: client, mockCreateGoogle: vi.fn(() => client) };
});

vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: mockCreateGoogle }));

import { googleLanguageAdapter } from '../google';

describe('googleLanguageAdapter', () => {
	beforeEach(() => {
		mockCreateGoogle.mockClear();
		mockGoogleClient.mockClear();
	});

	it('is a hosted (non-local) provider with Gemini default models', () => {
		expect(googleLanguageAdapter.kind).toBe('google');
		expect(googleLanguageAdapter.isLocal).toBe(false);
		expect(googleLanguageAdapter.defaultModels).toEqual({
			fast: 'gemini-3.1-flash-lite',
			capable: 'gemini-3.5-flash',
		});
	});

	it('builds a model handle for a given id through the google client', () => {
		const model = googleLanguageAdapter.buildChatModel({ apiKey: 'k' }, 'gemini-2.5-pro');
		expect(mockCreateGoogle).toHaveBeenCalledWith(
			expect.objectContaining({ apiKey: 'k', baseURL: undefined })
		);
		expect(mockGoogleClient).toHaveBeenCalledWith('gemini-2.5-pro');
		expect(model).toMatchObject({ modelId: 'gemini-2.5-pro' });
	});

	it('memoizes one client per (baseUrl, key-fingerprint)', () => {
		googleLanguageAdapter.buildChatModel({ apiKey: 'same' }, 'gemini-2.5-pro');
		googleLanguageAdapter.buildChatModel({ apiKey: 'same' }, 'gemini-2.5-flash');
		expect(mockCreateGoogle).toHaveBeenCalledTimes(1);
	});

	it('requires an API key (hosted, keyed)', () => {
		expect(() => googleLanguageAdapter.validateCredentials({})).toThrow(/API key/);
		expect(() => googleLanguageAdapter.validateCredentials({ apiKey: 'k' })).not.toThrow();
	});
});
