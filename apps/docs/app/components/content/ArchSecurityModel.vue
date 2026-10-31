<script setup lang="ts">
import { ref, onMounted } from 'vue';
import ArchSecurityModelRings from '../diagrams/ArchSecurityModelRings.vue';
import { layers, stateIcons } from '../../utils/diagrams/archSecurityModel';

const visible = ref(false);
onMounted(() => {
	requestAnimationFrame(() => {
		visible.value = true;
	});
});
</script>

<template>
	<div class="sec" :class="{ 'is-visible': visible }">
		<!-- Nested rings visualization -->
		<ArchSecurityModelRings />

		<!-- Four security layers -->
		<div class="sec-layers" :style="{ '--stagger': 1 }">
			<div
				v-for="(layer, i) in layers"
				:key="layer.id"
				class="sec-layer"
				:class="`sec-layer--${layer.color}`"
				:style="{ '--i': i }"
			>
				<div class="sec-layer-header">
					<div class="sec-layer-icon" :class="`sec-layer-icon--${layer.color}`">
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
							<path :d="layer.icon" />
						</svg>
					</div>
					<div class="sec-layer-title-group">
						<span class="sec-layer-title">{{ layer.label }}</span>
						<span class="sec-layer-detail">{{ layer.detail }}</span>
					</div>
				</div>
				<div class="sec-layer-items">
					<div
						v-for="item in layer.items"
						:key="item.label"
						class="sec-layer-item"
						:class="`sec-layer-item--${item.state}`"
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
							<path :d="stateIcons[item.state]" />
						</svg>
						<span>{{ item.label }}</span>
					</div>
				</div>
			</div>
		</div>

		<!-- Data flow example -->
		<div class="sec-example" :style="{ '--stagger': 2 }">
			<div class="sec-example-header">
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
				<span class="sec-example-title">Example: Agent processes support email for Customer A</span>
			</div>
			<div class="sec-example-steps">
				<div class="sec-example-step">
					<span class="sec-example-check sec-example-check--pass">✓</span>
					<span class="sec-example-text">Tenant gate — agent context loaded for Org X only</span>
				</div>
				<div class="sec-example-step">
					<span class="sec-example-check sec-example-check--pass">✓</span>
					<span class="sec-example-text"
						>Sandbox — booking API credentials scoped to Customer A</span
					>
				</div>
				<div class="sec-example-step">
					<span class="sec-example-check sec-example-check--fail">✗</span>
					<span class="sec-example-text"
						>Customer B's booking data — <strong>access denied</strong></span
					>
				</div>
				<div class="sec-example-step">
					<span class="sec-example-check sec-example-check--pass">✓</span>
					<span class="sec-example-text">Draft produced — full trace logged to audit</span>
				</div>
				<div class="sec-example-step">
					<span class="sec-example-check sec-example-check--pass">✓</span>
					<span class="sec-example-text"
						>Routed to verification queue — human reviews before send</span
					>
				</div>
			</div>
		</div>
	</div>
</template>

<style scoped>
.sec {
	margin: 2rem 0;
	display: flex;
	flex-direction: column;
	gap: 12px;
}

