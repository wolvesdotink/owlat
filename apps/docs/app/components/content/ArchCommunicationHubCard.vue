<script setup lang="ts">
/**
 * Card shell shared by the communication hub's stages: border tint, hover
 * glow, icon chip and title colour per `variant`.
 *
 * Header cards (the default) render the icon, title and `badge` slot in a
 * header row, then the default slot as the body. Passing `detail` switches to
 * the compact outbound layout: the icon beside a stacked title and detail.
 */
defineProps<{
	variant: 'filter' | 'knowledge' | 'pipeline' | 'queue' | 'outbound';
	title: string;
	/** `d` attribute of a single 24×24 stroked path. */
	icon: string;
	detail?: string;
}>();
</script>

<template>
	<div class="hub-card" :class="`hub-card--${variant}`">
		<template v-if="detail">
			<div class="hub-card-icon" :class="`hub-card-icon--${variant}`">
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path :d="icon" />
				</svg>
			</div>
			<div class="hub-outbound-text">
				<span class="hub-card-title">{{ title }}</span>
				<span class="hub-outbound-detail">{{ detail }}</span>
			</div>
		</template>
		<template v-else>
			<div class="hub-card-header">
				<div class="hub-card-icon" :class="`hub-card-icon--${variant}`">
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path :d="icon" />
					</svg>
				</div>
				<div class="hub-card-title">{{ title }}</div>
				<slot name="badge" />
			</div>
			<slot />
		</template>
	</div>
</template>

<style scoped>
/* ── Cards ── */
.hub-card {
	border: 1px solid var(--color-border-default);
	border-radius: 10px;
	background: var(--color-bg-elevated);
	padding: 14px 16px;
	position: relative;
	overflow: hidden;
	transition:
		border-color var(--motion-moderate),
		box-shadow var(--motion-moderate);
}

.hub-card::before {
	content: '';
	position: absolute;
	inset: 0;
	opacity: 0;
	transition: opacity var(--motion-slow);
	pointer-events: none;
}

.hub-card:hover::before {
	opacity: 1;
}

.hub-card:hover {
	border-color: var(--color-border-strong);
	box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
}

.hub-card-header {
	display: flex;
	align-items: center;
	gap: 10px;
	margin-bottom: 12px;
}

.hub-card-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	border-radius: 8px;
	flex-shrink: 0;
	transition: box-shadow var(--motion-moderate);
}

.hub-card:hover .hub-card-icon {
	box-shadow: 0 0 10px rgba(196, 120, 90, 0.12);
}

.hub-card-title {
	font-weight: var(--font-weight-semibold);
	font-size: 0.875rem;
	color: var(--color-text-primary);
	letter-spacing: -0.01em;
}

.hub-card--knowledge {
	border-color: color-mix(in oklab, var(--color-accent) 20%, var(--color-border-default));
}

.hub-card--knowledge::before {
	background: radial-gradient(ellipse at 30% 40%, rgba(212, 165, 116, 0.06) 0%, transparent 70%);
}

.hub-card--knowledge .hub-card-title {
	color: var(--color-accent);
}

.hub-card-icon--knowledge {
	background: color-mix(in oklab, var(--color-accent) 12%, var(--color-bg-surface));
	color: var(--color-accent);
}

/* ── Agent Pipeline card ── */
.hub-card--pipeline {
	border-color: color-mix(in oklab, var(--color-brand) 25%, var(--color-border-default));
}

.hub-card--pipeline::before {
	background: radial-gradient(ellipse at 50% 30%, rgba(196, 120, 90, 0.05) 0%, transparent 70%);
}

.hub-card--pipeline .hub-card-title {
	color: var(--color-brand);
}

.hub-card-icon--pipeline {
	background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
	color: var(--color-brand);
}

/* ── Content Filter card ── */
.hub-card--filter {
	border-color: color-mix(in oklab, var(--color-warning) 20%, var(--color-border-default));
}

.hub-card--filter::before {
	background: radial-gradient(ellipse at 40% 30%, rgba(201, 165, 90, 0.05) 0%, transparent 70%);
}

.hub-card--filter .hub-card-title {
	color: var(--color-warning);
}

.hub-card-icon--filter {
	background: color-mix(in oklab, var(--color-warning) 12%, var(--color-bg-surface));
	color: var(--color-warning);
}

/* ── Verification Queue card ── */
.hub-card--queue {
	border-color: color-mix(in oklab, var(--color-success) 20%, var(--color-border-default));
}

.hub-card--queue::before {
	background: radial-gradient(ellipse at 60% 30%, rgba(122, 155, 110, 0.05) 0%, transparent 70%);
}

.hub-card--queue .hub-card-title {
	color: var(--color-success);
}

.hub-card-icon--queue {
	background: color-mix(in oklab, var(--color-success) 12%, var(--color-bg-surface));
	color: var(--color-success);
}

.hub-card--outbound {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 12px 16px;
}

.hub-card--outbound::before {
	background: radial-gradient(ellipse at 20% 50%, rgba(196, 120, 90, 0.04) 0%, transparent 70%);
}

.hub-card-icon--outbound {
	background: color-mix(in oklab, var(--color-brand) 10%, var(--color-bg-surface));
	color: var(--color-brand);
}

.hub-outbound-text {
	display: flex;
	flex-direction: column;
	gap: 1px;
}

.hub-outbound-detail {
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
}
</style>
