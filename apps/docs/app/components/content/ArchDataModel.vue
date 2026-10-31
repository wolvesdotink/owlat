<script setup lang="ts">
import { ref, onMounted } from 'vue';
import ArchDataModelDiagram from '../diagrams/ArchDataModelDiagram.vue';
import { legendTypes } from '../../utils/diagrams/archDataModel';

const visible = ref(false);

onMounted(() => {
	requestAnimationFrame(() => {
		visible.value = true;
	});
});
</script>

<template>
	<div class="dm" :class="{ 'is-visible': visible }">
		<!-- Layered diagram -->
		<ArchDataModelDiagram />

		<!-- Type legend -->
		<div class="dm-types" :style="{ '--stagger': 1 }">
			<div
				v-for="lt in legendTypes"
				:key="lt.color"
				class="dm-type-badge"
				:class="`dm-type-badge--${lt.color}`"
			>
				<svg
					width="11"
					height="11"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path :d="lt.icon" />
				</svg>
				<span>{{ lt.label }}</span>
			</div>
		</div>

		<!-- Key design principles -->
		<div class="dm-principles" :style="{ '--stagger': 2 }">
			<div class="dm-principles-header">
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
					<path d="M13 10V3L4 14h7v7l9-11h-7z" />
				</svg>
				<span class="dm-principles-title">Key design principles</span>
			</div>
			<div class="dm-principles-grid">
				<div class="dm-principle" :style="{ '--i': 0 }">
					<span class="dm-principle-label">Single tenant root</span>
					<span class="dm-principle-detail"
						>Every entity scoped to Organization — no cross-tenant leakage</span
					>
				</div>
				<div class="dm-principle" :style="{ '--i': 1 }">
					<span class="dm-principle-label">Conversation as hub</span>
					<span class="dm-principle-detail"
						>Members, Contacts, and Channels all meet in Conversations — the universal thread</span
					>
				</div>
				<div class="dm-principle" :style="{ '--i': 2 }">
					<span class="dm-principle-label">Knowledge accrues passively</span>
					<span class="dm-principle-detail"
						>Messages, Files, and Contacts automatically feed the Knowledge Graph — no manual
						entry</span
					>
				</div>
				<div class="dm-principle" :style="{ '--i': 3 }">
					<span class="dm-principle-label">Agents are first-class actors</span>
					<span class="dm-principle-detail"
						>Agents participate in Conversations, produce Messages, query Knowledge, and ask Members
						for decisions</span
					>
				</div>
			</div>
		</div>
	</div>
</template>

<style scoped>
.dm {
	margin: 2rem 0;
	display: flex;
	flex-direction: column;
	gap: 10px;
}

/* ── Type legend ── */
.dm-types {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .dm-types {
	opacity: 1;
	transform: translateY(0);
}

.dm-type-badge {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 4px 10px;
	border-radius: 5px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	font-size: 0.6875rem;
	font-weight: var(--font-weight-semibold);
	transition: border-color var(--motion-moderate);
}

.dm-type-badge:hover {
	border-color: var(--color-border-default);
}

.dm-type-badge--brand {
	color: var(--color-brand);
	border-color: color-mix(in oklab, var(--color-brand) 15%, var(--color-border-subtle));
}
.dm-type-badge--brand svg {
	color: var(--color-brand);
}
.dm-type-badge--accent {
	color: var(--color-accent);
	border-color: color-mix(in oklab, var(--color-accent) 15%, var(--color-border-subtle));
}
.dm-type-badge--accent svg {
	color: var(--color-accent);
}
.dm-type-badge--info {
	color: var(--color-info);
	border-color: color-mix(in oklab, var(--color-info) 15%, var(--color-border-subtle));
}
.dm-type-badge--info svg {
	color: var(--color-info);
}
.dm-type-badge--warning {
	color: var(--color-warning);
	border-color: color-mix(in oklab, var(--color-warning) 15%, var(--color-border-subtle));
}
.dm-type-badge--warning svg {
	color: var(--color-warning);
}
.dm-type-badge--success {
	color: var(--color-success);
	border-color: color-mix(in oklab, var(--color-success) 15%, var(--color-border-subtle));
}
.dm-type-badge--success svg {
	color: var(--color-success);
}

/* ── Key design principles ── */
.dm-principles {
	border: 1px solid color-mix(in oklab, var(--color-brand) 20%, var(--color-border-default));
	border-radius: 10px;
	background: var(--color-bg-elevated);
	overflow: hidden;
	opacity: 0;
	transform: translateY(10px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring),
		border-color var(--motion-moderate),
		box-shadow var(--motion-moderate);
	transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .dm-principles {
	opacity: 1;
	transform: translateY(0);
}

.dm-principles:hover {
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
}

.dm-principles-header {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 10px 14px;
	border-bottom: 1px solid var(--color-border-subtle);
	background: color-mix(in oklab, var(--color-brand) 3%, var(--color-bg-soft));
}

.dm-principles-header svg {
	color: var(--color-brand);
	flex-shrink: 0;
}

.dm-principles-title {
	font-weight: var(--font-weight-semibold);
	font-size: 0.75rem;
	color: var(--color-brand);
}

.dm-principles-grid {
	display: grid;
	grid-template-columns: repeat(2, 1fr);
	gap: 1px;
	background: var(--color-border-subtle);
}

.dm-principle {
	display: flex;
	flex-direction: column;
	gap: 2px;
	padding: 12px 14px;
	background: var(--color-bg-elevated);
	opacity: 0;
	transform: translateY(6px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(0.4s + var(--i) * 0.07s);
}

.is-visible .dm-principle {
	opacity: 1;
	transform: translateY(0);
}

.dm-principle-label {
	font-weight: var(--font-weight-semibold);
	font-size: 0.75rem;
	color: var(--color-text-primary);
}

.dm-principle-detail {
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
	line-height: 1.5;
}

/* ── Responsive ── */
@media (max-width: 600px) {
	.dm-principles-grid {
		grid-template-columns: 1fr;
	}
}
</style>
