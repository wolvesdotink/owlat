<script setup lang="ts">
/**
 * Step-specific body of an `::arch-agent-pipeline` panel, picked by
 * `step.num`: knowledge sources, intent tags, planned actions, the draft
 * preview, or the routing options. The draft cursor blinks once the parent's
 * `.is-visible` root is set.
 */
import type { AgentPipelineStep } from '../../utils/archAgentPipeline';

defineProps<{
	step: AgentPipelineStep;
}>();
</script>

<template>
	<div class="pipe-panel-body">
		<!-- Step 1: Context Retrieval -->
		<div v-if="step.num === 1" class="pipe-sources">
			<div v-for="src in step.sources" :key="src" class="pipe-source">
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
					<path
						d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"
					/>
				</svg>
				<span>{{ src }}</span>
			</div>
		</div>

		<!-- Step 2: Classification -->
		<div v-else-if="step.num === 2" class="pipe-intents">
			<span
				v-for="intent in step.intents"
				:key="intent.label"
				class="pipe-intent"
				:class="{ 'is-active': intent.active }"
				>{{ intent.label }}</span
			>
		</div>

		<!-- Step 3: Action Planning -->
		<div v-else-if="step.num === 3" class="pipe-actions-list">
			<div v-for="(action, ai) in step.actions" :key="action.label" class="pipe-action-item">
				<span class="pipe-action-num">{{ ai + 1 }}</span>
				<span class="pipe-action-label">{{ action.label }}</span>
				<span class="pipe-action-type" :class="`pipe-action-type--${action.type}`">{{
					action.type
				}}</span>
			</div>
		</div>

		<!-- Step 4: Draft Generation -->
		<div v-else-if="step.num === 4" class="pipe-draft">
			<div class="pipe-draft-header">
				<span class="pipe-draft-subject">{{ step.draft?.subject }}</span>
			</div>
			<div class="pipe-draft-body">
				<span class="pipe-draft-preview">{{ step.draft?.preview }}</span>
				<span class="pipe-draft-cursor" />
			</div>
		</div>

		<!-- Step 5: Routing -->
		<div v-else-if="step.num === 5" class="pipe-routes">
			<div
				v-for="route in step.routes"
				:key="route.label"
				class="pipe-route"
				:class="{ 'is-primary': route.primary }"
			>
				<span class="pipe-route-label">{{ route.label }}</span>
				<span class="pipe-route-desc">{{ route.desc }}</span>
			</div>
		</div>
	</div>
</template>

<style scoped>
/* Panel body */
.pipe-panel-body {
	position: relative;
	margin-bottom: 12px;
}

/* Step 1: Sources */
.pipe-sources {
	display: grid;
	grid-template-columns: repeat(2, 1fr);
	gap: 6px;
}

@media (max-width: 480px) {
	.pipe-sources {
		grid-template-columns: 1fr;
	}
}

.pipe-source {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 6px 10px;
	border-radius: 6px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	transition: border-color var(--motion-moderate);
}

.pipe-source:hover {
	border-color: var(--color-border-default);
}

.pipe-source svg {
	color: var(--color-accent-muted);
	flex-shrink: 0;
}

.pipe-source span {
	font-size: 0.75rem;
	color: var(--color-text-secondary);
}

/* Step 2: Intent tags */
.pipe-intents {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}

.pipe-intent {
	padding: 5px 12px;
	border-radius: 6px;
	font-size: 0.75rem;
	font-weight: var(--font-weight-medium);
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	color: var(--color-text-tertiary);
	transition-property: color, background-color, border-color;
	transition-duration: var(--motion-moderate);
}

.pipe-intent.is-active {
	background: color-mix(in oklab, var(--color-info) 10%, var(--color-bg-surface));
	border-color: color-mix(in oklab, var(--color-info) 30%, var(--color-border-default));
	color: var(--color-info);
	font-weight: var(--font-weight-semibold);
}

/* Step 3: Action items */
.pipe-actions-list {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.pipe-action-item {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 6px 10px;
	border-radius: 6px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	transition: border-color var(--motion-moderate);
}

.pipe-action-item:hover {
	border-color: var(--color-border-default);
}

.pipe-action-num {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 16px;
	height: 16px;
	border-radius: 50%;
	background: color-mix(in oklab, var(--color-warning) 12%, var(--color-bg-elevated));
	font-size: 0.5625rem;
	font-weight: 700;
	color: var(--color-warning);
	flex-shrink: 0;
}

.pipe-action-label {
	font-size: 0.75rem;
	color: var(--color-text-secondary);
	flex: 1;
}

.pipe-action-type {
	font-size: 0.625rem;
	font-family: var(--font-mono);
	padding: 2px 6px;
	border-radius: 3px;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	font-weight: var(--font-weight-semibold);
}

.pipe-action-type--api {
	background: color-mix(in oklab, var(--color-info) 10%, var(--color-bg-elevated));
	color: var(--color-info);
}

.pipe-action-type--draft {
	background: color-mix(in oklab, var(--color-brand) 10%, var(--color-bg-elevated));
	color: var(--color-brand);
}

.pipe-action-type--data {
	background: color-mix(in oklab, var(--color-accent) 10%, var(--color-bg-elevated));
	color: var(--color-accent);
}

/* Step 4: Draft preview */
.pipe-draft {
	border-radius: 8px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	overflow: hidden;
}

.pipe-draft-header {
	padding: 8px 12px;
	border-bottom: 1px solid var(--color-border-subtle);
	background: var(--color-bg-soft);
}

.pipe-draft-subject {
	font-size: 0.75rem;
	font-weight: var(--font-weight-semibold);
	color: var(--color-text-primary);
}

.pipe-draft-body {
	padding: 10px 12px;
	display: flex;
	align-items: baseline;
	gap: 0;
}

.pipe-draft-preview {
	font-size: 0.75rem;
	color: var(--color-text-secondary);
	line-height: 1.5;
}

.pipe-draft-cursor {
	display: inline-block;
	width: 2px;
	height: 13px;
	background: var(--color-brand);
	margin-left: 1px;
	vertical-align: text-bottom;
	border-radius: 1px;
}

.is-visible .pipe-draft-cursor {
	animation: cursor-blink 1s step-end infinite;
}

@keyframes cursor-blink {
	0%,
	100% {
		opacity: 1;
	}
	50% {
		opacity: 0;
	}
}

/* Step 5: Routing options */
.pipe-routes {
	display: grid;
	grid-template-columns: repeat(2, 1fr);
	gap: 8px;
}

@media (max-width: 480px) {
	.pipe-routes {
		grid-template-columns: 1fr;
	}
}

.pipe-route {
	display: flex;
	flex-direction: column;
	gap: 2px;
	padding: 10px 12px;
	border-radius: 7px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	transition:
		border-color var(--motion-moderate),
		background var(--motion-moderate);
}

.pipe-route:hover {
	border-color: var(--color-border-default);
}

.pipe-route.is-primary {
	border-color: color-mix(in oklab, var(--color-success) 25%, var(--color-border-default));
	background: color-mix(in oklab, var(--color-success) 4%, var(--color-bg-surface));
}

.pipe-route-label {
	font-size: 0.75rem;
	font-weight: var(--font-weight-semibold);
	color: var(--color-text-primary);
}

.pipe-route.is-primary .pipe-route-label {
	color: var(--color-success);
}

.pipe-route-desc {
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
}
</style>
