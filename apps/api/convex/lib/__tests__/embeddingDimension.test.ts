/**
 * Guard for the embedding-dimension / vector-index coupling. The schema vector
 * index is fixed at EMBEDDING_DIMENSIONS. The default local embedder
 * (nomic-embed-text) is narrower, so narrower vectors are zero-padded — which
 * must not change how they rank — and only a WIDER vector fails loudly.
 */

import { describe, it, expect } from 'vitest';
import { toIndexVector } from '../llmProvider';
import { EMBEDDING_DIMENSIONS } from '../constants';

function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i]! * b[i]!;
		na += a[i]! * a[i]!;
		nb += b[i]! * b[i]!;
	}
	return dot / Math.sqrt(na * nb);
}

describe('toIndexVector', () => {
	it('passes a correctly-sized vector through unchanged', () => {
		const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i / 10);
		expect(toIndexVector(vector)).toEqual(vector);
	});

	it('zero-pads a 768-dim vector (the default local embedder) to the index width', () => {
		const vector = toIndexVector(new Float32Array(768).fill(0.5));
		expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
		expect(vector.slice(0, 768).every((x) => x === 0.5)).toBe(true);
		expect(vector.slice(768).every((x) => x === 0)).toBe(true);
	});

	it('keeps cosine similarity between padded vectors identical', () => {
		const a = Array.from({ length: 768 }, (_, i) => Math.sin(i));
		const b = Array.from({ length: 768 }, (_, i) => Math.cos(i * 0.7));
		expect(cosine(toIndexVector(a), toIndexVector(b))).toBeCloseTo(cosine(a, b), 12);
	});

	it('throws on a too-wide vector and names the index width', () => {
		expect(() => toIndexVector(new Array(3072).fill(0))).toThrow(String(EMBEDDING_DIMENSIONS));
	});

	it('throws on an empty vector', () => {
		expect(() => toIndexVector([])).toThrow();
	});
});
