<script setup lang="ts">
/**
 * Phase bar of `::smtp-session`: Connect → Encrypt → Envelope → Message →
 * Close, lighting up as the replay reaches each phase's first line.
 */
import { computed } from 'vue';
import { smtpSessionLines as lines, smtpSessionPhases as phases } from '../../utils/smtpSession';

const props = defineProps<{
	/** Index of the last transcript line shown; -1 before playback starts. */
	currentLine: number;
}>();

const currentPhase = computed(() => {
	if (props.currentLine < 0) return null;
	return lines[props.currentLine]?.phase ?? null;
});

function isPhaseReached(key: string) {
	if (props.currentLine < 0) return false;
	const firstLineOfPhase = lines.findIndex((l) => l.phase === key);
	return firstLineOfPhase <= props.currentLine;
}
</script>

<template>
	<div class="smtp-phases">
		<template v-for="(phase, pi) in phases" :key="phase.key">
			<div
				class="smtp-phase"
				:class="[
					`smtp-phase--${phase.color}`,
					{ 'smtp-phase--active': currentPhase === phase.key },
					{ 'smtp-phase--reached': isPhaseReached(phase.key) },
				]"
			>
				<div class="smtp-phase-icon">
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
						<path :d="phase.icon" />
					</svg>
				</div>
				<span class="smtp-phase-label">{{ phase.label }}</span>
			</div>
			<!-- Connector between phases -->
			<div
				v-if="pi < phases.length - 1"
				class="smtp-phase-connector"
				:class="{ 'smtp-phase-connector--active': isPhaseReached(phases[pi + 1]?.key ?? '') }"
			/>
		</template>
	</div>
</template>

<style scoped>
/* ── Phase progress bar ── */
.smtp-phases {
	display: flex;
	align-items: center;
	gap: 0;
	margin-bottom: 14px;
	flex-wrap: wrap;
}

.smtp-phase {
	display: flex;
	align-items: center;
	gap: 5px;
	padding: 4px 10px;
	border-radius: 9999px;
	font-size: 0.6875rem;
	font-family: var(--font-mono);
	font-weight: var(--font-weight-medium);
	letter-spacing: 0.02em;
	color: var(--color-text-disabled);
	transition: color var(--motion-slow) var(--ease-spring);
}

.smtp-phase-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 20px;
	height: 20px;
	border-radius: 50%;
	background: var(--color-bg-surface);
	border: 1.5px solid var(--color-border-subtle);
	transition-property: color, background-color, border-color, box-shadow;
	transition-duration: var(--motion-slow);
	transition-timing-function: var(--ease-spring);
}

.smtp-phase-icon svg {
	opacity: 0.4;
	transition: opacity var(--motion-moderate);
}

.smtp-phase--reached .smtp-phase-icon {
	border-color: var(--color-border-default);
}

.smtp-phase--reached .smtp-phase-icon svg {
	opacity: 0.7;
}

.smtp-phase--active .smtp-phase-icon svg {
	opacity: 1;
}

.smtp-phase--active.smtp-phase--brand .smtp-phase-icon {
	background: color-mix(in oklab, var(--color-brand) 15%, var(--color-bg-surface));
	border-color: var(--color-brand);
	color: var(--color-brand);
	box-shadow: 0 0 10px color-mix(in oklab, var(--color-brand) 20%, transparent);
}
.smtp-phase--active.smtp-phase--warning .smtp-phase-icon {
	background: color-mix(in oklab, var(--color-warning) 15%, var(--color-bg-surface));
	border-color: var(--color-warning);
	color: var(--color-warning);
	box-shadow: 0 0 10px color-mix(in oklab, var(--color-warning) 20%, transparent);
}
.smtp-phase--active.smtp-phase--info .smtp-phase-icon {
	background: color-mix(in oklab, var(--color-info) 15%, var(--color-bg-surface));
	border-color: var(--color-info);
	color: var(--color-info);
	box-shadow: 0 0 10px color-mix(in oklab, var(--color-info) 20%, transparent);
}
.smtp-phase--active.smtp-phase--accent .smtp-phase-icon {
	background: color-mix(in oklab, var(--color-accent) 15%, var(--color-bg-surface));
	border-color: var(--color-accent);
	color: var(--color-accent);
	box-shadow: 0 0 10px color-mix(in oklab, var(--color-accent) 20%, transparent);
}
.smtp-phase--active.smtp-phase--success .smtp-phase-icon {
	background: color-mix(in oklab, var(--color-success) 15%, var(--color-bg-surface));
	border-color: var(--color-success);
	color: var(--color-success);
	box-shadow: 0 0 10px color-mix(in oklab, var(--color-success) 20%, transparent);
}

.smtp-phase--active {
	color: var(--color-text-primary);
}
.smtp-phase--reached:not(.smtp-phase--active) {
	color: var(--color-text-tertiary);
}

.smtp-phase-label {
	line-height: 1;
}

/* Hide labels on small screens */
@media (max-width: 540px) {
	.smtp-phase-label {
		display: none;
	}
}

.smtp-phase-connector {
	width: 16px;
	height: 1.5px;
	background: var(--color-border-subtle);
	flex-shrink: 0;
	transition: background var(--motion-slow) var(--ease-spring);
}

.smtp-phase-connector--active {
	background: var(--color-border-default);
}
</style>
