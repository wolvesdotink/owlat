<script setup lang="ts">
/**
 * `::arch-agent-pipeline` — the Vision page's walkthrough of the five steps an
 * agent runs for one incoming message, cycling through them automatically.
 *
 * This component owns the trigger, the auto-cycle timer and the active step;
 * the step bar is `ArchAgentPipelineNav`, each detail panel is
 * `ArchAgentPipelinePanel`, and the step copy lives in
 * `app/utils/archAgentPipeline`. The children's entrance animations key off
 * the `.is-visible` class set here.
 */
import { ref, onMounted } from 'vue';
import { agentPipelineSteps } from '../../utils/archAgentPipeline';

const visible = ref(false);
const activeStep = ref(-1);
let interval: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
	requestAnimationFrame(() => {
		visible.value = true;
	});
	// Auto-cycle through steps after initial entrance
	setTimeout(() => {
		activeStep.value = 0;
		interval = setInterval(() => {
			activeStep.value = (activeStep.value + 1) % 5;
		}, 3000);
	}, 1200);
});

function setStep(i: number) {
	activeStep.value = i;
	if (interval) {
		clearInterval(interval);
		interval = setInterval(() => {
			activeStep.value = (activeStep.value + 1) % 5;
		}, 3000);
	}
}
</script>

<template>
	<div class="pipe" :class="{ 'is-visible': visible }">
		<!-- Incoming message trigger -->
		<div class="pipe-trigger" :style="{ '--stagger': 0 }">
			<div class="pipe-trigger-icon">
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path
						d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
					/>
				</svg>
			</div>
			<div class="pipe-trigger-text">
				<span class="pipe-trigger-label">Incoming message</span>
				<span class="pipe-trigger-example">"Can I move my booking from Thursday to Saturday?"</span>
			</div>
		</div>

		<!-- Connector -->
		<div class="pipe-connector-v" :style="{ '--stagger': 0 }">
			<div class="pipe-connector-v-line" />
		</div>

		<!-- Step navigation bar -->
		<ArchAgentPipelineNav
			:steps="agentPipelineSteps"
			:active-step="activeStep"
			:style="{ '--stagger': 1 }"
			@select="setStep"
		/>

		<!-- Active step detail panel -->
		<div class="pipe-detail" :style="{ '--stagger': 2 }">
			<div class="pipe-detail-inner">
				<ArchAgentPipelinePanel
					v-for="(step, i) in agentPipelineSteps"
					:key="step.num"
					:step="step"
					:active="activeStep === i"
				/>
			</div>
		</div>
	</div>
</template>

<style scoped>
.pipe {
	margin: 2rem 0;
	display: flex;
	flex-direction: column;
	gap: 0;
}

/* ── Incoming message trigger ── */
.pipe-trigger {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 10px 14px;
	border-radius: 8px;
	background: var(--color-bg-elevated);
	border: 1px solid color-mix(in oklab, var(--color-info) 20%, var(--color-border-default));
	opacity: 0;
	transform: translateY(10px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .pipe-trigger {
	opacity: 1;
	transform: translateY(0);
}

.pipe-trigger-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	border-radius: 8px;
	background: color-mix(in oklab, var(--color-info) 10%, var(--color-bg-surface));
	color: var(--color-info);
	flex-shrink: 0;
}

.pipe-trigger-text {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}

.pipe-trigger-label {
	font-size: 0.6875rem;
	font-weight: var(--font-weight-semibold);
	text-transform: uppercase;
	letter-spacing: 0.06em;
	color: var(--color-info);
}

.pipe-trigger-example {
	font-size: 0.8125rem;
	color: var(--color-text-primary);
	font-style: italic;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

/* ── Vertical connector ── */
.pipe-connector-v {
	display: flex;
	justify-content: center;
	padding: 2px 0;
	opacity: 0;
	transition: opacity var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--stagger) * 0.12s + 0.1s);
}

.is-visible .pipe-connector-v {
	opacity: 1;
}

.pipe-connector-v-line {
	width: 2px;
	height: 14px;
	background: var(--color-border-strong);
	border-radius: 1px;
	transform-origin: top;
}

.is-visible .pipe-connector-v-line {
	animation: v-line-draw 0.4s var(--ease-spring) both;
	animation-delay: 0.2s;
}

@keyframes v-line-draw {
	from {
		transform: scaleY(0);
	}
	to {
		transform: scaleY(1);
	}
}

/* ── Detail panel ── */
.pipe-detail {
	margin-top: 8px;
	opacity: 0;
	transform: translateY(10px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .pipe-detail {
	opacity: 1;
	transform: translateY(0);
}

.pipe-detail-inner {
	display: grid;
	align-items: start;
}
</style>
