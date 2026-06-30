import { describe, it, expect } from 'vitest';
import {
	prepareGraphModel,
	nodeRadius,
	coerceConfidenceTag,
	edgeLineStyle,
	confidenceBucketBars,
	type SubgraphNodeInput,
	type SubgraphEdgeInput,
} from '../knowledgeGraphLayout';

const node = (id: string, over: Partial<SubgraphNodeInput> = {}): SubgraphNodeInput => ({
	id,
	title: `Title ${id}`,
	entryType: 'fact',
	confidence: 0.8,
	...over,
});

const edge = (fromId: string, toId: string, over: Partial<SubgraphEdgeInput> = {}): SubgraphEdgeInput => ({
	fromId,
	toId,
	relationType: 'relates_to',
	confidence: 1,
	confidenceTag: 'extracted',
	...over,
});

describe('nodeRadius', () => {
	it('grows monotonically with degree', () => {
		expect(nodeRadius(2, false)).toBeGreaterThan(nodeRadius(0, false));
		expect(nodeRadius(10, false)).toBeGreaterThan(nodeRadius(2, false));
	});

	it('makes a god node larger than a same-degree leaf', () => {
		expect(nodeRadius(0, true)).toBeGreaterThan(nodeRadius(0, false));
		expect(nodeRadius(1, true)).toBeGreaterThan(nodeRadius(1, false));
	});

	it('clamps to the max radius for very high degree', () => {
		expect(nodeRadius(10_000, true)).toBeLessThanOrEqual(22);
		expect(nodeRadius(10_000, false)).toBeLessThanOrEqual(22);
	});

	it('treats a negative / NaN degree as zero (defensive)', () => {
		expect(nodeRadius(-5, false)).toBe(nodeRadius(0, false));
		expect(nodeRadius(Number.NaN, false)).toBe(nodeRadius(0, false));
	});
});

describe('coerceConfidenceTag', () => {
	it('passes through a known tag verbatim', () => {
		expect(coerceConfidenceTag('extracted', 0.1)).toBe('extracted');
		expect(coerceConfidenceTag('inferred', 1)).toBe('inferred');
		expect(coerceConfidenceTag('ambiguous', 1)).toBe('ambiguous');
	});

	it('buckets a missing tag by numeric confidence', () => {
		expect(coerceConfidenceTag(undefined, 0.95)).toBe('extracted');
		expect(coerceConfidenceTag(undefined, 0.6)).toBe('inferred');
		expect(coerceConfidenceTag(undefined, 0.2)).toBe('ambiguous');
	});

	it('buckets an unrecognized tag string by confidence', () => {
		expect(coerceConfidenceTag('bogus', 0.95)).toBe('extracted');
	});
});

describe('edgeLineStyle', () => {
	it('maps each tag to its canvas style', () => {
		expect(edgeLineStyle('extracted')).toBe('solid');
		expect(edgeLineStyle('inferred')).toBe('dashed');
		expect(edgeLineStyle('ambiguous')).toBe('faint');
	});
});

describe('prepareGraphModel', () => {
	it('maps nodes/edges and computes degree from valid edges only', () => {
		const { nodes, edges } = prepareGraphModel({
			nodes: [node('a'), node('b'), node('c')],
			edges: [
				edge('a', 'b'),
				edge('a', 'c'),
				edge('a', 'ghost'), // dangling — endpoint not in node set → dropped
			],
		});
		expect(edges).toHaveLength(2);
		const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
		expect(byId['a']!.degree).toBe(2);
		expect(byId['b']!.degree).toBe(1);
		expect(byId['c']!.degree).toBe(1);
	});

	it('flags god nodes and sizes them larger', () => {
		const { nodes } = prepareGraphModel({
			nodes: [node('hub'), node('leaf')],
			edges: [edge('hub', 'leaf')],
			godNodeIds: ['hub'],
		});
		const hub = nodes.find((n) => n.id === 'hub')!;
		const leaf = nodes.find((n) => n.id === 'leaf')!;
		expect(hub.isGod).toBe(true);
		expect(leaf.isGod).toBe(false);
		expect(hub.radius).toBeGreaterThan(leaf.radius);
	});

	it('keys edge line style off the confidence tag', () => {
		const { edges } = prepareGraphModel({
			nodes: [node('a'), node('b'), node('c'), node('d')],
			edges: [
				edge('a', 'b', { confidenceTag: 'extracted' }),
				edge('a', 'c', { confidenceTag: 'inferred' }),
				edge('a', 'd', { confidenceTag: 'ambiguous' }),
			],
		});
		const style = (to: string) => edges.find((e) => e.toId === to)!.lineStyle;
		expect(style('b')).toBe('solid');
		expect(style('c')).toBe('dashed');
		expect(style('d')).toBe('faint');
	});

	it('dims nodes (and their edges) that do not match the entryType filter', () => {
		const { nodes, edges } = prepareGraphModel({
			nodes: [node('a', { entryType: 'fact' }), node('b', { entryType: 'goal' })],
			edges: [edge('a', 'b')],
			entryTypeFilter: 'fact',
		});
		expect(nodes.find((n) => n.id === 'a')!.dimmed).toBe(false);
		expect(nodes.find((n) => n.id === 'b')!.dimmed).toBe(true);
		// Edge touches a dimmed endpoint → dimmed.
		expect(edges[0]!.dimmed).toBe(true);
	});

	it('no filter ⇒ nothing dimmed', () => {
		const { nodes, edges } = prepareGraphModel({
			nodes: [node('a'), node('b', { entryType: 'goal' })],
			edges: [edge('a', 'b')],
		});
		expect(nodes.every((n) => !n.dimmed)).toBe(true);
		expect(edges.every((e) => !e.dimmed)).toBe(true);
	});

	it('produces stable unique edge ids', () => {
		const { edges } = prepareGraphModel({
			nodes: [node('a'), node('b')],
			edges: [edge('a', 'b'), edge('a', 'b', { relationType: 'supports' })],
		});
		const ids = edges.map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('confidenceBucketBars', () => {
	it('labels ranges and normalizes heights to the tallest bucket', () => {
		const bars = confidenceBucketBars([0, 5, 10, 0, 0, 0, 0, 0, 0, 0]);
		expect(bars).toHaveLength(10);
		expect(bars[0]!.rangeLabel).toBe('0–10%');
		expect(bars[9]!.rangeLabel).toBe('90–100%');
		expect(bars[2]!.heightFraction).toBe(1); // tallest (count 10)
		expect(bars[1]!.heightFraction).toBe(0.5); // count 5 of 10
	});

	it('all-zero buckets yield zero heights (no divide-by-zero)', () => {
		const bars = confidenceBucketBars(Array.from({ length: 10 }, () => 0));
		expect(bars.every((b) => b.heightFraction === 0)).toBe(true);
	});
});
