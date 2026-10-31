<script setup lang="ts">
/**
 * One detail panel of `::arch-agent-pipeline`: the step's header, its
 * step-specific body (`ArchAgentPipelineStepBody`) and the example output.
 * All panels share one grid cell; only the active one is visible.
 */
import type { AgentPipelineStep } from '../../utils/archAgentPipeline';

defineProps<{
	step: AgentPipelineStep;
	active: boolean;
}>();
</script>

<template>
	<div class="pipe-panel" :class="[`pipe-panel--${step.color}`, { 'is-active': active }]">
		<div class="pipe-panel-header">
			<div class="pipe-panel-icon" :class="`pipe-panel-icon--${step.color}`">
				<svg
					width="20"
					height="20"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path :d="step.icon" />
				</svg>
			</div>
			<div class="pipe-panel-title-group">
				<span class="pipe-panel-title">{{ step.name }}</span>
				<span class="pipe-panel-subtitle">{{ step.detail }}</span>
			</div>
		</div>

		<ArchAgentPipelineStepBody :step="step" />

		<!-- Example output (all steps) -->
		<div class="pipe-panel-example">
			<svg
				width="12"
				height="12"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path d="M13 10V3L4 14h7v7l9-11h-7z" />
			</svg>
			<span>{{ step.example }}</span>
		</div>
	</div>
</template>

<style scoped>
.pipe-panel {
	grid-area: 1 / 1;
	border: 1px solid var(--color-border-default);
	border-radius: 10px;
	background: var(--color-bg-elevated);
	padding: 16px;
	position: relative;
	overflow: hidden;
	visibility: hidden;
	opacity: 0;
	transform: translateY(6px);
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring),
		visibility 0s var(--motion-moderate),
		border-color var(--motion-moderate),
		box-shadow var(--motion-moderate);
}

.pipe-panel.is-active {
	visibility: visible;
	opacity: 1;
	transform: translateY(0);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring),
		visibility 0s,
		border-color var(--motion-moderate),
		box-shadow var(--motion-moderate);
}

.pipe-panel::before {
	content: '';
	position: absolute;
	inset: 0;
	pointer-events: none;
	opacity: 0.6;
}

.pipe-panel--accent::before {
	background: radial-gradient(ellipse at 20% 30%, rgba(212, 165, 116, 0.05) 0%, transparent 60%);
}
.pipe-panel--info::before {
	background: radial-gradient(ellipse at 20% 30%, rgba(107, 143, 168, 0.05) 0%, transparent 60%);
}
.pipe-panel--warning::before {
	background: radial-gradient(ellipse at 20% 30%, rgba(201, 165, 90, 0.05) 0%, transparent 60%);
}
.pipe-panel--brand::before {
	background: radial-gradient(ellipse at 20% 30%, rgba(196, 120, 90, 0.05) 0%, transparent 60%);
}
.pipe-panel--success::before {
	background: radial-gradient(ellipse at 20% 30%, rgba(122, 155, 110, 0.05) 0%, transparent 60%);
}

.pipe-panel--accent {
	border-color: color-mix(in oklab, var(--color-accent) 20%, var(--color-border-default));
}
.pipe-panel--info {
	border-color: color-mix(in oklab, var(--color-info) 20%, var(--color-border-default));
}
.pipe-panel--warning {
	border-color: color-mix(in oklab, var(--color-warning) 20%, var(--color-border-default));
}
.pipe-panel--brand {
	border-color: color-mix(in oklab, var(--color-brand) 20%, var(--color-border-default));
}
.pipe-panel--success {
	border-color: color-mix(in oklab, var(--color-success) 20%, var(--color-border-default));
}

.pipe-panel.is-active:hover {
	box-shadow: 0 4px 20px rgba(0, 0, 0, 0.12);
}

/* Panel header */
.pipe-panel-header {
	display: flex;
	align-items: center;
	gap: 10px;
	margin-bottom: 12px;
	position: relative;
}

.pipe-panel-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 34px;
	height: 34px;
	border-radius: 8px;
	flex-shrink: 0;
	transition: box-shadow var(--motion-moderate);
}

.pipe-panel-icon--accent {
	background: color-mix(in oklab, var(--color-accent) 12%, var(--color-bg-surface));
	color: var(--color-accent);
}
.pipe-panel-icon--info {
	background: color-mix(in oklab, var(--color-info) 12%, var(--color-bg-surface));
	color: var(--color-info);
}
.pipe-panel-icon--warning {
	background: color-mix(in oklab, var(--color-warning) 12%, var(--color-bg-surface));
	color: var(--color-warning);
}
.pipe-panel-icon--brand {
	background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
	color: var(--color-brand);
}
.pipe-panel-icon--success {
	background: color-mix(in oklab, var(--color-success) 12%, var(--color-bg-surface));
	color: var(--color-success);
}

.pipe-panel:hover .pipe-panel-icon {
	box-shadow: 0 0 10px rgba(196, 120, 90, 0.1);
}

.pipe-panel-title-group {
	display: flex;
	flex-direction: column;
	gap: 1px;
}

.pipe-panel-title {
	font-weight: var(--font-weight-semibold);
	font-size: 0.9375rem;
	color: var(--color-text-primary);
	letter-spacing: -0.01em;
}

.pipe-panel-subtitle {
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
}

/* ── Example line (bottom of each panel) ── */
.pipe-panel-example {
	display: flex;
	align-items: flex-start;
	gap: 6px;
	padding-top: 10px;
	border-top: 1px solid var(--color-border-subtle);
	position: relative;
}

.pipe-panel-example svg {
	color: var(--color-brand-dim);
	flex-shrink: 0;
	margin-top: 1px;
}

.pipe-panel-example span {
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
	line-height: 1.5;
}
</style>
