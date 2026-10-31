<script setup lang="ts">
/**
 * The analytics strip at the foot of `ArchSystem`.
 *
 * The entrance rules key off the parent's `.is-visible`; scoped CSS only
 * scopes the last selector part, so that ancestor class still matches.
 */
import { analytics } from '../../utils/diagrams/archSystem';
</script>

<template>
	<div class="arch-analytics" :style="{ '--stagger': 4 }">
		<div class="arch-analytics-icon">
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
				<path
					d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
				/>
			</svg>
		</div>
		<div class="arch-analytics-text">
			<span class="arch-analytics-name">{{ analytics.name }}</span>
			<span class="arch-analytics-detail">{{ analytics.detail }}</span>
		</div>
		<div class="arch-analytics-lines">
			<span v-for="line in analytics.lines" :key="line" class="arch-analytics-line"
				>← {{ line }}</span
			>
		</div>
	</div>
</template>

<style scoped>
/* ── Analytics ── */
.arch-analytics {
	display: flex;
	align-items: center;
	gap: 14px;
	margin-top: 16px;
	padding: 14px 18px;
	border-radius: 10px;
	border: 1px dashed var(--color-border-default);
	background: var(--color-bg-soft);
	opacity: 0;
	transform: translateY(12px);
	transition:
		opacity 0.6s var(--ease-spring),
		transform 0.6s var(--ease-spring),
		border-color var(--motion-moderate);
	transition-delay: calc(var(--stagger) * 0.15s);
}

.is-visible .arch-analytics {
	opacity: 1;
	transform: translateY(0);
}

.arch-analytics:hover {
	border-color: color-mix(in oklab, var(--color-info) 40%, var(--color-border-default));
}

.arch-analytics-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 36px;
	height: 36px;
	border-radius: 10px;
	background: var(--color-info-subtle);
	color: var(--color-info);
	flex-shrink: 0;
}

.arch-analytics-text {
	display: flex;
	flex-direction: column;
	gap: 1px;
}

.arch-analytics-name {
	font-weight: var(--font-weight-semibold);
	font-size: 0.875rem;
	color: var(--color-text-primary);
}

.arch-analytics-detail {
	font-size: 0.75rem;
	color: var(--color-text-secondary);
}

.arch-analytics-lines {
	display: flex;
	flex-direction: column;
	gap: 2px;
	margin-left: auto;
}

.arch-analytics-line {
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
	white-space: nowrap;
}
</style>
