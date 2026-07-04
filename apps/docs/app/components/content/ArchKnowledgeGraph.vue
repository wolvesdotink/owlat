<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'

const visible = ref(false)
const activeNode = ref<number | null>(null)

onMounted(() => {
  requestAnimationFrame(() => { visible.value = true })
})

type NodeType = 'fact' | 'decision' | 'event' | 'preference' | 'goal'

interface GraphNode {
  id: number
  type: NodeType
  label: string
  detail: string
  x: number
  y: number
}

const nodes: GraphNode[] = [
  {
    id: 0,
    type: 'fact',
    label: 'Pro Plan',
    detail: 'Customer since 2024',
    x: 42, y: 16,
  },
  {
    id: 1,
    type: 'decision',
    label: 'Billing exception',
    detail: 'Credited $50 on Feb 12',
    x: 12, y: 44,
  },
  {
    id: 2,
    type: 'event',
    label: 'Upgrade to Pro',
    detail: 'January 2025',
    x: 88, y: 28,
  },
  {
    id: 3,
    type: 'preference',
    label: 'Prefers email',
    detail: 'Over phone or chat',
    x: 12, y: 80,
  },
  {
    id: 4,
    type: 'event',
    label: '3 support tickets',
    detail: 'Last 30 days — API rate limits',
    x: 88, y: 72,
  },
  {
    id: 5,
    type: 'goal',
    label: 'Reduce response time',
    detail: 'Target: under 2 hours',
    x: 50, y: 58,
  },
]

const edges = [
  { from: 0, to: 1 },
  { from: 0, to: 2 },
  { from: 0, to: 3 },
  { from: 0, to: 4 },
  { from: 1, to: 2 },
  { from: 2, to: 4 },
  { from: 3, to: 5 },
  { from: 4, to: 5 },
]

const typeConfig: Record<NodeType, { color: string; colorVar: string; icon: string; label: string }> = {
  fact: {
    color: 'brand',
    colorVar: '--color-brand',
    icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
    label: 'Fact',
  },
  decision: {
    color: 'accent',
    colorVar: '--color-accent',
    icon: 'M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4',
    label: 'Decision',
  },
  event: {
    color: 'info',
    colorVar: '--color-info',
    icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
    label: 'Event',
  },
  preference: {
    color: 'warning',
    colorVar: '--color-warning',
    icon: 'M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z',
    label: 'Preference',
  },
  goal: {
    color: 'success',
    colorVar: '--color-success',
    icon: 'M13 7h8m0 0v8m0-8l-8 8-4-4-6 6',
    label: 'Goal',
  },
}

function isEdgeHighlighted(edge: { from: number; to: number }) {
  if (activeNode.value === null) return false
  return edge.from === activeNode.value || edge.to === activeNode.value
}

const edgeLines = computed(() =>
  edges.flatMap((edge, i) => {
    const from = nodes[edge.from]
    const to = nodes[edge.to]
    if (!from || !to) return []
    return [{ i, edge, x1: from.x, y1: from.y, x2: to.x, y2: to.y }]
  }),
)

function isNodeConnected(nodeId: number) {
  if (activeNode.value === null) return true
  if (nodeId === activeNode.value) return true
  return edges.some(
    (e) =>
      (e.from === activeNode.value && e.to === nodeId) ||
      (e.to === activeNode.value && e.from === nodeId),
  )
}

const retrievalMethods = [
  {
    name: 'Semantic Search',
    icon: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
    example: '"billing frustration"',
    detail: 'Vector similarity — finds conceptually related knowledge',
  },
  {
    name: 'Full-text Search',
    icon: 'M4 6h16M4 12h8m-8 6h16',
    example: '"invoice #12345"',
    detail: 'Exact keyword matching for specific records',
  },
  {
    name: 'Graph Traversal',
    icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1',
    example: '"all interactions with Acme Corp"',
    detail: 'Follow relationships across the graph',
  },
]

const briefing = 'Customer X has been on the Pro plan since 2024, upgraded in January. Billing exception granted in February ($50 credit). Prefers email. 3 recent tickets about API rate limits.'
</script>

