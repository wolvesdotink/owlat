/**
 * Pure graph-prep + layout helpers for the knowledge-graph dashboard.
 *
 * The d3-force simulation and the SVG live in `components/knowledge/GraphCanvas.vue`
 * (a client-only, hard-to-unit-test surface). Everything deterministic — turning
 * the backend `getSubgraph` payload into display nodes/edges, god-node sizing, and
 * confidence-tag → line-style mapping — is extracted here so it can be unit-tested
 * without mounting a component or running a physics sim.
 *
 * Edge styling is keyed on the edge's `confidenceTag` (schema/knowledge.ts):
 *   - `extracted` — stated directly / human-authored → SOLID line.
 *   - `inferred`  — derived with enough confidence to trust → DASHED line.
 *   - `ambiguous` — derived below the inference floor → FAINT (low-opacity) line.
 */

/** A coarse edge-evidence tag (mirrors backend `EDGE_CONFIDENCE_TAGS`). */
export type EdgeConfidenceTag = 'extracted' | 'inferred' | 'ambiguous';

/** How a confidence tag is drawn on the canvas. */
export type EdgeLineStyle = 'solid' | 'dashed' | 'faint';

/** Node facet shape returned by `api.knowledge.graphAnalytics.getSubgraph`. */
export interface SubgraphNodeInput {
	id: string;
	title: string;
	entryType: string;
	confidence: number;
}

/** Edge facet shape returned by `api.knowledge.graphAnalytics.getSubgraph`. */
export interface SubgraphEdgeInput {
	fromId: string;
	toId: string;
	relationType: string;
	confidence: number;
	/** Coarse evidence tag; optional so derived/legacy edges still map cleanly. */
	confidenceTag?: string;
}

/** A display node: the input plus computed degree, god-node flag, and radius. */
export interface GraphNodeModel {
	id: string;
	title: string;
	entryType: string;
	confidence: number;
	degree: number;
	isGod: boolean;
	radius: number;
	/** Greyed out when an entryType filter is active and this node doesn't match. */
	dimmed: boolean;
}

/** A display edge: the input plus a normalized tag, line style, and dim flag. */
export interface GraphEdgeModel {
	id: string;
	fromId: string;
	toId: string;
	relationType: string;
	confidence: number;
	confidenceTag: EdgeConfidenceTag;
	lineStyle: EdgeLineStyle;
	dimmed: boolean;
}

export interface PrepareGraphOptions {
	nodes: SubgraphNodeInput[];
	edges: SubgraphEdgeInput[];
	/** Entry ids that are graph hubs ("god nodes") — drawn larger and ringed. */
	godNodeIds?: readonly string[];
	/** When set, nodes whose entryType differs are dimmed (and their edges too). */
	entryTypeFilter?: string | null;
}

export interface PreparedGraph {
	nodes: GraphNodeModel[];
	edges: GraphEdgeModel[];
}

// Node-radius tuning. Degree drives growth on a sqrt curve so a hub with 30
// neighbours isn't 30× a leaf; god nodes get a larger floor + bump so they read
// as hubs even at low degree.
const BASE_RADIUS = 7;
const MAX_RADIUS = 22;
const GOD_RADIUS_FLOOR = 15;
const GOD_RADIUS_BONUS = 3;

/**
 * Radius for a node given its degree and whether it is a god node. Pure +
 * monotonic in degree, clamped to [BASE_RADIUS, MAX_RADIUS]. God nodes are
 * guaranteed visibly larger than a degree-0 leaf.
 */
export function nodeRadius(degree: number, isGod: boolean): number {
	const safeDegree = Number.isFinite(degree) && degree > 0 ? degree : 0;
	let r = BASE_RADIUS + Math.sqrt(safeDegree) * 2.4;
	if (isGod) r = Math.max(r, GOD_RADIUS_FLOOR) + GOD_RADIUS_BONUS;
	return Math.min(MAX_RADIUS, r);
}

/**
 * Normalize an edge's stored tag into a known `EdgeConfidenceTag`. When the tag
 * is absent (a derived/legacy edge), fall back to bucketing the numeric
 * confidence so the canvas always has a definite style to draw.
 */
