<script setup lang="ts">
import { ref, onMounted } from 'vue';
import ArchKnowledgeGraphCanvas from '../diagrams/ArchKnowledgeGraphCanvas.vue';
import { briefing, retrievalMethods, typeConfig } from '../../utils/diagrams/archKnowledgeGraph';

const visible = ref(false);

onMounted(() => {
	requestAnimationFrame(() => {
		visible.value = true;
	});
});
</script>

<template>
	<div class="kg" :class="{ 'is-visible': visible }">
		<!-- Graph visualization -->
		<ArchKnowledgeGraphCanvas />

		<!-- Type legend -->
		<div class="kg-types" :style="{ '--stagger': 1 }">
			<div
				v-for="(config, type) in typeConfig"
				:key="type"
				class="kg-type-badge"
				:class="`kg-type-badge--${config.color}`"
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
					<path :d="config.icon" />
				</svg>
				<span>{{ config.label }}</span>
			</div>
		</div>

		<!-- Retrieval methods -->
		<div class="kg-retrieval" :style="{ '--stagger': 2 }">
			<div class="kg-retrieval-header">
				<span class="kg-retrieval-title">Hybrid Retrieval</span>
				<span class="kg-retrieval-sub">Three strategies merged via rank fusion</span>
			</div>
			<div class="kg-retrieval-methods">
				<div
					v-for="(method, i) in retrievalMethods"
					:key="method.name"
					class="kg-method"
					:style="{ '--i': i }"
				>
					<div class="kg-method-icon">
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
							<path :d="method.icon" />
						</svg>
					</div>
					<div class="kg-method-text">
						<span class="kg-method-name">{{ method.name }}</span>
						<span class="kg-method-detail">{{ method.detail }}</span>
					</div>
					<code class="kg-method-example">{{ method.example }}</code>
				</div>
			</div>
		</div>

		<!-- Synthesized briefing -->
		<div class="kg-briefing" :style="{ '--stagger': 3 }">
			<div class="kg-briefing-header">
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
				<span class="kg-briefing-title">Synthesized briefing</span>
				<span class="kg-briefing-sub">What the agent actually receives — not a raw dump</span>
			</div>
			<div class="kg-briefing-body">
				<p>{{ briefing }}</p>
			</div>
		</div>
	</div>
</template>

<style scoped>
.kg {
	margin: 2rem 0;
	display: flex;
	flex-direction: column;
	gap: 10px;
}

/* ── Type legend ── */
.kg-types {
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

.is-visible .kg-types {
	opacity: 1;
	transform: translateY(0);
}

.kg-type-badge {
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

.kg-type-badge:hover {
	border-color: var(--color-border-default);
}

.kg-type-badge--brand {
	color: var(--color-brand);
	border-color: color-mix(in oklab, var(--color-brand) 15%, var(--color-border-subtle));
}
.kg-type-badge--brand svg {
	color: var(--color-brand);
}
.kg-type-badge--accent {
	color: var(--color-accent);
	border-color: color-mix(in oklab, var(--color-accent) 15%, var(--color-border-subtle));
}
.kg-type-badge--accent svg {
	color: var(--color-accent);
}
.kg-type-badge--info {
	color: var(--color-info);
	border-color: color-mix(in oklab, var(--color-info) 15%, var(--color-border-subtle));
}
.kg-type-badge--info svg {
	color: var(--color-info);
}
.kg-type-badge--warning {
	color: var(--color-warning);
	border-color: color-mix(in oklab, var(--color-warning) 15%, var(--color-border-subtle));
}
.kg-type-badge--warning svg {
	color: var(--color-warning);
}
.kg-type-badge--success {
	color: var(--color-success);
	border-color: color-mix(in oklab, var(--color-success) 15%, var(--color-border-subtle));
}
.kg-type-badge--success svg {
	color: var(--color-success);
}

/* ── Retrieval methods ── */
.kg-retrieval {
	border: 1px solid var(--color-border-default);
	border-radius: 10px;
	background: var(--color-bg-elevated);
	padding: 14px 16px;
	opacity: 0;
	transform: translateY(10px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring),
		border-color var(--motion-moderate);
	transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .kg-retrieval {
	opacity: 1;
	transform: translateY(0);
}

.kg-retrieval:hover {
	border-color: var(--color-border-strong);
}

.kg-retrieval-header {
	display: flex;
	align-items: baseline;
	gap: 8px;
	margin-bottom: 10px;
	padding-bottom: 8px;
	border-bottom: 1px solid var(--color-border-subtle);
}

.kg-retrieval-title {
	font-weight: var(--font-weight-semibold);
	font-size: 0.8125rem;
	color: var(--color-text-primary);
}

.kg-retrieval-sub {
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
}

.kg-retrieval-methods {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.kg-method {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 8px 10px;
	border-radius: 7px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	opacity: 0;
	transform: translateX(-6px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring),
		border-color var(--motion-moderate);
	transition-delay: calc(0.3s + var(--i) * 0.07s);
}

.is-visible .kg-method {
	opacity: 1;
	transform: translateX(0);
}

.kg-method:hover {
	border-color: var(--color-border-default);
	transition-delay: 0s;
}

.kg-method-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 28px;
	border-radius: 6px;
	background: color-mix(in oklab, var(--color-brand) 8%, var(--color-bg-elevated));
	color: var(--color-brand-muted);
	flex-shrink: 0;
}

.kg-method-text {
	display: flex;
	flex-direction: column;
	gap: 0;
	flex: 1;
	min-width: 0;
}

.kg-method-name {
	font-weight: var(--font-weight-semibold);
	font-size: 0.75rem;
	color: var(--color-text-primary);
}

.kg-method-detail {
	font-size: 0.625rem;
	color: var(--color-text-tertiary);
}

.kg-method-example {
	font-size: 0.625rem;
	font-family: var(--font-mono);
	color: var(--color-text-secondary);
	padding: 3px 8px;
	border-radius: 4px;
	background: var(--color-bg-elevated);
	border: 1px solid var(--color-border-subtle);
	white-space: nowrap;
	flex-shrink: 0;
}

@media (max-width: 540px) {
	.kg-method {
		flex-wrap: wrap;
	}
	.kg-method-example {
		width: 100%;
	}
}

/* ── Synthesized briefing ── */
.kg-briefing {
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

.is-visible .kg-briefing {
	opacity: 1;
	transform: translateY(0);
}

.kg-briefing:hover {
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
}

.kg-briefing-header {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 10px 14px;
	border-bottom: 1px solid var(--color-border-subtle);
	background: color-mix(in oklab, var(--color-brand) 3%, var(--color-bg-soft));
}

.kg-briefing-header svg {
	color: var(--color-brand);
	flex-shrink: 0;
}

.kg-briefing-title {
	font-weight: var(--font-weight-semibold);
	font-size: 0.75rem;
	color: var(--color-brand);
}

.kg-briefing-sub {
	font-size: 0.625rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
	margin-left: auto;
}

@media (max-width: 540px) {
	.kg-briefing-sub {
		display: none;
	}
}

.kg-briefing-body {
	padding: 12px 14px;
}

.kg-briefing-body p {
	font-size: 0.8125rem;
	color: var(--color-text-secondary);
	line-height: 1.65;
	margin: 0;
}
</style>
