<script setup lang="ts">
/**
 * The SES identity manager card inside the "Email Delivery" section of
 * `ArchEmail`.
 *
 * The entrance rules key off the parent's `.is-visible`; scoped CSS only
 * scopes the last selector part, so that ancestor class still matches.
 */
import { sesFeatures } from '../../utils/diagrams/archEmail';

defineProps<{
	/** Entrance stagger step; follows the provider cards above it. */
	stagger: number;
}>();
</script>

<template>
	<div class="email-ses" :style="{ '--i': stagger }">
		<div class="email-ses-header">
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
					d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
				/>
			</svg>
			<span>SES Identity Manager</span>
			<code>sesIdentity.ts</code>
		</div>
		<ul class="email-ses-features">
			<li v-for="feat in sesFeatures" :key="feat">{{ feat }}</li>
		</ul>
	</div>
</template>

<style scoped>
/* ── SES Identity Manager ── */
.email-ses {
	padding: 12px 14px;
	border-radius: 8px;
	background: var(--color-bg-surface);
	border: 1px dashed var(--color-border-default);
	margin-bottom: 12px;
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring),
		border-color var(--motion-moderate);
}

.is-visible .email-ses {
	opacity: 1;
	transform: translateY(0);
	transition-delay: calc(0.15s + var(--i) * 0.07s);
}

.email-ses:hover {
	border-color: color-mix(in oklab, var(--color-warning) 40%, var(--color-border-default));
}

.email-ses-header {
	display: flex;
	align-items: center;
	gap: 8px;
	font-weight: var(--font-weight-semibold);
	font-size: 0.8125rem;
	color: var(--color-text-primary);
	margin-bottom: 8px;
}

.email-ses-header svg {
	color: var(--color-warning);
}

.email-ses-header code {
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
	padding: 2px 6px;
	background: var(--color-bg-elevated);
	border-radius: 4px;
	border: 1px solid var(--color-border-subtle);
	margin-left: auto;
}

.email-ses-features {
	list-style: none;
	padding: 0;
	margin: 0;
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.email-ses-features li {
	font-size: 0.75rem;
	color: var(--color-text-secondary);
	padding-left: 16px;
	position: relative;
}

.email-ses-features li::before {
	content: '›';
	position: absolute;
	left: 4px;
	color: var(--color-warning);
	font-weight: var(--font-weight-semibold);
}
</style>
