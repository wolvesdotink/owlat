<script setup lang="ts">
/**
 * The builder entry points inside the "Email Builder" section of `ArchEmail`.
 *
 * The entrance rules key off the parent's `.is-visible`; scoped CSS only
 * scopes the last selector part, so that ancestor class still matches.
 */
import { builderItems } from '../../utils/diagrams/archEmail';
</script>

<template>
	<div class="email-items">
		<div
			v-for="(item, i) in builderItems"
			:key="item.name"
			class="email-item"
			:style="{ '--i': i }"
		>
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
				<path :d="item.icon" />
			</svg>
			<span>{{ item.name }}</span>
		</div>
	</div>
</template>

<style scoped>
/* ── Builder items ── */
.email-items {
	display: grid;
	grid-template-columns: repeat(3, 1fr);
	gap: 8px;
}

@media (max-width: 580px) {
	.email-items {
		grid-template-columns: 1fr;
	}
}

.email-item {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 12px;
	border-radius: 8px;
	background: var(--color-bg-surface);
	font-size: 0.8125rem;
	font-weight: var(--font-weight-medium);
	color: var(--color-text-primary);
	border: 1px solid transparent;
	transition:
		border-color var(--motion-moderate),
		background var(--motion-moderate),
		transform var(--motion-moderate) var(--ease-spring);
	opacity: 0;
	transform: translateY(8px);
}

.email-item svg {
	color: var(--color-brand-muted);
	flex-shrink: 0;
}

.is-visible .email-item {
	opacity: 1;
	transform: translateY(0);
	transition-delay: calc(0.1s + var(--i) * 0.07s);
}

.email-item:hover {
	border-color: var(--color-border-default);
	background: var(--color-bg-surface-hover);
	transform: translateY(-1px);
	transition-delay: 0s;
}
</style>
