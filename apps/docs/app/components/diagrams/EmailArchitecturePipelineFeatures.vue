<script setup lang="ts">
/**
 * The delivery pipeline features at the foot of the "Email Delivery" section
 * of `EmailArchitecture`.
 *
 * The entrance rules key off the parent's `.is-visible`; scoped CSS only
 * scopes the last selector part, so that ancestor class still matches.
 */
import { DELIVERY_PIPELINE_FEATURES } from '../../utils/sendProviderDiagrams';

defineProps<{
	/** Entrance stagger step of the first tag; follows the provider cards. */
	staggerOffset: number;
}>();
</script>

<template>
	<div class="ea-pf">
		<div class="ea-pf-tags">
			<div
				v-for="(feat, i) in DELIVERY_PIPELINE_FEATURES"
				:key="feat.label"
				class="ea-pf-tag"
				:style="{ '--i': i + staggerOffset }"
			>
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
				<span>{{ feat.label }}</span>
			</div>
		</div>
	</div>
</template>

<style scoped>
/* Provider features */
.ea-pf {
	padding: 12px 14px;
	border-radius: 8px;
	background: var(--color-bg-soft);
	border: 1px solid var(--color-border-subtle);
}

.ea-pf-tags {
	display: flex;
	gap: 8px;
	flex-wrap: wrap;
}

.ea-pf-tag {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 5px 10px;
	border-radius: 6px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	font-size: 0.75rem;
	color: var(--color-text-secondary);
	transition:
		border-color var(--motion-moderate),
		transform var(--motion-moderate) var(--ease-spring);
	opacity: 0;
}

.is-visible .ea-pf-tag {
	opacity: 1;
	transition-delay: calc(0.2s + var(--i) * 0.06s);
}

.ea-pf-tag svg {
	color: var(--color-info);
	flex-shrink: 0;
}

.ea-pf-tag:hover {
	border-color: var(--color-border-default);
	transform: translateY(-1px);
	transition-delay: 0s;
}
</style>
