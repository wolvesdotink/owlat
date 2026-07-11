import { describe, it, expect, vi, afterEach } from 'vitest';
import { openaiCompatibleLanguageAdapter } from '../openaiCompatible';

// listModels only uses fetch + the base URL (it never constructs an SDK client),
// so the @ai-sdk/openai-compatible boundary needs no stub here — only fetch.
describe('openaiCompatibleLanguageAdapter.listModels', () => {
	const realFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it('fetches and parses the local /models endpoint (Ollama shape)', async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				object: 'list',
				data: [{ id: 'llama3.1' }, { id: 'qwen2.5' }],
			}),
		}));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const ids = await openaiCompatibleLanguageAdapter.listModels?.({
			baseUrl: 'http://localhost:11434/v1',
		});
		expect(ids).toEqual(['llama3.1', 'qwen2.5']);
		expect(fetchMock).toHaveBeenCalledWith('http://localhost:11434/v1/models', expect.anything());
	});

	it('requires a base URL', async () => {
		await expect(openaiCompatibleLanguageAdapter.listModels?.({})).rejects.toThrow(/base URL/);
	});

	it('throws a descriptive error on a non-OK response', async () => {
		globalThis.fetch = vi.fn(async () => ({
			ok: false,
			status: 500,
			json: async () => ({}),
		})) as unknown as typeof fetch;

		await expect(
			openaiCompatibleLanguageAdapter.listModels?.({ baseUrl: 'http://localhost:11434/v1' })
		).rejects.toThrow(/500/);
	});
});
