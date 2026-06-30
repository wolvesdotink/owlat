import { describe, it, expect } from 'vitest';
import {
	INFERRED_CONFIDENCE_FLOOR,
	mergeEdgeAttrs,
	normalizeForHash,
	provenanceRank,
	tagForInferredConfidence,
	tagRank,
	type EdgeAttrs,
} from '../knowledgeEdges';

describe('knowledgeEdges — tagRank / provenanceRank ordering', () => {
	it('ranks confidence tags extracted > inferred > ambiguous', () => {
		expect(tagRank('extracted')).toBeGreaterThan(tagRank('inferred'));
		expect(tagRank('inferred')).toBeGreaterThan(tagRank('ambiguous'));
	});

	it('ranks provenance manual > deterministic > llm', () => {
		expect(provenanceRank('manual')).toBeGreaterThan(provenanceRank('deterministic'));
		expect(provenanceRank('deterministic')).toBeGreaterThan(provenanceRank('llm'));
	});
});

describe('knowledgeEdges — tagForInferredConfidence', () => {
	it('floor is 0.75', () => {
		expect(INFERRED_CONFIDENCE_FLOOR).toBe(0.75);
	});

	it('is "inferred" at exactly the floor (>=) and above', () => {
		expect(tagForInferredConfidence(0.75)).toBe('inferred');
		expect(tagForInferredConfidence(0.9)).toBe('inferred');
		expect(tagForInferredConfidence(1)).toBe('inferred');
	});

	it('is "ambiguous" just below the floor', () => {
		expect(tagForInferredConfidence(0.7499)).toBe('ambiguous');
		expect(tagForInferredConfidence(0.5)).toBe('ambiguous');
		expect(tagForInferredConfidence(0)).toBe('ambiguous');
	});
});

describe('knowledgeEdges — mergeEdgeAttrs precedence', () => {
	const base = (overrides: Partial<EdgeAttrs> = {}): EdgeAttrs => ({
		confidence: 0.5,
		confidenceTag: 'ambiguous',
		provenance: 'llm',
		...overrides,
	});

	it('takes the max confidence', () => {
		expect(mergeEdgeAttrs(base({ confidence: 0.4 }), base({ confidence: 0.9 })).confidence).toBe(0.9);
		expect(mergeEdgeAttrs(base({ confidence: 0.9 }), base({ confidence: 0.4 })).confidence).toBe(0.9);
	});

	it('takes the strongest confidence tag regardless of which side carries it', () => {
		expect(
			mergeEdgeAttrs(base({ confidenceTag: 'ambiguous' }), base({ confidenceTag: 'extracted' }))
				.confidenceTag,
		).toBe('extracted');
		expect(
			mergeEdgeAttrs(base({ confidenceTag: 'extracted' }), base({ confidenceTag: 'inferred' }))
				.confidenceTag,
		).toBe('extracted');
	});

	it('takes the strongest provenance (manual > deterministic > llm)', () => {
		expect(
			mergeEdgeAttrs(base({ provenance: 'llm' }), base({ provenance: 'manual' })).provenance,
		).toBe('manual');
		expect(
			mergeEdgeAttrs(base({ provenance: 'deterministic' }), base({ provenance: 'llm' })).provenance,
		).toBe('deterministic');
	});

	it('takes the max weight, or undefined when neither side has one', () => {
		expect(mergeEdgeAttrs(base({ weight: 0.2 }), base({ weight: 0.8 })).weight).toBe(0.8);
		expect(mergeEdgeAttrs(base({ weight: 0.8 }), base()).weight).toBe(0.8);
		expect(mergeEdgeAttrs(base(), base({ weight: 0.3 })).weight).toBe(0.3);
		expect(mergeEdgeAttrs(base(), base()).weight).toBeUndefined();
	});

	it('keeps the kept edge rationale (never the incoming one)', () => {
		expect(
			mergeEdgeAttrs(base({ rationale: 'kept reason' }), base({ rationale: 'incoming reason' }))
				.rationale,
		).toBe('kept reason');
		expect(mergeEdgeAttrs(base(), base({ rationale: 'incoming reason' })).rationale).toBeUndefined();
	});
});

describe('knowledgeEdges — normalizeForHash', () => {
	it('is deterministic for identical input', () => {
		expect(normalizeForHash('Title', 'Body')).toBe(normalizeForHash('Title', 'Body'));
	});

	it('is case-insensitive', () => {
		expect(normalizeForHash('HELLO World', 'Foo BAR')).toBe(normalizeForHash('hello world', 'foo bar'));
	});

	it('collapses internal whitespace and trims', () => {
		expect(normalizeForHash('  hello   world  ', '\tfoo\n bar ')).toBe(
			normalizeForHash('hello world', 'foo bar'),
		);
	});

	it('preserves the title/content boundary so re-splitting cannot collide', () => {
		// "a b" + "c" must not normalize to the same string as "a" + "b c".
		expect(normalizeForHash('a b', 'c')).not.toBe(normalizeForHash('a', 'b c'));
	});
});
