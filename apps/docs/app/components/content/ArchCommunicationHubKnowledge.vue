<script setup lang="ts">
/**
 * Knowledge Graph card of `::arch-communication-hub`, with the bidirectional
 * "context & updates" label that links it to the agent pipeline beside it.
 */
import { communicationHubKnowledgeTypes } from '../../utils/archCommunicationHub';
</script>

<template>
	<div class="hub-knowledge">
		<ArchCommunicationHubCard
			variant="knowledge"
			title="Knowledge Graph"
			icon="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
		>
			<div class="hub-knowledge-types">
				<span
					v-for="kt in communicationHubKnowledgeTypes"
					:key="kt.name"
					class="hub-knowledge-tag"
					:class="`hub-knowledge-tag--${kt.color}`"
					>{{ kt.name }}</span
				>
			</div>
			<div class="hub-knowledge-features">
				<span class="hub-knowledge-feature">Semantic search</span>
				<span class="hub-knowledge-feature">Graph traversal</span>
				<span class="hub-knowledge-feature">Synthesized briefings</span>
			</div>
		</ArchCommunicationHubCard>
		<!-- Bidirectional connection label -->
		<div class="hub-bidi-label">
			<span class="hub-bidi-arrow">◄</span>
			<span class="hub-bidi-text">context & updates</span>
			<span class="hub-bidi-arrow">►</span>
		</div>
	</div>
</template>

<style scoped>
/* ── Knowledge Graph card ── */
.hub-knowledge {
	display: flex;
	flex-direction: column;
	align-items: stretch;
}

.hub-knowledge-types {
	display: flex;
	flex-wrap: wrap;
	gap: 5px;
	margin-bottom: 10px;
}

.hub-knowledge-tag {
	font-size: 0.6875rem;
	font-family: var(--font-mono);
	padding: 2px 8px;
	border-radius: 4px;
	border: 1px solid var(--color-border-subtle);
	background: var(--color-bg-surface);
	color: var(--color-text-secondary);
}

.hub-knowledge-tag--brand {
	color: var(--color-brand);
	border-color: color-mix(in oklab, var(--color-brand) 20%, var(--color-border-subtle));
}
.hub-knowledge-tag--accent {
	color: var(--color-accent);
	border-color: color-mix(in oklab, var(--color-accent) 20%, var(--color-border-subtle));
}
.hub-knowledge-tag--info {
	color: var(--color-info);
	border-color: color-mix(in oklab, var(--color-info) 20%, var(--color-border-subtle));
}

.hub-knowledge-features {
	display: flex;
	flex-direction: column;
	gap: 3px;
}

.hub-knowledge-feature {
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
	padding-left: 12px;
	position: relative;
}

.hub-knowledge-feature::before {
	content: '›';
	position: absolute;
	left: 0;
	color: var(--color-accent-muted);
	font-weight: var(--font-weight-semibold);
}

/* Bidirectional label between knowledge and pipeline */
.hub-bidi-label {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	padding: 6px 0;
	margin: 0;
}

.hub-bidi-arrow {
	font-size: 0.625rem;
	color: var(--color-brand-dim);
	line-height: 1;
}

.is-visible .hub-bidi-arrow {
	animation: bidi-pulse 2s ease-in-out infinite;
}

.hub-bidi-arrow:last-child {
	animation-delay: 1s;
}

@keyframes bidi-pulse {
	0%,
	100% {
		opacity: 0.3;
	}
	50% {
		opacity: 1;
	}
}

.hub-bidi-text {
	font-size: 0.625rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
	white-space: nowrap;
}

@media (max-width: 640px) {
	.hub-bidi-label {
		padding: 4px 0;
	}
}

@media (min-width: 641px) {
	.hub-knowledge {
		flex-direction: row;
		align-items: center;
	}

	.hub-bidi-label {
		flex-direction: column;
		padding: 0 8px;
	}

	.hub-bidi-arrow {
		transform: rotate(0deg);
	}
}
</style>
