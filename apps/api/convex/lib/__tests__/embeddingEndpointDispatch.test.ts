/**
 * F13: the URL an embedding endpoint is NAMED by (its space identity) and the
 * URL it is CALLED at come from one canonical base URL. Real SDK clients, with
 * `fetch` stubbed to record the request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { embed } from 'ai';
import { endpointIdentity, storedEmbeddingTarget } from '../embeddingSpace';
import { buildIndexEmbedder, resolveEmbeddingPlane } from '../llmProvider';

const requests: string[] = [];

beforeEach(() => {
	requests.length = 0;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL | Request) => {
			requests.push(
				typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
			);
			return new Response(
				JSON.stringify({
					data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
					usage: { prompt_tokens: 1, total_tokens: 1 },
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		})
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

async function requestUrlFor(baseUrl: string): Promise<{ url: string; endpoint: string }> {
	vi.stubEnv('LOCAL_EMBEDDING_BASE_URL', baseUrl);
	const target = storedEmbeddingTarget({ embeddingProviderKind: 'openaiCompatible' });
	const embedder = buildIndexEmbedder(
		resolveEmbeddingPlane('openaiCompatible', undefined, undefined, undefined),
		target
	);
	requests.length = 0;
	await embed({ model: embedder.model, value: 'hello' });
	return { url: requests[0]!, endpoint: target.endpoint };
}

describe('one canonical base URL for identity and dispatch (F13)', () => {
	it('sends a repeated or trailing slash exactly where its identity says', async () => {
		const plain = await requestUrlFor('http://gateway:8080/a/v1');
		const doubled = await requestUrlFor('http://gateway:8080//a/v1/');
		expect(plain.url).toBe('http://gateway:8080/a/v1/embeddings');
		// Same identity, and the same request: what is hashed is what is sent.
		expect(doubled.endpoint).toBe(plain.endpoint);
		expect(doubled.url).toBe(plain.url);
		expect(plain.endpoint).toBe(endpointIdentity('http://gateway:8080/a/v1'));
	});

	it('names two routes on one origin apart, and calls them apart', async () => {
		const a = await requestUrlFor('http://gateway:8080/a/v1');
		const b = await requestUrlFor('http://gateway:8080/b/v1');
		expect(a.endpoint).not.toBe(b.endpoint);
		expect(a.url).not.toBe(b.url);
	});

	it('keeps every request-significant part in the identity, hashed', () => {
		expect(endpointIdentity('http://gateway:8080/a/v1?tenant=1')).not.toBe(
			endpointIdentity('http://gateway:8080/a/v1')
		);
		expect(endpointIdentity('http://user:pw@gateway:8080/a/v1')).not.toBe(
			endpointIdentity('http://gateway:8080/a/v1')
		);
		expect(endpointIdentity('http://user:pw@gateway:8080/a/v1?tenant=1')).not.toMatch(
			/user|pw|tenant|\/a\/v1/
		);
		// The fragment is never sent, so it is not part of the endpoint.
		expect(endpointIdentity('http://gateway:8080/a/v1#x')).toBe(
			endpointIdentity('http://gateway:8080/a/v1')
		);
	});
});
