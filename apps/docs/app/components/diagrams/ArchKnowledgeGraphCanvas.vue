<script setup lang="ts">
/**
 * The knowledge subgraph of `ArchKnowledgeGraph`: edges, nodes and their
 * cards. Owns the hover state; hovering a node dims everything it is not
 * linked to.
 *
 * The entrance and ambient rules key off the parent's `.is-visible`; scoped CSS only
 * scopes the last selector part, so that ancestor class still matches.
 */
import { ref, computed } from 'vue';
import { edges, nodes, typeConfig } from '../../utils/diagrams/archKnowledgeGraph';

const activeNode = ref<number | null>(null);

function isEdgeHighlighted(edge: { from: number; to: number }) {
	if (activeNode.value === null) return false;
	return edge.from === activeNode.value || edge.to === activeNode.value;
}

const edgeLines = computed(() =>
	edges.flatMap((edge, i) => {
		const from = nodes[edge.from];
		const to = nodes[edge.to];
		if (!from || !to) return [];
		return [{ i, edge, x1: from.x, y1: from.y, x2: to.x, y2: to.y }];
	})
);

function isNodeConnected(nodeId: number) {
	if (activeNode.value === null) return true;
	if (nodeId === activeNode.value) return true;
	return edges.some(
		(e) =>
			(e.from === activeNode.value && e.to === nodeId) ||
			(e.to === activeNode.value && e.from === nodeId)
	);
}
</script>

<template>
	<div class="kg-graph" :style="{ '--stagger': 0 }" @mouseleave="activeNode = null">
		<div class="kg-graph-label">
			<span class="kg-graph-label-tag">Sarah Chen</span>
			<span class="kg-graph-label-sub">Knowledge subgraph</span>
		</div>

		<!-- SVG edges -->
		<svg class="kg-edges" viewBox="0 0 100 100" preserveAspectRatio="none">
			<line
				v-for="line in edgeLines"
				:key="line.i"
				:x1="line.x1"
				:y1="line.y1"
				:x2="line.x2"
				:y2="line.y2"
				class="kg-edge"
				:class="{
					'is-highlighted': isEdgeHighlighted(line.edge),
					'is-dimmed': activeNode !== null && !isEdgeHighlighted(line.edge),
				}"
				:style="{ '--edge-i': line.i }"
			/>
		</svg>

		<!-- Nodes -->
		<div
			v-for="(node, i) in nodes"
			:key="node.id"
			class="kg-node"
			:class="[
				`kg-node--${node.type}`,
				{
					'is-active': activeNode === node.id,
					'is-dimmed': activeNode !== null && !isNodeConnected(node.id),
					'kg-node--flip': node.x > 55,
					'kg-node--below': node.x > 35 && node.x < 65 && node.y > 40,
					'kg-node--bottom': node.y > 75,
				},
			]"
			:style="{ left: `${node.x}%`, top: `${node.y}%`, '--i': i }"
			@mouseenter="activeNode = node.id"
		>
			<div class="kg-node-dot" />
			<div class="kg-node-card">
				<div class="kg-node-type">
					<svg
						width="10"
						height="10"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path :d="typeConfig[node.type].icon" />
					</svg>
					<span>{{ typeConfig[node.type].label }}</span>
				</div>
				<span class="kg-node-label">{{ node.label }}</span>
				<span class="kg-node-detail">{{ node.detail }}</span>
			</div>
		</div>
	</div>
</template>

<style scoped>
/* ── Graph visualization ── */
.kg-graph {
	position: relative;
	border: 1px solid var(--color-border-default);
	border-radius: 12px;
	background: var(--color-bg-elevated);
	padding: 40px 16px 16px;
	aspect-ratio: 5 / 3;
	overflow: hidden;
	opacity: 0;
	transform: translateY(12px);
	transition:
		opacity 0.6s var(--ease-spring),
		transform 0.6s var(--ease-spring),
		border-color var(--motion-moderate);
	transition-delay: calc(var(--stagger) * 0.12s);
}

.kg-graph::before {
	content: '';
	position: absolute;
	inset: 0;
	background:
		radial-gradient(ellipse at 30% 25%, rgba(196, 120, 90, 0.04) 0%, transparent 50%),
		radial-gradient(ellipse at 70% 70%, rgba(212, 165, 116, 0.03) 0%, transparent 50%);
	pointer-events: none;
}

.is-visible .kg-graph {
	opacity: 1;
	transform: translateY(0);
}

.kg-graph:hover {
	border-color: var(--color-border-strong);
}

.kg-graph-label {
	position: absolute;
	top: 12px;
	left: 14px;
	display: flex;
	align-items: center;
	gap: 8px;
	z-index: 2;
}

.kg-graph-label-tag {
	font-size: 0.6875rem;
	font-weight: 700;
	padding: 2px 8px;
	border-radius: 4px;
	background: color-mix(in oklab, var(--color-brand) 10%, var(--color-bg-surface));
	border: 1px solid color-mix(in oklab, var(--color-brand) 18%, var(--color-border-subtle));
	color: var(--color-brand);
}

.kg-graph-label-sub {
	font-size: 0.625rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
}

/* ── SVG edges ── */
.kg-edges {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	z-index: 0;
	pointer-events: none;
}

.kg-edge {
	stroke: var(--color-border-default);
	stroke-width: 0.3;
	opacity: 0;
	transition:
		stroke var(--motion-moderate),
		opacity var(--motion-moderate),
		stroke-width var(--motion-moderate);
}

