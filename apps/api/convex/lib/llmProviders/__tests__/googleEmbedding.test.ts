import { afterEach, describe, expect, it, vi } from 'vitest';
import { embedMany } from 'ai';
import { googleEmbeddingAdapter } from '../google';

afterEach(() => vi.unstubAllGlobals());

describe('Gemini Embedding 2 adapter', () => {
	it('requests 768 dimensions and keeps one independent vector per text', async () => {
		const requests: { url: string; body: Record<string, unknown> }[] = [];
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			requests.push({ url: String(url), body: JSON.parse(init.body as string) });
			return new Response(JSON.stringify({ embedding: { values: Array(768).fill(0.01) } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const model = googleEmbeddingAdapter.buildEmbeddingModel({
			apiKey: 'test-embedding-2',
			modelId: googleEmbeddingAdapter.defaultModel,
		});
		const result = await embedMany({ model, values: ['first text', 'second text'], maxRetries: 0 });
		expect(result.embeddings.map((vector) => vector.length)).toEqual([768, 768]);
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			expect(request.url).toContain('/models/gemini-embedding-2:embedContent');
			expect(request.body['outputDimensionality']).toBe(768);
			expect(request.body).not.toHaveProperty('taskType');
		}
		expect(requests.map((request) => request.body['content'])).toEqual([
			{ parts: [{ text: 'first text' }] },
			{ parts: [{ text: 'second text' }] },
		]);
	});
});
