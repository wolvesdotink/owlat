import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	__resetEmbeddingProbeCacheForTests,
	measuredEmbeddingSpace,
	ollamaApiRoot,
	revisionFromOllamaTags,
} from '../embeddingProbe';
import { storedEmbeddingTarget } from '../../embeddingSpace';
import { embeddingSpaceIdentityKey } from '../embeddingKeys';
import { inputFingerprint, fileEmbeddingInput } from '../embeddingInputs';
import { rowCoverage, vectorInSpace } from '../embeddingRegistry';
import type { Id } from '../../../_generated/dataModel';

/** An `/api/tags` body as Ollama serves it. */
const TAGS = {
	models: [
		{
			name: 'nomic-embed-text:latest',
			model: 'nomic-embed-text:latest',
			digest: '0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f',
			details: { family: 'nomic-bert', quantization_level: 'F16' },
		},
		{ name: 'qwen3.6:27b', model: 'qwen3.6:27b', digest: 'ffff', details: {} },
	],
};

const fetchMock = vi.fn();
beforeEach(() => {
	__resetEmbeddingProbeCacheForTests();
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe('revisionFromOllamaTags', () => {
	it('reads the digest and quantization of the untagged alias (:latest)', () => {
		expect(revisionFromOllamaTags(TAGS, 'nomic-embed-text')).toEqual({
			revision: TAGS.models[0]!.digest,
			quantization: 'F16',
		});
	});

	it('knows nothing about a model it does not list, or a body that is not a tag list', () => {
		expect(revisionFromOllamaTags(TAGS, 'mxbai-embed-large')).toEqual({});
		expect(revisionFromOllamaTags({ data: [] }, 'nomic-embed-text')).toEqual({});
		expect(revisionFromOllamaTags(null, 'nomic-embed-text')).toEqual({});
	});

	it('strips the OpenAI-compatible path to reach the native API', () => {
		expect(ollamaApiRoot('http://ollama:11434/v1/')).toBe('http://ollama:11434');
	});
});

describe('measuredEmbeddingSpace', () => {
	const local = () => storedEmbeddingTarget({ embeddingProviderKind: 'local' });

	it('captures the Nomic digest and quantization into the identity (#1334)', async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify(TAGS), { status: 200 }));
		const space = await measuredEmbeddingSpace(
			local(),
			Array.from({ length: 768 }, () => 0.1)
		);
		expect(fetchMock).toHaveBeenCalledWith('http://ollama:11434/api/tags', expect.anything());
		expect(space).toEqual({
			provider: 'local',
			endpoint: 'http://ollama:11434',
			model: 'nomic-embed-text',
			dimensions: 768,
			revision: TAGS.models[0]!.digest,
			quantization: 'F16',
			source: 'stored_config',
		});
	});

	it('marks the revision unknown when the server exposes none, and never pretends', async () => {
		fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));
		const space = await measuredEmbeddingSpace(local(), [1, 2, 3]);
		expect(space.revision).toBeUndefined();
		expect(space.quantization).toBeUndefined();
	});

	it('treats an unknown and a known digest as different spaces', async () => {
		fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));
		const unknown = await measuredEmbeddingSpace(local(), [1, 2]);
		__resetEmbeddingProbeCacheForTests();
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(TAGS), { status: 200 }));
		const known = await measuredEmbeddingSpace(local(), [1, 2]);
		expect(embeddingSpaceIdentityKey(unknown)).not.toBe(embeddingSpaceIdentityKey(known));
	});

	it('throws when the server cannot be reached, rather than registering an unknown revision', async () => {
		fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
		await expect(measuredEmbeddingSpace(local(), [1])).rejects.toThrow(/did not answer/);
		fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }));
		await expect(measuredEmbeddingSpace(local(), [1])).rejects.toThrow(/failed the revision probe/);
	});

	it('reuses a probe answer for a short while', async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify(TAGS), { status: 200 }));
		await measuredEmbeddingSpace(local(), [1]);
		await measuredEmbeddingSpace(local(), [1]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('never probes a hosted embedder', async () => {
		const space = await measuredEmbeddingSpace(
			storedEmbeddingTarget({ embeddingProviderKind: 'openai' }),
			Array.from({ length: 1536 }, () => 0)
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(space).toMatchObject({ provider: 'openai', endpoint: 'native', dimensions: 1536 });
	});
});

describe('row vectors and coverage', () => {
	const A = 'space_a' as Id<'embeddingSpaces'>;
	const B = 'space_b' as Id<'embeddingSpaces'>;

	it('returns a vector only from the column its space lives in', () => {
		const row = {
			embedding: [1],
			embeddingSpaceId: A,
			secondaryEmbedding: [2],
			secondaryEmbeddingSpaceId: B,
		};
		expect(vectorInSpace(row, { spaceId: A, slot: 'primary' })).toEqual([1]);
		expect(vectorInSpace(row, { spaceId: B, slot: 'secondary' })).toEqual([2]);
		expect(vectorInSpace(row, { spaceId: B, slot: 'primary' })).toBeNull();
		expect(vectorInSpace(row, { spaceId: A, slot: 'secondary' })).toBeNull();
	});

	it('classifies active, unknown, inactive and unembedded rows', () => {
		const active = { spaceId: A, slot: 'primary' as const };
		expect(rowCoverage({ embedding: [1], embeddingSpaceId: A }, active)).toBe('active');
		expect(rowCoverage({ embedding: [1] }, active)).toBe('unknown');
		expect(rowCoverage({ embedding: [1], embeddingSpaceId: B }, active)).toBe('inactive');
		expect(rowCoverage({ embedding: [] }, active)).toBe('unembedded');
		expect(rowCoverage({ embedding: [1] }, null)).toBe('unknown');
	});
});

describe('embedding inputs', () => {
	it('builds a file input only for a processed file with enough text', () => {
		expect(fileEmbeddingInput({ title: 'Plan' })).toBeNull();
		expect(fileEmbeddingInput({ title: 'Plan', extractedText: 'Phase one ships in May.' })).toBe(
			'Plan Phase one ships in May.'
		);
	});

	it('fingerprints the exact text', () => {
		expect(inputFingerprint('a')).toBe(inputFingerprint('a'));
		expect(inputFingerprint('a')).not.toBe(inputFingerprint('b'));
	});
});
