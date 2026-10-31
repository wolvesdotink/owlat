<script setup lang="ts">
/**
 * One app or package card of the `ScopeMap` grids. The parent decides which
 * cards light up while a connection tag is hovered.
 *
 * The entrance and pulse rules key off the parent's `.is-visible`; scoped CSS only
 * scopes the last selector part, so that ancestor class still matches.
 */
import type { ScopeItem } from '../../utils/diagrams/scopeMap';

defineProps<{
	item: ScopeItem;
	tone: 'brand' | 'accent';
	highlighted: boolean;
	/** Position across both grids; drives the entrance stagger and icon pulse. */
	stagger: number;
}>();
</script>

<template>
	<div
		class="scope-card"
		:class="[`scope-card--${tone}`, { 'scope-card--highlighted': highlighted }]"
		:style="{ '--item-stagger': stagger }"
	>
		<div class="scope-card-icon" :class="`scope-card-icon--${tone}`">
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
				<path :d="item.icon" />
			</svg>
		</div>
		<div class="scope-card-body">
			<div class="scope-card-header">
				<span class="scope-card-name">{{ item.name }}</span>
				<span class="scope-card-tech">{{ item.tech }}</span>
			</div>
			<span class="scope-card-desc">{{ item.desc }}</span>
			<span class="scope-card-path">{{ item.path }}</span>
		</div>
	</div>
</template>

<style scoped>
/* ── Cards ── */
.scope-card {
	display: flex;
	gap: 12px;
	padding: 14px;
	border-radius: 10px;
	background: var(--color-bg-elevated);
	border: 1px solid var(--color-border-default);
	transition:
		border-color 0.25s,
		background 0.25s,
		transform 0.3s var(--ease-spring),
		box-shadow 0.3s;
	opacity: 0;
	transform: translateY(10px) scale(0.97);
	cursor: default;
	position: relative;
	overflow: hidden;
}

.scope-card::before {
	content: '';
	position: absolute;
	inset: 0;
	opacity: 0;
	transition: opacity var(--motion-slow);
	pointer-events: none;
}

.scope-card--brand::before {
	background: radial-gradient(ellipse at 20% 30%, rgba(196, 120, 90, 0.06) 0%, transparent 70%);
}

.scope-card--accent::before {
	background: radial-gradient(ellipse at 20% 30%, rgba(212, 165, 116, 0.05) 0%, transparent 70%);
}

.scope-card:hover::before {
	opacity: 1;
}

.is-visible .scope-card {
	opacity: 1;
	transform: translateY(0) scale(1);
	transition:
		border-color 0.25s,
		background 0.25s,
		transform 0.3s var(--ease-spring),
		box-shadow 0.3s,
		opacity 0.5s var(--ease-spring);
	transition-delay: calc(0.2s + var(--item-stagger) * 0.06s);
}

.scope-card:hover {
	border-color: var(--color-border-strong);
	transform: translateY(-2px) scale(1.01);
	box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
	transition-delay: 0s;
}

.scope-card--highlighted {
	border-color: var(--color-brand) !important;
	box-shadow: 0 0 16px rgba(196, 120, 90, 0.2) !important;
}

.scope-card--accent.scope-card--highlighted {
	border-color: var(--color-accent) !important;
	box-shadow: 0 0 16px rgba(212, 165, 116, 0.2) !important;
}

/* ── Card icon ── */
.scope-card-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 36px;
	height: 36px;
	border-radius: 9px;
	flex-shrink: 0;
	transition: box-shadow var(--motion-moderate);
}

.scope-card-icon--brand {
	background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
	color: var(--color-brand);
}

.scope-card-icon--accent {
	background: color-mix(in oklab, var(--color-accent) 12%, var(--color-bg-surface));
	color: var(--color-accent);
}

.scope-card:hover .scope-card-icon {
	box-shadow: 0 0 12px rgba(196, 120, 90, 0.15);
}

.scope-card--accent:hover .scope-card-icon {
	box-shadow: 0 0 12px rgba(212, 165, 116, 0.15);
}

/* ── Card body ── */
.scope-card-body {
	display: flex;
	flex-direction: column;
	gap: 4px;
	min-width: 0;
	position: relative;
}

.scope-card-header {
	display: flex;
	align-items: baseline;
	gap: 8px;
}

.scope-card-name {
	font-weight: var(--font-weight-semibold);
	font-size: 0.8125rem;
	color: var(--color-text-primary);
	white-space: nowrap;
}

.scope-card-tech {
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
	white-space: nowrap;
}

.scope-card-desc {
	font-size: 0.75rem;
	color: var(--color-text-secondary);
	line-height: 1.45;
}

.scope-card-path {
	font-size: 0.6875rem;
	color: var(--color-text-disabled);
	font-family: var(--font-mono);
}

.is-visible .scope-card-icon {
	animation: scope-icon-pulse 3s ease-in-out infinite;
	animation-delay: calc(var(--item-stagger) * 0.2s + 2s);
}

@keyframes scope-icon-pulse {
	0%,
	100% {
		box-shadow: none;
	}
	50% {
		box-shadow: 0 0 8px rgba(196, 120, 90, 0.12);
	}
}

.is-visible .scope-card--accent .scope-card-icon {
	animation-name: scope-icon-pulse-accent;
}

@keyframes scope-icon-pulse-accent {
	0%,
	100% {
		box-shadow: none;
	}
	50% {
		box-shadow: 0 0 8px rgba(212, 165, 116, 0.12);
	}
}
</style>
