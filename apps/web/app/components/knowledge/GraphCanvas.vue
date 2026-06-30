<script setup lang="ts">
/**
 * <KnowledgeGraphCanvas> — a read-only force-directed knowledge-graph viewer.
 *
 * Plain SVG (matching the custom-SVG `agent/MetricChart.vue`) laid out by a
 * d3-force simulation (no charting/WebGL lib). Edge styling is keyed on the
 * pre-computed `lineStyle` (solid extracted / dashed inferred / faint ambiguous);
 * god nodes are larger and ringed. All data prep (degree, radius, line style) is
 * done by the pure `prepareGraphModel` helper upstream — this component only runs
 * the physics sim and paints. Emits `nodeClick(id)` on node press.
 */
import { onBeforeUnmount, watch } from 'vue';
import {
	forceSimulation,
	forceLink,
	forceManyBody,
	forceCenter,
	forceCollide,
	type Simulation,
	type SimulationNodeDatum,
	type SimulationLinkDatum,
} from 'd3-force';
import type { GraphNodeModel, GraphEdgeModel } from '~/utils/knowledgeGraphLayout';
import { entryTypeIcon } from '~/utils/knowledgeEntryTypes';

const props = defineProps<{
	nodes: GraphNodeModel[];
	edges: GraphEdgeModel[];
	selectedId?: string | null;
}>();

const emit = defineEmits<{ nodeClick: [id: string] }>();

// Fixed coordinate space; the SVG scales to its container via viewBox.
const WIDTH = 760;
const HEIGHT = 520;

interface SimNode extends SimulationNodeDatum {
	id: string;
	radius: number;
}
type SimLink = SimulationLinkDatum<SimNode> & { id: string };

// Positions written by the sim, keyed by node id. Deterministic circular fallback
// keeps SSR/first-paint stable before the client sim runs (avoids a hydration jump
// to NaN positions). shallowRef + manual reassignment so each tick is one update.
const positions = shallowRef<Record<string, { x: number; y: number }>>({});

let sim: Simulation<SimNode, SimLink> | null = null;

/** Deterministic ring position used until the sim assigns a real one. */
function fallbackPosition(index: number, total: number): { x: number; y: number } {
	if (total <= 1) return { x: WIDTH / 2, y: HEIGHT / 2 };
	const angle = (index / total) * Math.PI * 2;
	const r = Math.min(WIDTH, HEIGHT) * 0.33;
	return { x: WIDTH / 2 + Math.cos(angle) * r, y: HEIGHT / 2 + Math.sin(angle) * r };
}

const layout = computed(() =>
	props.nodes.map((n, i) => {
		const pos = positions.value[n.id] ?? fallbackPosition(i, props.nodes.length);
		return { ...n, x: pos.x, y: pos.y };
	}),
);

const layoutById = computed(() => {
	const map = new Map<string, (typeof layout.value)[number]>();
	for (const n of layout.value) map.set(n.id, n);
	return map;
});

