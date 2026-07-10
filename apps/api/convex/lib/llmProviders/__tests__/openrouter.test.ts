import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub the @ai-sdk/openai-compatible boundary (OpenRouter builds through it):
// createOpenAICompatible returns a callable client whose call yields a tagged
// model, so we can assert what was built without any real provider construction
// or network. Made via `vi.hoisted` so the handles exist before vitest hoists
// the `vi.mock` factory and the static `../openrouter` import.
const { mockCompatibleClient, mockCreateCompatible } = vi.hoisted(() => {
	const client = vi.fn((id: string) => ({ modelId: id, provider: 'openrouter' }));
	return { mockCompatibleClient: client, mockCreateCompatible: vi.fn(() => client) };
});

vi.mock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible: mockCreateCompatible }));

import { openrouterLanguageAdapter, parseOpenRouterModelIds } from '../openrouter';
import { estimateCost } from '../../llm/pricing';

describe('openrouterLanguageAdapter', () => {
	beforeEach(() => {
		mockCreateCompatible.mockClear();
		mockCompatibleClient.mockClear();
	});

	it('is a hosted (non-local) provider with free-text default model ids', () => {
		expect(openrouterLanguageAdapter.kind).toBe('openrouter');
		expect(openrouterLanguageAdapter.isLocal).toBe(false);
		expect(openrouterLanguageAdapter.defaultModels).toEqual({
			fast: 'openai/gpt-4o-mini',
			capable: 'anthropic/claude-sonnet-4-5',
		});
	});

	it('builds a model handle against the OpenRouter endpoint by default', () => {
		const model = openrouterLanguageAdapter.buildChatModel(
			{ apiKey: 'k' },
			'anthropic/claude-opus-4-8'
		);
		expect(mockCreateCompatible).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'openrouter',
				baseURL: 'https://openrouter.ai/api/v1',
				apiKey: 'k',
			})
		);
		expect(mockCompatibleClient).toHaveBeenCalledWith('anthropic/claude-opus-4-8');
		expect(model).toMatchObject({ modelId: 'anthropic/claude-opus-4-8' });
	});

	it('memoizes one client per (baseUrl, key-fingerprint)', () => {
		openrouterLanguageAdapter.buildChatModel({ apiKey: 'same' }, 'openai/gpt-4o');
		openrouterLanguageAdapter.buildChatModel({ apiKey: 'same' }, 'openai/gpt-4o-mini');
		expect(mockCreateCompatible).toHaveBeenCalledTimes(1);
	});

	it('requires an API key (hosted, keyed)', () => {
		expect(() => openrouterLanguageAdapter.validateCredentials({})).toThrow(/API key/);
		expect(() => openrouterLanguageAdapter.validateCredentials({ apiKey: 'k' })).not.toThrow();
	});
});

describe('parseOpenRouterModelIds', () => {
	it('parses model ids from a /models fixture payload', () => {
		const fixture = {
			data: [
				{ id: 'anthropic/claude-opus-4-8', name: 'Claude Opus 4.8' },
				{ id: 'openai/gpt-4o', name: 'GPT-4o' },
				{ id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
			],
		};
		expect(parseOpenRouterModelIds(fixture)).toEqual([
			'anthropic/claude-opus-4-8',
			'openai/gpt-4o',
			'google/gemini-2.5-pro',
		]);
	});

	it('skips off-shape entries without throwing', () => {
		const messy = {
			data: [{ id: 'openai/gpt-4o' }, { name: 'no id here' }, 'not-an-object', { id: 42 }, null],
		};
		expect(parseOpenRouterModelIds(messy)).toEqual(['openai/gpt-4o']);
	});

	it('returns an empty list for a malformed body rather than throwing', () => {
		expect(parseOpenRouterModelIds({})).toEqual([]);
		expect(parseOpenRouterModelIds(null)).toEqual([]);
		expect(parseOpenRouterModelIds({ data: 'nope' })).toEqual([]);
	});
});

describe('openrouterLanguageAdapter.listModels', () => {
	const realFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it('fetches and parses the /models endpoint', async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ data: [{ id: 'openai/gpt-4o' }, { id: 'anthropic/claude-opus-4-8' }] }),
		}));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const ids = await openrouterLanguageAdapter.listModels?.({ apiKey: 'k' });
		expect(ids).toEqual(['openai/gpt-4o', 'anthropic/claude-opus-4-8']);
		expect(fetchMock).toHaveBeenCalledWith(
			'https://openrouter.ai/api/v1/models',
			expect.objectContaining({ headers: { Authorization: 'Bearer k' } })
		);
	});

	it('throws a descriptive error on a non-OK response', async () => {
		globalThis.fetch = vi.fn(async () => ({
			ok: false,
			status: 503,
			json: async () => ({}),
		})) as unknown as typeof fetch;

		await expect(openrouterLanguageAdapter.listModels?.({ apiKey: 'k' })).rejects.toThrow(/503/);
	});
});

describe('OpenRouter pricing degrades gracefully', () => {
	const usage = { promptTokens: 1000, completionTokens: 1000 };

	it('flags an unknown free-text model as estimated, never throwing', () => {
		const result = estimateCost('some-brand-new/model-nobody-priced', usage);
		expect(result.estimated).toBe(true);
		expect(result.costUsd).toBeGreaterThan(0);
		expect(Number.isFinite(result.costUsd)).toBe(true);
	});

	it('matches a provider-prefixed OpenRouter id via the upstream id', () => {
		const claude = estimateCost('anthropic/claude-opus-4-8', usage);
		expect(claude.estimated).toBe(false);
		const gemini = estimateCost('google/gemini-2.5-flash', usage);
		expect(gemini.estimated).toBe(false);
	});
});
