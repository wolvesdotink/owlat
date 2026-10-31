<script setup lang="ts">
import { ref, onMounted } from 'vue';
import ArchVerificationQueueItem from '../diagrams/ArchVerificationQueueItem.vue';
import { queueItems, stats } from '../../utils/diagrams/archVerificationQueue';

const visible = ref(false);
onMounted(() => {
	requestAnimationFrame(() => {
		visible.value = true;
	});
});
</script>

<template>
	<div class="vq" :class="{ 'is-visible': visible }">
		<!-- Stats bar -->
		<div class="vq-stats" :style="{ '--stagger': 0 }">
			<div
				v-for="(stat, i) in stats"
				:key="stat.label"
				class="vq-stat"
				:class="`vq-stat--${stat.color}`"
				:style="{ '--i': i }"
			>
				<span class="vq-stat-value">{{ stat.value }}</span>
				<span class="vq-stat-label">{{ stat.label }}</span>
			</div>
		</div>

		<!-- Queue list -->
		<div class="vq-list" :style="{ '--stagger': 1 }">
			<ArchVerificationQueueItem
				v-for="(item, i) in queueItems"
				:key="item.id"
				:item="item"
				:index="i"
			/>
		</div>

		<!-- Confidence legend -->
		<div class="vq-legend" :style="{ '--stagger': 2 }">
			<div class="vq-legend-item">
				<span class="vq-legend-dot vq-legend-dot--high" />
				<span class="vq-legend-label">High confidence</span>
				<span class="vq-legend-desc">— can auto-approve per org policy</span>
			</div>
			<div class="vq-legend-item">
				<span class="vq-legend-dot vq-legend-dot--medium" />
				<span class="vq-legend-label">Medium</span>
				<span class="vq-legend-desc">— human review recommended</span>
			</div>
			<div class="vq-legend-item">
				<span class="vq-legend-dot vq-legend-dot--low" />
				<span class="vq-legend-label">Low</span>
				<span class="vq-legend-desc">— requires human decision</span>
			</div>
		</div>

		<!-- Audit trail note -->
		<div class="vq-audit" :style="{ '--stagger': 3 }">
			<svg
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="1.5"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path
					d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
				/>
			</svg>
			<span
				>Full audit trail — every action logged with provenance: what knowledge was retrieved, what
				reasoning applied, who approved</span
			>
		</div>
	</div>
</template>

<style scoped>
.vq {
	margin: 2rem 0;
	display: flex;
	flex-direction: column;
	gap: 10px;
}

/* ── Stats bar ── */
.vq-stats {
	display: flex;
	gap: 8px;
	opacity: 0;
	transform: translateY(10px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .vq-stats {
	opacity: 1;
	transform: translateY(0);
}

@media (max-width: 480px) {
	.vq-stats {
		flex-direction: column;
	}
}

.vq-stat {
	flex: 1;
	display: flex;
	align-items: baseline;
	gap: 6px;
	padding: 10px 14px;
	border-radius: 8px;
	background: var(--color-bg-elevated);
	border: 1px solid var(--color-border-default);
	opacity: 0;
	transform: translateY(6px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring),
		border-color var(--motion-moderate);
	transition-delay: calc(0.1s + var(--i) * 0.06s);
}

.is-visible .vq-stat {
	opacity: 1;
	transform: translateY(0);
}

.vq-stat:hover {
	border-color: var(--color-border-strong);
	transition-delay: 0s;
}

.vq-stat-value {
	font-weight: 700;
	font-size: 1.125rem;
	letter-spacing: -0.02em;
}

.vq-stat--brand .vq-stat-value {
	color: var(--color-brand);
}
.vq-stat--success .vq-stat-value {
	color: var(--color-success);
}
.vq-stat--info .vq-stat-value {
	color: var(--color-info);
}

.vq-stat-label {
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
}

/* ── Queue list ── */
.vq-list {
	display: flex;
	flex-direction: column;
	gap: 6px;
	opacity: 0;
	transform: translateY(10px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .vq-list {
	opacity: 1;
	transform: translateY(0);
}

/* ── Confidence legend ── */
.vq-legend {
	display: flex;
	flex-wrap: wrap;
	gap: 6px 16px;
	padding: 10px 14px;
	border-radius: 8px;
	background: var(--color-bg-soft);
	border: 1px solid var(--color-border-subtle);
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .vq-legend {
	opacity: 1;
	transform: translateY(0);
}

.vq-legend-item {
	display: flex;
	align-items: center;
	gap: 5px;
}

.vq-legend-dot {
	width: 7px;
	height: 7px;
	border-radius: 50%;
	flex-shrink: 0;
}

.vq-legend-dot--high {
	background: var(--color-success);
}
.vq-legend-dot--medium {
	background: var(--color-warning);
}
.vq-legend-dot--low {
	background: var(--color-error);
}

.vq-legend-label {
	font-size: 0.6875rem;
	font-weight: var(--font-weight-semibold);
	color: var(--color-text-secondary);
}

.vq-legend-desc {
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
}

/* ── Audit trail note ── */
.vq-audit {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 10px 14px;
	border-radius: 8px;
	border: 1px dashed var(--color-border-default);
	background: var(--color-bg-soft);
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .vq-audit {
	opacity: 1;
	transform: translateY(0);
}

.vq-audit svg {
	color: var(--color-brand-muted);
	flex-shrink: 0;
}

.vq-audit span {
	font-size: 0.6875rem;
	color: var(--color-text-secondary);
	line-height: 1.5;
}
</style>