<template>
  <div class="kg" :class="{ 'is-visible': visible }">

    <!-- Graph visualization -->
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
          :class="{ 'is-highlighted': isEdgeHighlighted(line.edge), 'is-dimmed': activeNode !== null && !isEdgeHighlighted(line.edge) }"
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
          }
        ]"
        :style="{ left: `${node.x}%`, top: `${node.y}%`, '--i': i }"
        @mouseenter="activeNode = node.id"
      >
        <div class="kg-node-dot" />
        <div class="kg-node-card">
          <div class="kg-node-type">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path :d="typeConfig[node.type].icon" /></svg>
            <span>{{ typeConfig[node.type].label }}</span>
          </div>
          <span class="kg-node-label">{{ node.label }}</span>
          <span class="kg-node-detail">{{ node.detail }}</span>
        </div>
      </div>
    </div>

    <!-- Type legend -->
    <div class="kg-types" :style="{ '--stagger': 1 }">
      <div
        v-for="(config, type) in typeConfig"
        :key="type"
        class="kg-type-badge"
        :class="`kg-type-badge--${config.color}`"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path :d="config.icon" /></svg>
        <span>{{ config.label }}</span>
      </div>
    </div>

    <!-- Retrieval methods -->
    <div class="kg-retrieval" :style="{ '--stagger': 2 }">
      <div class="kg-retrieval-header">
        <span class="kg-retrieval-title">Hybrid Retrieval</span>
        <span class="kg-retrieval-sub">Three strategies merged via rank fusion</span>
      </div>
      <div class="kg-retrieval-methods">
        <div
          v-for="(method, i) in retrievalMethods"
          :key="method.name"
          class="kg-method"
          :style="{ '--i': i }"
        >
          <div class="kg-method-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="method.icon" /></svg>
          </div>
          <div class="kg-method-text">
            <span class="kg-method-name">{{ method.name }}</span>
            <span class="kg-method-detail">{{ method.detail }}</span>
          </div>
          <code class="kg-method-example">{{ method.example }}</code>
        </div>
      </div>
    </div>

    <!-- Synthesized briefing -->
    <div class="kg-briefing" :style="{ '--stagger': 3 }">
      <div class="kg-briefing-header">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
        <span class="kg-briefing-title">Synthesized briefing</span>
        <span class="kg-briefing-sub">What the agent actually receives — not a raw dump</span>
      </div>
      <div class="kg-briefing-body">
        <p>{{ briefing }}</p>
      </div>
    </div>

  </div>
</template>

<style scoped>
.kg {
  margin: 2rem 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

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
  transition: opacity 0.6s var(--ease-spring), transform 0.6s var(--ease-spring), border-color var(--motion-moderate);
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
  transition: stroke var(--motion-moderate), opacity var(--motion-moderate), stroke-width var(--motion-moderate);
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
  from { stroke-dasharray: 200; stroke-dashoffset: 200; }
  to { stroke-dasharray: 200; stroke-dashoffset: 0; }
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
  transition: opacity var(--motion-slow) var(--ease-spring), filter var(--motion-moderate);
  animation: none;
}

.is-visible .kg-node {
  opacity: 1;
  transition: opacity var(--motion-slow) var(--ease-spring), filter var(--motion-moderate);
  animation: node-enter 0.5s var(--ease-spring) both;
  animation-delay: calc(0.3s + var(--i) * 0.08s);
}

.kg-node.is-dimmed {
  opacity: 0.25;
  filter: grayscale(0.5);
}

@keyframes node-enter {
  from { transform: translate(-50%, -50%) scale(0.7); opacity: 0; }
  to { transform: translate(-50%, -50%) scale(1); opacity: 1; }
}

.kg-node-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  border: 2px solid var(--color-bg-elevated);
  transition: box-shadow var(--motion-moderate), transform var(--motion-moderate);
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 2;
}

.kg-node--fact .kg-node-dot { background: var(--color-brand); }
.kg-node--decision .kg-node-dot { background: var(--color-accent); }
.kg-node--event .kg-node-dot { background: var(--color-info); }
.kg-node--preference .kg-node-dot { background: var(--color-warning); }
.kg-node--goal .kg-node-dot { background: var(--color-success); }

.kg-node.is-active .kg-node-dot {
  transform: translate(-50%, -50%) scale(1.3);
}

.kg-node--fact.is-active .kg-node-dot { box-shadow: 0 0 10px rgba(196, 120, 90, 0.4); }
.kg-node--decision.is-active .kg-node-dot { box-shadow: 0 0 10px rgba(212, 165, 116, 0.4); }
.kg-node--event.is-active .kg-node-dot { box-shadow: 0 0 10px rgba(107, 143, 168, 0.4); }
.kg-node--preference.is-active .kg-node-dot { box-shadow: 0 0 10px rgba(201, 165, 90, 0.4); }
.kg-node--goal.is-active .kg-node-dot { box-shadow: 0 0 10px rgba(122, 155, 110, 0.4); }

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
  transition: opacity var(--motion-moderate), border-color var(--motion-moderate), box-shadow var(--motion-moderate);
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

.kg-node--fact .kg-node-type { color: var(--color-brand); }
.kg-node--decision .kg-node-type { color: var(--color-accent); }
.kg-node--event .kg-node-type { color: var(--color-info); }
.kg-node--preference .kg-node-type { color: var(--color-warning); }
.kg-node--goal .kg-node-type { color: var(--color-success); }

.kg-node-label {
  font-weight: 600;
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

/* ── Type legend ── */
.kg-types {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring);
  transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .kg-types {
  opacity: 1;
  transform: translateY(0);
}

.kg-type-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 5px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  font-size: 0.6875rem;
  font-weight: 600;
  transition: border-color var(--motion-moderate);
}

