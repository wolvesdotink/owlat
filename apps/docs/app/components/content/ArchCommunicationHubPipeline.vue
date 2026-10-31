<script setup lang="ts">
/**
 * Agent Pipeline card at the centre of `::arch-communication-hub`: the four
 * steps every message runs through. Step entrance and the badge pulse key off
 * the parent's `.is-visible` root.
 */
import { communicationHubPipelineSteps } from '../../utils/archCommunicationHub';
</script>

<template>
	<ArchCommunicationHubCard
		variant="pipeline"
		title="Agent Pipeline"
		icon="M13 10V3L4 14h7v7l9-11h-7z"
	>
		<div class="hub-pipeline-steps">
			<div
				v-for="(step, i) in communicationHubPipelineSteps"
				:key="step.name"
				class="hub-pipeline-step"
				:style="{ '--s': i }"
			>
				<span class="hub-pipeline-step-num">{{ i + 1 }}</span>
				<div class="hub-pipeline-step-text">
					<span class="hub-pipeline-step-name">{{ step.name }}</span>
					<span class="hub-pipeline-step-detail">{{ step.detail }}</span>
				</div>
				<svg
					v-if="i < communicationHubPipelineSteps.length - 1"
					class="hub-pipeline-arrow"
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path d="M9 5l7 7-7 7" />
				</svg>
			</div>
		</div>
		<div class="hub-pipeline-badge">
			<span class="hub-pipeline-badge-dot" />
			Every message processed by an AI agent
		</div>
	</ArchCommunicationHubCard>
</template>

<style scoped>
.hub-pipeline-steps {
	display: flex;
	align-items: center;
	gap: 4px;
	flex-wrap: wrap;
}

.hub-pipeline-step {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 6px 10px;
	border-radius: 6px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	transition:
		border-color var(--motion-moderate),
		background var(--motion-moderate);
	opacity: 0;
	transform: translateX(-6px);
}

.is-visible .hub-pipeline-step {
	opacity: 1;
	transform: translateX(0);
	transition:
		border-color var(--motion-moderate),
		background var(--motion-moderate),
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(0.3s + var(--s) * 0.08s);
}

.hub-pipeline-step:hover {
	border-color: color-mix(in oklab, var(--color-brand) 25%, var(--color-border-default));
	background: var(--color-bg-surface-hover);
}

.hub-pipeline-step-num {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 18px;
	height: 18px;
	border-radius: 50%;
	background: color-mix(in oklab, var(--color-brand) 15%, var(--color-bg-elevated));
	color: var(--color-brand);
	font-size: 0.625rem;
	font-weight: 700;
	flex-shrink: 0;
}

.hub-pipeline-step-text {
	display: flex;
	flex-direction: column;
	gap: 0;
}

.hub-pipeline-step-name {
	font-weight: var(--font-weight-semibold);
	font-size: 0.75rem;
	color: var(--color-text-primary);
	line-height: 1.3;
}

.hub-pipeline-step-detail {
	font-size: 0.625rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
	line-height: 1.3;
}

.hub-pipeline-arrow {
	color: var(--color-text-disabled);
	flex-shrink: 0;
}

.is-visible .hub-pipeline-arrow {
	animation-delay: calc(var(--s) * 0.3s + 1.5s);
}

.hub-pipeline-badge {
	display: flex;
	align-items: center;
	gap: 6px;
	margin-top: 12px;
	padding-top: 10px;
	border-top: 1px solid var(--color-border-subtle);
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
}

.hub-pipeline-badge-dot {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: var(--color-brand);
	flex-shrink: 0;
}

.is-visible .hub-pipeline-badge-dot {
	animation: badge-dot-pulse 2s ease-in-out infinite 2s;
}

@keyframes badge-dot-pulse {
	0%,
	100% {
		box-shadow: 0 0 0 0 transparent;
	}
	50% {
		box-shadow: 0 0 6px 2px rgba(196, 120, 90, 0.25);
	}
}
</style>