export function coerceConfidenceTag(tag: string | undefined, confidence: number): EdgeConfidenceTag {
	if (tag === 'extracted' || tag === 'inferred' || tag === 'ambiguous') return tag;
	if (confidence >= 0.9) return 'extracted';
	if (confidence >= 0.5) return 'inferred';
	return 'ambiguous';
}

/** Map a confidence tag to its canvas line style. */
export function edgeLineStyle(tag: EdgeConfidenceTag): EdgeLineStyle {
	switch (tag) {
		case 'extracted':
			return 'solid';
		case 'inferred':
			return 'dashed';
		case 'ambiguous':
			return 'faint';
	}
}

/**
 * Turn a raw subgraph payload into the display model the canvas renders:
 *   - per-node degree (counting only edges whose BOTH endpoints are in the node
 *     set, so a capped/partial subgraph can't over-count),
 *   - god-node flag + radius,
 *   - per-edge normalized tag → line style,
 *   - dim flags driven by the optional entryType filter.
 *
 * Edges whose endpoints aren't both present are dropped (a dangling half-edge has
 * nothing to attach to in the force sim).
 */
export function prepareGraphModel(opts: PrepareGraphOptions): PreparedGraph {
	const godSet = new Set(opts.godNodeIds ?? []);
	const filter = opts.entryTypeFilter ?? null;

	const nodeById = new Map<string, SubgraphNodeInput>();
	for (const n of opts.nodes) nodeById.set(n.id, n);

	// Degree = count of valid (both-endpoints-present) incident edges. Self-edges
	// don't occur (backend forbids them) but are counted once defensively.
	const degree = new Map<string, number>();
	const validEdges: SubgraphEdgeInput[] = [];
	for (const e of opts.edges) {
		if (!nodeById.has(e.fromId) || !nodeById.has(e.toId)) continue;
		validEdges.push(e);
		degree.set(e.fromId, (degree.get(e.fromId) ?? 0) + 1);
		if (e.toId !== e.fromId) degree.set(e.toId, (degree.get(e.toId) ?? 0) + 1);
	}

	const nodes: GraphNodeModel[] = opts.nodes.map((n) => {
		const d = degree.get(n.id) ?? 0;
		const isGod = godSet.has(n.id);
		return {
			id: n.id,
			title: n.title,
			entryType: n.entryType,
			confidence: n.confidence,
			degree: d,
			isGod,
			radius: nodeRadius(d, isGod),
			dimmed: filter !== null && n.entryType !== filter,
		};
	});

	const dimmedNodeIds = new Set(nodes.filter((n) => n.dimmed).map((n) => n.id));

	const edges: GraphEdgeModel[] = validEdges.map((e, i) => {
		const tag = coerceConfidenceTag(e.confidenceTag, e.confidence);
		return {
			id: `${e.fromId}->${e.toId}#${i}`,
			fromId: e.fromId,
			toId: e.toId,
			relationType: e.relationType,
			confidence: e.confidence,
			confidenceTag: tag,
			lineStyle: edgeLineStyle(tag),
			dimmed: dimmedNodeIds.has(e.fromId) || dimmedNodeIds.has(e.toId),
		};
	});

	return { nodes, edges };
}

/** A rendered bar in the confidence histogram (one of 10 [0,1] buckets). */
export interface ConfidenceBar {
	/** Bucket index 0-9. */
	index: number;
	/** Human range label, e.g. "0–10%". */
	rangeLabel: string;
	count: number;
	/** Height fraction 0-1 relative to the tallest bucket (for bar rendering). */
	heightFraction: number;
}

/**
 * Turn the snapshot's 10-element `confidenceBuckets` array into renderable bars
 * with range labels and a height fraction normalized to the tallest bucket. Pure
 * so the stats panel's histogram can be asserted without a DOM.
 */
export function confidenceBucketBars(buckets: readonly number[]): ConfidenceBar[] {
	const max = buckets.reduce((m, c) => (c > m ? c : m), 0);
	return buckets.map((count, index) => {
		const lo = index * 10;
		const hi = (index + 1) * 10;
		return {
			index,
			rangeLabel: `${lo}–${hi}%`,
			count,
			heightFraction: max > 0 ? count / max : 0,
		};
	});
}
