<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import ArchRoadmapPhase from '../diagrams/ArchRoadmapPhase.vue';
import { phases } from '../../utils/diagrams/archRoadmap';

const visible = ref(false);
const expandedId = ref<number>(0);

onMounted(() => {
	requestAnimationFrame(() => {
		visible.value = true;
	});
});

function expand(id: number) {
	expandedId.value = id;
}
</script>

<template>
	<div class="rm" :class="{ 'is-visible': visible }">
		<div class="rm-container" role="region" aria-label="Product roadmap">
			<div class="rm-label">
				<span class="rm-label-tag">Roadmap</span>
				<span class="rm-label-sub">What ships and when</span>
			</div>

			<!-- The runway -->
			<div class="rm-runway">
				<ArchRoadmapPhase
					v-for="(phase, i) in phases"
					:key="phase.id"
					:phase="phase"
					:index="i"
					:expanded="expandedId === phase.id"
					@expand="expand"
				/>
			</div>
		</div>
	</div>
</template>

<style scoped>
.rm {
	margin: 2rem 0;
}

/* ── Container ── */
.rm-container {
	border: 1px solid var(--color-border-default);
	border-radius: 12px;
	background: var(--color-bg-elevated);
	padding: 40px 0 0;
	overflow: hidden;
	position: relative;
	opacity: 0;
	transform: translateY(12px);
	transition:
		opacity 0.6s var(--ease-spring),
		transform 0.6s var(--ease-spring),
		border-color var(--motion-moderate);
}

.rm-container::before {
	content: '';
	position: absolute;
	inset: 0;
	background:
		radial-gradient(ellipse at 0% 40%, rgba(196, 120, 90, 0.06) 0%, transparent 50%),
		radial-gradient(ellipse at 100% 60%, rgba(122, 155, 110, 0.04) 0%, transparent 50%);
	pointer-events: none;
}

.is-visible .rm-container {
	opacity: 1;
	transform: translateY(0);
}

.rm-container:hover {
	border-color: var(--color-border-strong);
}

.rm-label {
	position: absolute;
	top: 12px;
	left: 14px;
	display: flex;
	align-items: center;
	gap: 8px;
	z-index: 3;
}

.rm-label-tag {
	font-size: 0.6875rem;
	font-weight: 700;
	padding: 2px 8px;
	border-radius: 4px;
	background: color-mix(in oklab, var(--color-brand) 10%, var(--color-bg-surface));
	border: 1px solid color-mix(in oklab, var(--color-brand) 18%, var(--color-border-subtle));
	color: var(--color-brand);
}

.rm-label-sub {
	font-size: 0.625rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
}

/* ── Runway: the horizontal phase strip ── */
.rm-runway {
	display: flex;
	align-items: stretch;
	min-height: 0;
}

/* ── Responsive ── */
@media (max-width: 700px) {
	.rm-runway {
		flex-direction: column;
	}
}

/* ── Reduced motion ── */
@media (prefers-reduced-motion: reduce) {
	*,
	*::before,
	*::after {
		transition-duration: 0.01ms !important;
		animation-duration: 0.01ms !important;
		animation-iteration-count: 1 !important;
	}
}
</style>
