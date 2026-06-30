/**
 * Guard for the embedding-dimension / vector-index coupling. The schema vector
 * index is fixed at EMBEDDING_DIMENSIONS; a configured embedding model that
 * produces a different width must fail loudly rather than silently storing a
 * wrong-width vector that breaks every vector search.
 */

import { describe, it, expect } from 'vitest';
import { assertEmbeddingDimension } from '../llmProvider';
import { EMBEDDING_DIMENSIONS } from '../constants';

describe('assertEmbeddingDimension', () => {
	it('accepts a correctly-sized vector', () => {
		expect(() =>
			assertEmbeddingDimension(new Array(EMBEDDING_DIMENSIONS).fill(0)),
		).not.toThrow();
	});

	it('throws on a too-wide vector and names the expected dimension', () => {
		expect(() => assertEmbeddingDimension(new Array(3072).fill(0))).toThrow(
			String(EMBEDDING_DIMENSIONS),
		);
	});

	it('throws on a too-narrow vector', () => {
		expect(() => assertEmbeddingDimension(new Array(768).fill(0))).toThrow();
	});
});
