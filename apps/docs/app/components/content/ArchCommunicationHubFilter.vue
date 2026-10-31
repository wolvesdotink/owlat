<script setup lang="ts">
/**
 * Content-filter stage of `::arch-communication-hub`: the four screening
 * layers every inbound message passes before an agent sees it.
 */
import { communicationHubFilterLayers } from '../../utils/archCommunicationHub';
</script>

<template>
	<div class="hub-section hub-filter">
		<ArchCommunicationHubCard
			variant="filter"
			title="Content Filter"
			icon="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
		>
			<template #badge>
				<div class="hub-filter-badge">
					<span class="hub-filter-badge-dot hub-filter-badge-dot--clean" />
					<span class="hub-filter-badge-label">Pass</span>
					<span class="hub-filter-badge-dot hub-filter-badge-dot--flagged" />
					<span class="hub-filter-badge-label">Quarantine</span>
				</div>
			</template>
			<div class="hub-filter-layers">
				<div
					v-for="(layer, i) in communicationHubFilterLayers"
					:key="layer.name"
					class="hub-filter-layer"
					:style="{ '--fl': i }"
				>
					<span class="hub-filter-layer-num">{{ i + 1 }}</span>
					<div class="hub-filter-layer-text">
						<span class="hub-filter-layer-name">{{ layer.name }}</span>
						<span class="hub-filter-layer-detail">{{ layer.detail }}</span>
					</div>
				</div>
			</div>
			<div class="hub-filter-note">
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
					<path d="M13 10V3L4 14h7v7l9-11h-7z" />
				</svg>
				<span>Flagged messages quarantined — admin can release, confirm, or block sender</span>
			</div>
		</ArchCommunicationHubCard>
	</div>
</template>

<style scoped>
.hub-filter-badge {
	display: flex;
	align-items: center;
	gap: 6px;
	margin-left: auto;
	font-size: 0.625rem;
	font-family: var(--font-mono);
}

.hub-filter-badge-label {
	color: var(--color-text-tertiary);
}

.hub-filter-badge-dot {
	width: 6px;
	height: 6px;
	border-radius: 50%;
}

.hub-filter-badge-dot--clean {
	background: var(--color-success);
}

.hub-filter-badge-dot--flagged {
	background: var(--color-error);
}

.hub-filter-layers {
	display: grid;
	grid-template-columns: repeat(2, 1fr);
	gap: 6px;
	margin-bottom: 10px;
}

@media (max-width: 500px) {
	.hub-filter-layers {
		grid-template-columns: 1fr;
	}
}

.hub-filter-layer {
	display: flex;
	align-items: flex-start;
	gap: 8px;
	padding: 8px 10px;
	border-radius: 6px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	transition: border-color var(--motion-moderate);
}

.hub-filter-layer:hover {
	border-color: color-mix(in oklab, var(--color-warning) 25%, var(--color-border-default));
}

.hub-filter-layer-num {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 16px;
	height: 16px;
	border-radius: 50%;
	background: color-mix(in oklab, var(--color-warning) 12%, var(--color-bg-elevated));
	font-size: 0.5625rem;
	font-weight: 700;
	color: var(--color-warning);
	flex-shrink: 0;
	margin-top: 1px;
}

.hub-filter-layer-text {
	display: flex;
	flex-direction: column;
	gap: 1px;
	min-width: 0;
}

.hub-filter-layer-name {
	font-size: 0.75rem;
	font-weight: var(--font-weight-semibold);
	color: var(--color-text-primary);
}

.hub-filter-layer-detail {
	font-size: 0.625rem;
	color: var(--color-text-tertiary);
	line-height: 1.4;
}

.hub-filter-note {
	display: flex;
	align-items: flex-start;
	gap: 6px;
	padding-top: 8px;
	border-top: 1px solid var(--color-border-subtle);
}

.hub-filter-note svg {
	color: var(--color-warning-muted, var(--color-warning));
	flex-shrink: 0;
	margin-top: 1px;
	opacity: 0.7;
}

.hub-filter-note span {
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
	line-height: 1.5;
}
</style>
