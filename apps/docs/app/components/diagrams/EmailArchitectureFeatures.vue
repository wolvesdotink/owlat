<script setup lang="ts">
/**
 * The inline editor feature grid inside the "Email Builder" section of
 * `EmailArchitecture`.
 *
 * The entrance rules key off the parent's `.is-visible`; scoped CSS only
 * scopes the last selector part, so that ancestor class still matches.
 */
import { builderFeatures } from '../../utils/diagrams/emailArchitecture';
</script>

<template>
	<div class="ea-features">
		<div
			v-for="(feat, i) in builderFeatures"
			:key="feat.name"
			class="ea-feature"
			:style="{ '--i': i }"
		>
			<div class="ea-feature-icon">
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
					<path :d="feat.icon" />
				</svg>
			</div>
			<div class="ea-feature-text">
				<span class="ea-feature-name">{{ feat.name }}</span>
				<span class="ea-feature-detail">{{ feat.detail }}</span>
			</div>
		</div>
	</div>
</template>

<style scoped>
/* Builder features */
.ea-features {
	display: grid;
	grid-template-columns: repeat(3, 1fr);
	gap: 8px;
}

@media (max-width: 680px) {
	.ea-features {
		grid-template-columns: repeat(2, 1fr);
	}
}

@media (max-width: 480px) {
	.ea-features {
		grid-template-columns: 1fr;
	}
}

.ea-feature {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 10px;
	border-radius: 8px;
	background: var(--color-bg-surface);
	border: 1px solid transparent;
	transition:
		border-color var(--motion-moderate),
		background var(--motion-moderate),
		transform var(--motion-moderate) var(--ease-spring);
	opacity: 0;
	transform: translateY(8px);
}

.is-visible .ea-feature {
	opacity: 1;
	transform: translateY(0);
	transition-delay: calc(0.1s + var(--i) * 0.06s);
}

.ea-feature:hover {
	border-color: var(--color-border-default);
	background: var(--color-bg-surface-hover);
	transform: translateY(-1px);
	transition-delay: 0s;
}

.ea-feature-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 26px;
	height: 26px;
	border-radius: 6px;
	background: var(--color-bg-elevated);
	color: var(--color-brand-muted);
	flex-shrink: 0;
}

.ea-feature-text {
	display: flex;
	flex-direction: column;
	gap: 1px;
	min-width: 0;
}

.ea-feature-name {
	font-weight: var(--font-weight-semibold);
	font-size: 0.75rem;
	color: var(--color-text-primary);
	white-space: nowrap;
}

.ea-feature-detail {
	font-size: 0.625rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
</style>
