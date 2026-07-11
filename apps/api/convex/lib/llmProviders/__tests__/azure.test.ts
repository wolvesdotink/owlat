import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the @ai-sdk/azure boundary: createAzure returns a callable client whose
// call yields a tagged model, so we can assert what was built (deployment-name
// based) without any real provider construction or network. The handles are
// created via `vi.hoisted` so they exist before vitest hoists the `vi.mock`
// factory and the static `../azure` import that triggers the mocked-module load.
const { mockAzureClient, mockCreateAzure } = vi.hoisted(() => {
	const client = vi.fn((id: string) => ({ modelId: id, provider: 'azure' }));
	return { mockAzureClient: client, mockCreateAzure: vi.fn(() => client) };
});

vi.mock('@ai-sdk/azure', () => ({ createAzure: mockCreateAzure }));

import { azureLanguageAdapter } from '../azure';

const BASE = 'https://acme.openai.azure.com/openai';

describe('azureLanguageAdapter', () => {
	beforeEach(() => {
		mockCreateAzure.mockClear();
		mockAzureClient.mockClear();
	});

	it('is a hosted (non-local) provider', () => {
		expect(azureLanguageAdapter.kind).toBe('azure');
		expect(azureLanguageAdapter.isLocal).toBe(false);
	});

	it('builds a model handle for a deployment name through the azure client', () => {
		const model = azureLanguageAdapter.buildChatModel(
			{ apiKey: 'k', baseUrl: BASE },
			'my-gpt4o-deploy'
		);
		expect(mockCreateAzure).toHaveBeenCalledWith(
			expect.objectContaining({ apiKey: 'k', baseURL: BASE })
		);
		// The id passed through is the admin's DEPLOYMENT name, not a canonical id.
		expect(mockAzureClient).toHaveBeenCalledWith('my-gpt4o-deploy');
		expect(model).toMatchObject({ modelId: 'my-gpt4o-deploy' });
	});

	it('memoizes one client per (baseUrl, key-fingerprint)', () => {
		azureLanguageAdapter.buildChatModel({ apiKey: 'same', baseUrl: BASE }, 'a');
		azureLanguageAdapter.buildChatModel({ apiKey: 'same', baseUrl: BASE }, 'b');
		expect(mockCreateAzure).toHaveBeenCalledTimes(1);
	});

	it('requires both an API key and a resource base URL', () => {
		expect(() => azureLanguageAdapter.validateCredentials({})).toThrow(/API key/);
		expect(() => azureLanguageAdapter.validateCredentials({ apiKey: 'k' })).toThrow(/base URL/);
		expect(() =>
			azureLanguageAdapter.validateCredentials({ apiKey: 'k', baseUrl: BASE })
		).not.toThrow();
	});
});
