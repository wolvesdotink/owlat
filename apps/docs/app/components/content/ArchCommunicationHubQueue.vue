<script setup lang="ts">
/**
 * Verification Queue stage of `::arch-communication-hub`: the confidence
 * legend and the approve / edit / reject actions a reviewer gets.
 */
import { communicationHubQueueActions } from '../../utils/archCommunicationHub';
</script>

<template>
	<div class="hub-section">
		<ArchCommunicationHubCard
			variant="queue"
			title="Verification Queue"
			icon="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
		>
			<template #badge>
				<div class="hub-queue-confidence">
					<span class="hub-confidence-dot hub-confidence-dot--high" />
					<span class="hub-confidence-label">Auto</span>
					<span class="hub-confidence-dot hub-confidence-dot--medium" />
					<span class="hub-confidence-label">Review</span>
					<span class="hub-confidence-dot hub-confidence-dot--low" />
					<span class="hub-confidence-label">Escalate</span>
				</div>
			</template>
			<div class="hub-queue-content">
				<div class="hub-queue-description">
					<span>Org members see a prioritized list of verifications and approvals</span>
				</div>
				<div class="hub-queue-actions">
					<div
						v-for="action in communicationHubQueueActions"
						:key="action.name"
						class="hub-queue-action"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path :d="action.icon" />
						</svg>
						<span>{{ action.name }}</span>
					</div>
				</div>
			</div>
		</ArchCommunicationHubCard>
	</div>
</template>

<style scoped>
.hub-queue-confidence {
	display: flex;
	align-items: center;
	gap: 4px;
	margin-left: auto;
	padding: 3px 10px;
	border-radius: 5px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
}

.hub-confidence-dot {
	width: 6px;
	height: 6px;
	border-radius: 50%;
}

.hub-confidence-dot--high {
	background: var(--color-success);
}
.hub-confidence-dot--medium {
	background: var(--color-warning);
}
.hub-confidence-dot--low {
	background: var(--color-error);
}

.hub-confidence-label {
	font-size: 0.625rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
	margin-right: 6px;
}

.hub-confidence-label:last-child {
	margin-right: 0;
}

.hub-queue-content {
	display: flex;
	align-items: center;
	gap: 14px;
	flex-wrap: wrap;
}

.hub-queue-description {
	flex: 1;
	min-width: 200px;
}

.hub-queue-description span {
	font-size: 0.75rem;
	color: var(--color-text-secondary);
	line-height: 1.5;
}

.hub-queue-actions {
	display: flex;
	gap: 6px;
}

.hub-queue-action {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 5px 10px;
	border-radius: 6px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	font-size: 0.6875rem;
	font-weight: var(--font-weight-medium);
	color: var(--color-text-secondary);
	transition:
		border-color var(--motion-moderate),
		color var(--motion-moderate),
		background var(--motion-moderate);
	cursor: default;
}

.hub-queue-action:first-child {
	color: var(--color-success);
	border-color: color-mix(in oklab, var(--color-success) 20%, var(--color-border-subtle));
}

.hub-queue-action:hover {
	background: var(--color-bg-surface-hover);
	border-color: var(--color-border-default);
}
</style>
