import { describe, expect, it } from 'vitest';
import { expandNeighbors } from '../graphTraversal';

/**
 * Read budget of `expandNeighbors` (#921): the real handler against an
 * instrumented in-memory indexed reader. Scope/TTL/entryType semantics are
 * covered end-to-end in knowledgeGraphRetrieval.integration.test.ts; this file
 * bounds how many `knowledgeEntries` documents one traversal hydrates.
 */

type Node = {
	_id: string;
	title: string;
	entryType: 'fact';
	contactIds?: string[];
	expiresAt?: number;
};
type Rel = {
	_id: string;
	fromEntryId: string;
	toEntryId: string;
	relationType: string;
	confidence: number;
};
type Result = {
	neighbors: { id: string }[];
	edges: { fromId: string; toId: string }[];
	truncated: boolean;
};

const handler = (
	expandNeighbors as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<Result> }
)._handler;

function graph() {
	const nodes = new Map<string, Node>();
	const rels: Rel[] = [];
	return {
		nodes,
		node(id: string, extra: Partial<Node> = {}) {
			nodes.set(id, { _id: id, title: id, entryType: 'fact', ...extra });
			return id;
		},
		rel(from: string, to: string) {
			rels.push({
				_id: `r${rels.length}`,
				fromEntryId: from,
				toEntryId: to,
				relationType: 'relates_to',
				confidence: 0.8,
			});
		},
		async run(args: { seedIds: string[]; scope: string; hops: number; neighborBudget: number }) {
			const gets = new Map<string, number>();
			const edgeQueriesFor = new Set<string>();
			const ctx = {
				db: {
					get: async (id: string) => {
						gets.set(id, (gets.get(id) ?? 0) + 1);
						return nodes.get(id) ?? null;
					},
					query: () => ({
						withIndex: (_index: string, build: (q: unknown) => unknown) => {
							let field = '';
							let value = '';
							build({ eq: (f: string, v: string) => ((field = f), (value = v), null) });
							edgeQueriesFor.add(value);
							return {
								take: async (n: number) =>
									rels.filter((r) => (r as Record<string, unknown>)[field] === value).slice(0, n),
							};
						},
					}),
				},
			};
			const res = await handler(ctx, args);
			const totalGets = [...gets.values()].reduce((s, n) => s + n, 0);
			return { res, gets, totalGets, edgeQueriesFor };
		},
	};
}

/**
 * The #921 dense fixture: 12 seeds with 32 outgoing + 32 incoming edges each.
 * Seed 0's first 16 outgoing edges reach A0..A15; every other edge lands in an
 * overlapping 64-node pool Q, so the same unknown ids recur. A nodes also point
 * into Q, which a 2-hop walk reaches.
 */
function dense(q: (i: number) => Partial<Node>, a: (i: number) => Partial<Node> = () => ({})) {
	const g = graph();
	const seeds = Array.from({ length: 12 }, (_, s) => g.node(`S${s}`));
	const A = Array.from({ length: 16 }, (_, i) => g.node(`A${i}`, a(i)));
	const Q = Array.from({ length: 64 }, (_, i) => g.node(`Q${i}`, q(i)));
	for (const [si, s] of seeds.entries()) {
		for (let j = 0; j < 32; j++) g.rel(s, si === 0 && j < 16 ? A[j]! : Q[(si * 5 + j) % 64]!);
		for (let j = 0; j < 32; j++) g.rel(Q[(si * 7 + j + 11) % 64]!, s);
	}
	for (const [ai, node] of A.entries()) {
		for (let j = 0; j < 32; j++) g.rel(node, Q[(ai * 3 + j) % 64]!);
	}
	return { g, seeds };
}

describe('expandNeighbors read budget (#921)', () => {
	it.each([1, 2])(
		'dense all-eligible fixture, %i hop(s): hydrates only the 16 accepted neighbours',
		async (hops) => {
			const { g, seeds } = dense(() => ({}));
			const { res, totalGets } = await g.run({
				seedIds: seeds,
				scope: 'org-wide',
				hops,
				neighborBudget: 16,
			});

			expect(res.neighbors).toHaveLength(16);
			// Was 768 (1 hop) / 1,280 (2 hops): every unknown id was read before
			// the full-budget check.
			expect(totalGets).toBe(16);
			expect(res.truncated).toBe(false);
		}
	);

	it.each([1, 2])(
		'mostly-expired fixture, %i hop(s): each rejected id is read once and total reads stay within budget',
		async (hops) => {
			const { g, seeds } = dense(
				(i) => (i % 16 === 0 ? {} : { expiresAt: 1 }),
				(i) => (i % 4 === 0 ? {} : { expiresAt: 1 })
			);
			const { res, gets, totalGets } = await g.run({
				seedIds: seeds,
				scope: 'org-wide',
				hops,
				neighborBudget: 16,
			});

			expect(Math.max(...gets.values())).toBe(1);
			expect(totalGets).toBeLessThanOrEqual(64); // max(32, 4 × neighborBudget)
			expect(res.truncated).toBe(true);
			const emitted = [
				...res.neighbors.map((n) => n.id),
				...res.edges.flatMap((e) => [e.fromId, e.toId]),
			];
			expect(emitted.filter((id) => g.nodes.get(id)?.expiresAt !== undefined)).toEqual([]);
		}
	);

	it.each([1, 2])(
		'mixed-scope fixture, %i hop(s): no out-of-scope node or edge, rejected nodes are never a frontier',
		async (hops) => {
			const { g, seeds } = dense(
				(i) =>
					[{ contactIds: ['cA'] }, { contactIds: ['cB'] }, { contactIds: ['cB', 'cC'] }, {}][
						i % 4
					]!,
				(i) => [{ contactIds: ['cA'] }, { contactIds: ['cB'] }, {}][i % 3]!
			);
			const { res, gets, totalGets, edgeQueriesFor } = await g.run({
				seedIds: seeds,
				scope: 'cA',
				hops,
				neighborBudget: 16,
			});
			const hidden = (id: string) => {
				const c = g.nodes.get(id)?.contactIds;
				return !!c && c.length > 0 && !c.includes('cA');
			};

			expect(res.neighbors).toHaveLength(16);
			const emitted = [
				...res.neighbors.map((n) => n.id),
				...res.edges.flatMap((e) => [e.fromId, e.toId]),
			];
			expect(emitted.filter(hidden)).toEqual([]);
			expect([...edgeQueriesFor].filter(hidden)).toEqual([]);
			expect(Math.max(...gets.values())).toBe(1);
			expect(totalGets).toBeLessThanOrEqual(64);
		}
	);

	it('keeps recording edges among visible nodes after the neighbour budget is full', async () => {
		const g = graph();
		const s0 = g.node('S0');
		const s1 = g.node('S1');
		const n0 = g.node('N0');
		const n1 = g.node('N1');
		g.rel(s0, n0);
		g.rel(s0, n1); // unknown once the budget (1) is full: skipped, never read
		g.rel(s1, n0); // visible-to-visible: still recorded
		g.rel(s1, s0);

		const { res, gets } = await g.run({
			seedIds: [s0, s1],
			scope: 'org-wide',
			hops: 1,
			neighborBudget: 1,
		});

		expect(res.neighbors.map((n) => n.id)).toEqual([n0]);
		expect(gets.has(n1)).toBe(false);
		expect(res.edges.map((e) => `${e.fromId}>${e.toId}`).sort()).toEqual([
			'S0>N0',
			'S1>N0',
			'S1>S0',
		]);
		expect(res.truncated).toBe(false);
	});
});