.kg-type-badge:hover {
  border-color: var(--color-border-default);
}

.kg-type-badge--brand { color: var(--color-brand); border-color: color-mix(in oklab, var(--color-brand) 15%, var(--color-border-subtle)); }
.kg-type-badge--brand svg { color: var(--color-brand); }
.kg-type-badge--accent { color: var(--color-accent); border-color: color-mix(in oklab, var(--color-accent) 15%, var(--color-border-subtle)); }
.kg-type-badge--accent svg { color: var(--color-accent); }
.kg-type-badge--info { color: var(--color-info); border-color: color-mix(in oklab, var(--color-info) 15%, var(--color-border-subtle)); }
.kg-type-badge--info svg { color: var(--color-info); }
.kg-type-badge--warning { color: var(--color-warning); border-color: color-mix(in oklab, var(--color-warning) 15%, var(--color-border-subtle)); }
.kg-type-badge--warning svg { color: var(--color-warning); }
.kg-type-badge--success { color: var(--color-success); border-color: color-mix(in oklab, var(--color-success) 15%, var(--color-border-subtle)); }
.kg-type-badge--success svg { color: var(--color-success); }

/* ── Retrieval methods ── */
.kg-retrieval {
  border: 1px solid var(--color-border-default);
  border-radius: 10px;
  background: var(--color-bg-elevated);
  padding: 14px 16px;
  opacity: 0;
  transform: translateY(10px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring), border-color var(--motion-moderate);
  transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .kg-retrieval {
  opacity: 1;
  transform: translateY(0);
}

.kg-retrieval:hover {
  border-color: var(--color-border-strong);
}

.kg-retrieval-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.kg-retrieval-title {
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
}

.kg-retrieval-sub {
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}

.kg-retrieval-methods {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.kg-method {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 7px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  opacity: 0;
  transform: translateX(-6px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring), border-color var(--motion-moderate);
  transition-delay: calc(0.3s + var(--i) * 0.07s);
}

.is-visible .kg-method {
  opacity: 1;
  transform: translateX(0);
}

.kg-method:hover {
  border-color: var(--color-border-default);
  transition-delay: 0s;
}

.kg-method-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: color-mix(in oklab, var(--color-brand) 8%, var(--color-bg-elevated));
  color: var(--color-brand-muted);
  flex-shrink: 0;
}

.kg-method-text {
  display: flex;
  flex-direction: column;
  gap: 0;
  flex: 1;
  min-width: 0;
}

.kg-method-name {
  font-weight: 600;
  font-size: 0.75rem;
  color: var(--color-text-primary);
}

.kg-method-detail {
  font-size: 0.625rem;
  color: var(--color-text-tertiary);
}

.kg-method-example {
  font-size: 0.625rem;
  font-family: var(--font-mono);
  color: var(--color-text-secondary);
  padding: 3px 8px;
  border-radius: 4px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-subtle);
  white-space: nowrap;
  flex-shrink: 0;
}

@media (max-width: 540px) {
  .kg-method {
    flex-wrap: wrap;
  }
  .kg-method-example {
    width: 100%;
  }
}

/* ── Synthesized briefing ── */
.kg-briefing {
  border: 1px solid color-mix(in oklab, var(--color-brand) 20%, var(--color-border-default));
  border-radius: 10px;
  background: var(--color-bg-elevated);
  overflow: hidden;
  opacity: 0;
  transform: translateY(10px);
  transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring), border-color var(--motion-moderate), box-shadow var(--motion-moderate);
  transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .kg-briefing {
  opacity: 1;
  transform: translateY(0);
}

.kg-briefing:hover {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
}

.kg-briefing-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--color-border-subtle);
  background: color-mix(in oklab, var(--color-brand) 3%, var(--color-bg-soft));
}

.kg-briefing-header svg {
  color: var(--color-brand);
  flex-shrink: 0;
}

.kg-briefing-title {
  font-weight: 600;
  font-size: 0.75rem;
  color: var(--color-brand);
}

.kg-briefing-sub {
  font-size: 0.625rem;
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
  margin-left: auto;
}

@media (max-width: 540px) {
  .kg-briefing-sub {
    display: none;
  }
}

.kg-briefing-body {
  padding: 12px 14px;
}

.kg-briefing-body p {
  font-size: 0.8125rem;
  color: var(--color-text-secondary);
  line-height: 1.65;
  margin: 0;
}

/* ── Ambient ── */
.is-visible .kg-node-dot {
  animation: dot-pulse 3s ease-in-out infinite;
  animation-delay: calc(var(--i) * 0.5s + 1.5s);
}

@keyframes dot-pulse {
  0%, 100% { box-shadow: none; }
  50% { box-shadow: 0 0 6px 1px rgba(196, 120, 90, 0.2); }
}


</style>
