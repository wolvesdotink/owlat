<script setup lang="ts">
/**
 * Step bar of `::arch-agent-pipeline`: one button per step, the active one
 * tinted in its colour and the finished ones marked done. Clicking a step
 * emits `select`; the parent owns the active step and the cycle timer.
 */
import type { AgentPipelineStep } from '../../utils/archAgentPipeline';

defineProps<{
	steps: AgentPipelineStep[];
	activeStep: number;
}>();

const emit = defineEmits<{
	select: [index: number];
}>();
</script>

<template>
	<div class="pipe-nav">
		<button
			v-for="(step, i) in steps"
			:key="step.num"
			class="pipe-nav-step"
			:class="[
				`pipe-nav-step--${step.color}`,
				{ 'is-active': activeStep === i, 'is-past': activeStep > i },
			]"
			:style="{ '--i': i }"
			@click="emit('select', i)"
		>
			<span class="pipe-nav-num">{{ step.num }}</span>
			<span class="pipe-nav-name">{{ step.name }}</span>
			<!-- Progress line between steps -->
			<div v-if="i < steps.length - 1" class="pipe-nav-connector">
				<div class="pipe-nav-connector-fill" :class="{ 'is-filled': activeStep > i }" />
			</div>
		</button>
	</div>
</template>

<style scoped>
/* ── Color maps ── */
:where(.pipe-nav-step--brand.is-active) {
	--step-color: var(--color-brand);
}
:where(.pipe-nav-step--accent.is-active) {
	--step-color: var(--color-accent);
}
:where(.pipe-nav-step--info.is-active) {
	--step-color: var(--color-info);
}
:where(.pipe-nav-step--warning.is-active) {
	--step-color: var(--color-warning);
}
:where(.pipe-nav-step--success.is-active) {
	--step-color: var(--color-success);
}

/* ── Step navigation bar ── */
.pipe-nav {
	display: flex;
	align-items: center;
	gap: 0;
	padding: 6px;
	background: var(--color-bg-elevated);
	border: 1px solid var(--color-border-default);
	border-radius: 10px;
	opacity: 0;
	transform: translateY(10px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--stagger) * 0.12s);
	overflow-x: auto;
}

.is-visible .pipe-nav {
	opacity: 1;
	transform: translateY(0);
}

.pipe-nav-step {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 7px 12px;
	border-radius: 7px;
	border: 1px solid transparent;
	background: transparent;
	cursor: pointer;
	white-space: nowrap;
	flex-shrink: 0;
	position: relative;
	transition:
		background var(--motion-moderate),
		border-color var(--motion-moderate),
		box-shadow var(--motion-moderate);
	opacity: 0;
	transform: translateX(-6px);
	font-family: inherit;
}

.is-visible .pipe-nav-step {
	opacity: 1;
	transform: translateX(0);
	transition:
		background var(--motion-moderate),
		border-color var(--motion-moderate),
		box-shadow var(--motion-moderate),
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(0.15s + var(--i) * 0.06s);
}

.pipe-nav-step:hover {
	background: var(--color-bg-surface);
	transition-delay: 0s;
}

.pipe-nav-step.is-active {
	background: var(--color-bg-surface);
	border-color: color-mix(
		in oklab,
		var(--step-color, var(--color-brand)) 30%,
		var(--color-border-default)
	);
	box-shadow: 0 0 12px color-mix(in oklab, var(--step-color, var(--color-brand)) 10%, transparent);
}

.pipe-nav-num {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 20px;
	height: 20px;
	border-radius: 50%;
	background: var(--color-bg-surface);
	border: 1.5px solid var(--color-border-default);
	font-size: 0.625rem;
	font-weight: 700;
	color: var(--color-text-tertiary);
	flex-shrink: 0;
	transition:
		background var(--motion-moderate),
		border-color var(--motion-moderate),
		color var(--motion-moderate);
}

.pipe-nav-step.is-active .pipe-nav-num {
	background: color-mix(
		in oklab,
		var(--step-color, var(--color-brand)) 15%,
		var(--color-bg-surface)
	);
	border-color: color-mix(
		in oklab,
		var(--step-color, var(--color-brand)) 40%,
		var(--color-border-default)
	);
	color: var(--step-color, var(--color-brand));
}

.pipe-nav-step.is-past .pipe-nav-num {
	background: color-mix(in oklab, var(--color-success) 10%, var(--color-bg-surface));
	border-color: color-mix(in oklab, var(--color-success) 30%, var(--color-border-default));
	color: var(--color-success);
}

.pipe-nav-name {
	font-size: 0.75rem;
	font-weight: var(--font-weight-medium);
	color: var(--color-text-tertiary);
	transition: color var(--motion-moderate);
}

.pipe-nav-step.is-active .pipe-nav-name {
	color: var(--color-text-primary);
}

.pipe-nav-step.is-past .pipe-nav-name {
	color: var(--color-text-secondary);
}

/* Connector line between nav steps */
.pipe-nav-connector {
	position: absolute;
	right: -2px;
	top: 50%;
	transform: translateY(-50%);
	width: 4px;
	height: 14px;
	background: var(--color-border-subtle);
	border-radius: 2px;
	overflow: hidden;
}

.pipe-nav-connector-fill {
	position: absolute;
	inset: 0;
	background: var(--color-success);
	border-radius: 2px;
	transform: scaleY(0);
	transform-origin: top;
	transition: transform var(--motion-slow) var(--ease-spring);
}

.pipe-nav-connector-fill.is-filled {
	transform: scaleY(1);
}

@media (max-width: 600px) {
	.pipe-nav {
		gap: 2px;
	}
	.pipe-nav-name {
		display: none;
	}
	.pipe-nav-step {
		padding: 7px 10px;
	}
}
</style>