.is-visible .kg-edge {
	opacity: 0.6;
	animation: edge-draw 0.5s var(--ease-spring) both;
	animation-delay: calc(0.4s + var(--edge-i) * 0.06s);
}

.kg-edge.is-highlighted {
	stroke: var(--color-brand);
	stroke-width: 0.5;
	opacity: 1;
}

.kg-edge.is-dimmed {
	opacity: 0.15;
}

@keyframes edge-draw {
	from {
		stroke-dasharray: 200;
		stroke-dashoffset: 200;
	}
	to {
		stroke-dasharray: 200;
		stroke-dashoffset: 0;
	}
}

/* ── Nodes ── */
.kg-node {
	position: absolute;
	transform: translate(-50%, -50%);
	z-index: 1;
	display: flex;
	align-items: center;
	gap: 0;
	cursor: default;
	opacity: 0;
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		filter var(--motion-moderate);
	animation: none;
}

.is-visible .kg-node {
	opacity: 1;
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		filter var(--motion-moderate);
	animation: node-enter 0.5s var(--ease-spring) both;
	animation-delay: calc(0.3s + var(--i) * 0.08s);
}

.kg-node.is-dimmed {
	opacity: 0.25;
	filter: grayscale(0.5);
}

@keyframes node-enter {
	from {
		transform: translate(-50%, -50%) scale(0.7);
		opacity: 0;
	}
	to {
		transform: translate(-50%, -50%) scale(1);
		opacity: 1;
	}
}

.kg-node-dot {
	width: 10px;
	height: 10px;
	border-radius: 50%;
	flex-shrink: 0;
	border: 2px solid var(--color-bg-elevated);
	transition:
		box-shadow var(--motion-moderate),
		transform var(--motion-moderate);
	position: absolute;
	left: 50%;
	top: 50%;
	transform: translate(-50%, -50%);
	z-index: 2;
}

.kg-node--fact .kg-node-dot {
	background: var(--color-brand);
}
.kg-node--decision .kg-node-dot {
	background: var(--color-accent);
}
.kg-node--event .kg-node-dot {
	background: var(--color-info);
}
.kg-node--preference .kg-node-dot {
	background: var(--color-warning);
}
.kg-node--goal .kg-node-dot {
	background: var(--color-success);
}

.kg-node.is-active .kg-node-dot {
	transform: translate(-50%, -50%) scale(1.3);
}

.kg-node--fact.is-active .kg-node-dot {
	box-shadow: 0 0 10px rgba(196, 120, 90, 0.4);
}
.kg-node--decision.is-active .kg-node-dot {
	box-shadow: 0 0 10px rgba(212, 165, 116, 0.4);
}
.kg-node--event.is-active .kg-node-dot {
	box-shadow: 0 0 10px rgba(107, 143, 168, 0.4);
}
.kg-node--preference.is-active .kg-node-dot {
	box-shadow: 0 0 10px rgba(201, 165, 90, 0.4);
}
.kg-node--goal.is-active .kg-node-dot {
	box-shadow: 0 0 10px rgba(122, 155, 110, 0.4);
}

/* Node card tooltip */
.kg-node-card {
	position: absolute;
	left: 14px;
	top: 50%;
	transform: translateY(-50%);
	display: flex;
	flex-direction: column;
	gap: 0;
	padding: 4px 8px;
	border-radius: 6px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	white-space: nowrap;
	pointer-events: none;
	opacity: 0.85;
	transition:
		opacity var(--motion-moderate),
		border-color var(--motion-moderate),
		box-shadow var(--motion-moderate);
	max-width: 170px;
}

.kg-node.is-active .kg-node-card {
	opacity: 1;
	border-color: var(--color-border-default);
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
}

.kg-node-type {
	display: flex;
	align-items: center;
	gap: 3px;
	font-size: 0.5625rem;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.06em;
}

.kg-node--fact .kg-node-type {
	color: var(--color-brand);
}
.kg-node--decision .kg-node-type {
	color: var(--color-accent);
}
.kg-node--event .kg-node-type {
	color: var(--color-info);
}
.kg-node--preference .kg-node-type {
	color: var(--color-warning);
}
.kg-node--goal .kg-node-type {
	color: var(--color-success);
}

.kg-node-label {
	font-weight: var(--font-weight-semibold);
	font-size: 0.6875rem;
	color: var(--color-text-primary);
	line-height: 1.3;
}

.kg-node-detail {
	font-size: 0.5625rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
}

/* Flip cards on the right side to avoid overflow */
.kg-node--flip .kg-node-card {
	left: auto;
	right: 14px;
}

/* Center nodes show card below the dot */
.kg-node--below .kg-node-card {
	left: 50%;
	top: 16px;
	transform: translateX(-50%);
}

/* Bottom-edge nodes show card above */
.kg-node--bottom .kg-node-card {
	top: auto;
	bottom: 16px;
	transform: translateY(0);
}

.kg-node--bottom.kg-node--flip .kg-node-card {
	left: auto;
	right: 14px;
}

/* ── Ambient ── */
.is-visible .kg-node-dot {
	animation: dot-pulse 3s ease-in-out infinite;
	animation-delay: calc(var(--i) * 0.5s + 1.5s);
}

@keyframes dot-pulse {
	0%,
	100% {
		box-shadow: none;
	}
	50% {
		box-shadow: 0 0 6px 1px rgba(196, 120, 90, 0.2);
	}
}
</style>
