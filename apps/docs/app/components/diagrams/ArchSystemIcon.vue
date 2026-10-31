<script setup lang="ts">
/**
 * The icon tile shared by the layer items, the default delivery card and the
 * webhooks card of `ArchSystem`. All `.arch-item-icon` rules live here, so the
 * tile looks the same wherever it is placed.
 */
withDefaults(
	defineProps<{
		/** `d` attribute of a single 24×24 stroked path. */
		icon: string;
		size?: number;
		variant?: 'primary' | 'ext';
	}>(),
	{ size: 20, variant: undefined }
);
</script>

<template>
	<div class="arch-item-icon" :class="variant && `arch-item-icon--${variant}`">
		<svg
			:width="size"
			:height="size"
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
</template>

<style scoped>
.arch-item-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	border-radius: 8px;
	background: var(--color-bg-elevated);
	color: var(--color-brand);
	flex-shrink: 0;
	transition:
		color var(--motion-moderate),
		box-shadow var(--motion-moderate);
}

.arch-layer--accent .arch-item-icon {
	color: var(--color-accent);
}

.arch-item:hover .arch-item-icon {
	box-shadow: 0 0 12px rgba(196, 120, 90, 0.15);
}
.arch-item-icon--primary {
	width: 40px;
	height: 40px;
	border-radius: 10px;
	background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
	color: var(--color-brand);
	flex-shrink: 0;
}

.arch-item-icon--ext {
	width: 36px;
	height: 36px;
	border-radius: 10px;
	background: var(--color-bg-surface);
	margin-bottom: 2px;
}
</style>