const edgeLines = computed(() =>
	props.edges
		.map((e) => {
			const a = layoutById.value.get(e.fromId);
			const b = layoutById.value.get(e.toId);
			if (!a || !b) return null;
			return { edge: e, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
		})
		.filter((v): v is NonNullable<typeof v> => v !== null),
);

/** stroke-dasharray for an edge line style. */
function dashArray(style: GraphEdgeModel['lineStyle']): string | undefined {
	if (style === 'dashed') return '6 4';
	if (style === 'faint') return '2 5';
	return undefined; // solid
}
function edgeOpacity(e: GraphEdgeModel): number {
	if (e.dimmed) return 0.08;
	return e.lineStyle === 'faint' ? 0.3 : 0.55;
}

function buildSimulation(): void {
	if (sim) {
		sim.stop();
		sim = null;
	}
	if (props.nodes.length === 0) {
		positions.value = {};
		return;
	}
	const simNodes: SimNode[] = props.nodes.map((n, i) => {
		const start = fallbackPosition(i, props.nodes.length);
		return { id: n.id, radius: n.radius, x: start.x, y: start.y };
	});
	const byId = new Map(simNodes.map((n) => [n.id, n]));
	const simLinks: SimLink[] = props.edges
		.filter((e) => byId.has(e.fromId) && byId.has(e.toId))
		.map((e) => ({ id: e.id, source: e.fromId, target: e.toId }));

	sim = forceSimulation(simNodes)
		.force(
			'link',
			forceLink<SimNode, SimLink>(simLinks)
				.id((d) => d.id)
				.distance(90)
				.strength(0.4),
		)
		.force('charge', forceManyBody<SimNode>().strength(-280))
		.force('center', forceCenter(WIDTH / 2, HEIGHT / 2))
		.force('collide', forceCollide<SimNode>().radius((d) => d.radius + 8))
		.alpha(1)
		.alphaDecay(0.045);

	const publish = (): void => {
		const next: Record<string, { x: number; y: number }> = {};
		for (const n of simNodes) {
			// Keep nodes inside the viewport with a margin equal to their radius.
			const x = Math.max(n.radius, Math.min(WIDTH - n.radius, n.x ?? WIDTH / 2));
			const y = Math.max(n.radius, Math.min(HEIGHT - n.radius, n.y ?? HEIGHT / 2));
			next[n.id] = { x, y };
		}
		positions.value = next;
	};
	sim.on('tick', publish);
	sim.on('end', publish);
}

onMounted(() => {
	buildSimulation();
});

// Rebuild when the graph identity changes (new subgraph / filter re-seed).
watch(
	() => props.nodes.map((n) => n.id).join('|') + '::' + props.edges.map((e) => e.id).join('|'),
	() => {
		if (import.meta.client) buildSimulation();
	},
);

onBeforeUnmount(() => {
	sim?.stop();
	sim = null;
});
</script>

<template>
	<div class="relative w-full rounded-xl border border-border-subtle bg-bg-elevated overflow-hidden">
		<div
			v-if="nodes.length === 0"
			class="flex flex-col items-center justify-center py-20 text-center"
		>
			<div class="w-12 h-12 rounded-full bg-bg-surface flex items-center justify-center mb-3">
				<Icon name="lucide:share-2" class="w-6 h-6 text-text-tertiary" />
			</div>
			<p class="text-sm text-text-secondary">No connected knowledge to display.</p>
			<p class="text-xs text-text-tertiary mt-1">Link entries to build out the graph.</p>
		</div>

		<svg
			v-else
			:viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
			class="w-full"
			:style="{ height: '520px' }"
			role="img"
			aria-label="Knowledge graph"
		>
			<!-- Edges -->
			<g>
				<line
					v-for="line in edgeLines"
					:key="line.edge.id"
					:x1="line.x1"
					:y1="line.y1"
					:x2="line.x2"
					:y2="line.y2"
					stroke="currentColor"
					class="text-text-tertiary"
					:stroke-width="line.edge.lineStyle === 'faint' ? 1 : 1.5"
					:stroke-dasharray="dashArray(line.edge.lineStyle)"
					:opacity="edgeOpacity(line.edge)"
				/>
			</g>

			<!-- Nodes -->
			<g>
				<g
					v-for="node in layout"
					:key="node.id"
					:transform="`translate(${node.x}, ${node.y})`"
					class="cursor-pointer"
					:opacity="node.dimmed ? 0.2 : 1"
					@click="emit('nodeClick', node.id)"
				>
					<title>{{ node.title }}</title>
					<!-- God-node ring -->
					<circle
						v-if="node.isGod"
						:r="node.radius + 4"
						fill="none"
						stroke="currentColor"
						class="text-brand"
						stroke-width="1.5"
						opacity="0.6"
					/>
					<!-- Selection ring -->
					<circle
						v-if="selectedId === node.id"
						:r="node.radius + 7"
						fill="none"
						stroke="currentColor"
						class="text-brand"
						stroke-width="2"
					/>
					<circle
						:r="node.radius"
						class="text-brand-subtle"
						fill="currentColor"
						:stroke="node.isGod ? 'var(--color-brand)' : 'var(--color-border-subtle)'"
						stroke-width="1.5"
					/>
					<foreignObject
						:x="-(node.radius - 2)"
						:y="-(node.radius - 2)"
						:width="(node.radius - 2) * 2"
						:height="(node.radius - 2) * 2"
						class="pointer-events-none"
					>
						<div class="w-full h-full flex items-center justify-center text-brand">
							<Icon
								:name="entryTypeIcon(node.entryType)"
								:style="{ width: `${Math.max(10, node.radius)}px`, height: `${Math.max(10, node.radius)}px` }"
							/>
						</div>
					</foreignObject>
					<!-- Label for god nodes / the selected node only (keeps the canvas legible) -->
					<text
						v-if="node.isGod || selectedId === node.id"
						:y="node.radius + 13"
						text-anchor="middle"
						class="fill-text-secondary pointer-events-none"
						font-size="10"
					>
						{{ node.title.length > 22 ? node.title.slice(0, 21) + '…' : node.title }}
					</text>
				</g>
			</g>
		</svg>
	</div>
</template>
