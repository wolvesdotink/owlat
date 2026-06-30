import { describe, it, expect } from 'vitest';
import { rankWithGraph, RELATION_WEIGHTS, type GraphRankEdge, type GraphRankNeighbor } from '../graphRank';
import { reciprocalRankFusion } from '../rrf';
import type { Id } from '../../_generated/dataModel';

/**
 * Pure unit tests for the graph-augmented fusion + rerank (lib/graphRank.ts).
 * Ids are plain branded strings — the function never touches the DB.
 */
const k = (s: string): Id<'knowledgeEntries'> => s as unknown as Id<'knowledgeEntries'>;

describe('rankWithGraph', () => {
	it('keeps relation weights ordered supersedes > supports > causes > blocks > relates_to > contradicts', () => {
		expect(RELATION_WEIGHTS.supersedes).toBeGreaterThan(RELATION_WEIGHTS.supports);
		expect(RELATION_WEIGHTS.supports).toBeGreaterThan(RELATION_WEIGHTS.causes);
		expect(RELATION_WEIGHTS.causes).toBeGreaterThan(RELATION_WEIGHTS.blocks);
		expect(RELATION_WEIGHTS.blocks).toBeGreaterThan(RELATION_WEIGHTS.relates_to);
		expect(RELATION_WEIGHTS.relates_to).toBeGreaterThan(RELATION_WEIGHTS.contradicts);
	});

	it('a single-edge neighbour never outranks a both-legs seed (even when RRF would)', () => {
		// Bury the both-legs seed S at rank 70 in BOTH legs so plain RRF scores it
		// BELOW a top single-edge neighbour — then assert the rerank still floors S
		// above N. (2/(61+70) < 1/61, so raw RRF puts N first.)
		const decoysV = Array.from({ length: 70 }, (_, i) => k(`xv${i}`));
		const decoysF = Array.from({ length: 70 }, (_, i) => k(`xf${i}`));
		const vectorRanked = [...decoysV, k('S')];
		const ftsRanked = [...decoysF, k('S')];

		const neighbors: GraphRankNeighbor[] = [
			{ id: k('N'), hop: 1, relation: 'supersedes', seedProximity: 1, confidence: 1 },
		];
		// N reached by a single edge (degree 1). 'supports' so N isn't itself stale.
		const edges: GraphRankEdge[] = [
			{ fromId: k('N'), toId: k('S'), relationType: 'supports' },
		];

		// Sanity: raw RRF really does rank N above S here.
		const rawFused = reciprocalRankFusion<Id<'knowledgeEntries'>>([vectorRanked, ftsRanked, [k('N')]]);
		expect(rawFused.indexOf(k('N'))).toBeLessThan(rawFused.indexOf(k('S')));

		const { orderedIds } = rankWithGraph({ vectorRanked, ftsRanked, neighbors, edges });
		expect(orderedIds.indexOf(k('S'))).toBeLessThan(orderedIds.indexOf(k('N')));
	});

	it('demotes the target of a supersedes edge and reports it stale', () => {
		// B outranks A in raw RRF (B is rank 0 in both legs); the supersedes A→B
		// edge must push B below A and flag B stale.
		const vectorRanked = [k('B'), k('A')];
		const ftsRanked = [k('B'), k('A')];
		const edges: GraphRankEdge[] = [{ fromId: k('A'), toId: k('B'), relationType: 'supersedes' }];

		const { orderedIds, supersededIds } = rankWithGraph({
			vectorRanked,
			ftsRanked,
			neighbors: [],
			edges,
		});

		expect(supersededIds).toEqual([k('B')]);
		expect(orderedIds.indexOf(k('A'))).toBeLessThan(orderedIds.indexOf(k('B')));
		expect(orderedIds).toContain(k('B')); // kept, just demoted
	});

	it('flags both endpoints of a contradicts edge as a caveat but keeps them', () => {
		const vectorRanked = [k('X'), k('Y')];
		const ftsRanked = [k('X'), k('Y')];
		const edges: GraphRankEdge[] = [{ fromId: k('X'), toId: k('Y'), relationType: 'contradicts' }];

		const { orderedIds, caveatIds, supersededIds } = rankWithGraph({
			vectorRanked,
			ftsRanked,
			neighbors: [],
			edges,
		});

		expect([...caveatIds].sort()).toEqual([k('X'), k('Y')].sort());
		expect(supersededIds).toEqual([]);
		expect(orderedIds).toContain(k('X'));
		expect(orderedIds).toContain(k('Y'));
	});

	it('with no neighbours and no edges, output is byte-identical to plain RRF', () => {
		const vectorRanked = [k('A'), k('B'), k('C')];
		const ftsRanked = [k('B'), k('C'), k('D')];

		const { orderedIds, caveatIds, supersededIds } = rankWithGraph({
			vectorRanked,
			ftsRanked,
			neighbors: [],
			edges: [],
		});

		expect(orderedIds).toEqual(reciprocalRankFusion<Id<'knowledgeEntries'>>([vectorRanked, ftsRanked]));
		expect(caveatIds).toEqual([]);
		expect(supersededIds).toEqual([]);
	});
});