/* ── Four layers detail grid ── */
.sec-layers {
	display: grid;
	grid-template-columns: repeat(2, 1fr);
	gap: 8px;
	opacity: 0;
	transform: translateY(10px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .sec-layers {
	opacity: 1;
	transform: translateY(0);
}

@media (max-width: 540px) {
	.sec-layers {
		grid-template-columns: 1fr;
	}
}

.sec-layer {
	padding: 12px 14px;
	border-radius: 9px;
	background: var(--color-bg-elevated);
	border: 1px solid var(--color-border-default);
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity 0.45s var(--ease-spring),
		transform 0.45s var(--ease-spring),
		border-color var(--motion-moderate),
		box-shadow var(--motion-moderate);
	transition-delay: calc(0.2s + var(--i) * 0.07s);
}

.is-visible .sec-layer {
	opacity: 1;
	transform: translateY(0);
}

.sec-layer:hover {
	border-color: var(--color-border-strong);
	box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
	transition-delay: 0s;
}

.sec-layer-header {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-bottom: 10px;
}

.sec-layer-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 28px;
	border-radius: 7px;
	flex-shrink: 0;
	transition: box-shadow var(--motion-moderate);
}

.sec-layer:hover .sec-layer-icon {
	box-shadow: 0 0 8px rgba(196, 120, 90, 0.1);
}

.sec-layer-icon--brand {
	background: color-mix(in oklab, var(--color-brand) 10%, var(--color-bg-surface));
	color: var(--color-brand);
}
.sec-layer-icon--accent {
	background: color-mix(in oklab, var(--color-accent) 10%, var(--color-bg-surface));
	color: var(--color-accent);
}
.sec-layer-icon--info {
	background: color-mix(in oklab, var(--color-info) 10%, var(--color-bg-surface));
	color: var(--color-info);
}
.sec-layer-icon--success {
	background: color-mix(in oklab, var(--color-success) 10%, var(--color-bg-surface));
	color: var(--color-success);
}

.sec-layer-title-group {
	display: flex;
	flex-direction: column;
	gap: 0;
	min-width: 0;
}

.sec-layer-title {
	font-weight: var(--font-weight-semibold);
	font-size: 0.8125rem;
	color: var(--color-text-primary);
	line-height: 1.3;
}

.sec-layer--brand .sec-layer-title {
	color: var(--color-brand);
}
.sec-layer--accent .sec-layer-title {
	color: var(--color-accent);
}
.sec-layer--info .sec-layer-title {
	color: var(--color-info);
}
.sec-layer--success .sec-layer-title {
	color: var(--color-success);
}

.sec-layer-detail {
	font-size: 0.625rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
}

/* Layer items */
.sec-layer-items {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.sec-layer-item {
	display: flex;
	align-items: center;
	gap: 5px;
	padding: 3px 8px;
	border-radius: 4px;
	font-size: 0.6875rem;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
}

.sec-layer-item span {
	color: var(--color-text-secondary);
}

.sec-layer-item--active svg {
	color: var(--color-success);
}
.sec-layer-item--blocked svg {
	color: var(--color-error);
}
.sec-layer-item--blocked span {
	color: var(--color-text-tertiary);
}
.sec-layer-item--scoped svg {
	color: var(--color-accent);
}
.sec-layer-item--denied svg {
	color: var(--color-error);
}
.sec-layer-item--denied span {
	color: var(--color-text-tertiary);
}
.sec-layer-item--logged svg {
	color: var(--color-info);
}
.sec-layer-item--auto svg {
	color: var(--color-success);
}
.sec-layer-item--human svg {
	color: var(--color-brand);
}

/* ── Example scenario ── */
.sec-example {
	border: 1px solid color-mix(in oklab, var(--color-brand) 15%, var(--color-border-default));
	border-radius: 10px;
	background: var(--color-bg-elevated);
	overflow: hidden;
	opacity: 0;
	transform: translateY(10px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring),
		box-shadow var(--motion-moderate);
	transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .sec-example {
	opacity: 1;
	transform: translateY(0);
}

.sec-example:hover {
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
}

.sec-example-header {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 10px 14px;
	background: color-mix(in oklab, var(--color-brand) 3%, var(--color-bg-soft));
	border-bottom: 1px solid var(--color-border-subtle);
}

.sec-example-header svg {
	color: var(--color-brand);
	flex-shrink: 0;
}

.sec-example-title {
	font-size: 0.75rem;
	font-weight: var(--font-weight-semibold);
	color: var(--color-text-primary);
}

.sec-example-steps {
	padding: 10px 14px;
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.sec-example-step {
	display: flex;
	align-items: flex-start;
	gap: 8px;
}

.sec-example-check {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 18px;
	height: 18px;
	border-radius: 50%;
	font-size: 0.625rem;
	font-weight: 700;
	flex-shrink: 0;
	line-height: 1;
}

.sec-example-check--pass {
	background: color-mix(in oklab, var(--color-success) 12%, var(--color-bg-surface));
	color: var(--color-success);
	border: 1px solid color-mix(in oklab, var(--color-success) 25%, var(--color-border-subtle));
}

.sec-example-check--fail {
	background: color-mix(in oklab, var(--color-error) 12%, var(--color-bg-surface));
	color: var(--color-error);
	border: 1px solid color-mix(in oklab, var(--color-error) 25%, var(--color-border-subtle));
}

.sec-example-text {
	font-size: 0.75rem;
	color: var(--color-text-secondary);
	line-height: 1.5;
}

.sec-example-text strong {
	color: var(--color-error);
	font-weight: var(--font-weight-semibold);
}
</style>
