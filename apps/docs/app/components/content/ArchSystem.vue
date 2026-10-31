<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { docsSendProviders } from '../../utils/sendProviderDiagrams';
import ArchSystemAnalytics from '../diagrams/ArchSystemAnalytics.vue';
import ArchSystemConnector from '../diagrams/ArchSystemConnector.vue';
import ArchSystemIcon from '../diagrams/ArchSystemIcon.vue';
import {
	backendLayer,
	frontendLayer,
	ownDetail,
	ownFeatures,
	webhooks,
} from '../../utils/diagrams/archSystem';

const visible = ref(false);
onMounted(() => {
	requestAnimationFrame(() => {
		visible.value = true;
	});
});

const providers = docsSendProviders();
</script>

<template>
	<div class="arch-system" :class="{ 'is-visible': visible }">
		<!-- Frontend layer -->
		<div class="arch-layer arch-layer--brand" :style="{ '--stagger': 0 }">
			<div class="arch-layer-header">
				<span class="arch-layer-label">{{ frontendLayer.label }}</span>
				<span class="arch-layer-tech">{{ frontendLayer.tech }}</span>
			</div>
			<div class="arch-layer-items">
				<div
					v-for="(item, ii) in frontendLayer.items"
					:key="item.name"
					class="arch-item"
					:style="{ '--item-stagger': ii }"
				>
					<ArchSystemIcon :icon="item.icon" />
					<div class="arch-item-text">
						<span class="arch-item-name">{{ item.name }}</span>
						<span class="arch-item-detail">{{ item.detail }}</span>
					</div>
				</div>
			</div>
		</div>

		<!-- Connector between frontend and backend -->
		<ArchSystemConnector variant="labels" :stagger="1" />

		<!-- Convex Backend layer -->
		<div class="arch-layer arch-layer--accent" :style="{ '--stagger': 1 }">
			<div class="arch-layer-header">
				<span class="arch-layer-label">{{ backendLayer.label }}</span>
				<span class="arch-layer-tech">{{ backendLayer.tech }}</span>
			</div>
			<div class="arch-layer-items">
				<div
					v-for="(item, ii) in backendLayer.items"
					:key="item.name"
					class="arch-item"
					:style="{ '--item-stagger': 3 + ii }"
				>
					<ArchSystemIcon :icon="item.icon" />
					<div class="arch-item-text">
						<span class="arch-item-name">{{ item.name }}</span>
						<span class="arch-item-detail">{{ item.detail }}</span>
					</div>
				</div>
			</div>
			<div class="arch-layer-items arch-layer-items--row2">
				<div
					v-for="(item, ii) in backendLayer.items2"
					:key="item.name"
					class="arch-item"
					:style="{ '--item-stagger': 6 + ii }"
				>
					<ArchSystemIcon :icon="item.icon" />
					<div class="arch-item-text">
						<span class="arch-item-name">{{ item.name }}</span>
						<span class="arch-item-detail">{{ item.detail }}</span>
					</div>
				</div>
			</div>
		</div>

		<!-- Connector between backend and externals -->
		<ArchSystemConnector variant="fork" :stagger="2" />

		<!-- Email delivery + Webhooks row -->
		<div class="arch-delivery-row" :style="{ '--stagger': 3 }">
			<!-- Primary MTA -->
			<div class="arch-primary-provider" :style="{ '--item-stagger': 9 }">
				<div class="arch-primary-provider-header">
					<ArchSystemIcon :icon="providers.own.icon" variant="primary" />
					<div class="arch-primary-provider-text">
						<span class="arch-item-name">{{ providers.own.name }}</span>
						<span class="arch-item-detail">{{ ownDetail }}</span>
					</div>
				</div>
				<div class="arch-primary-provider-features">
					<span v-for="feat in ownFeatures" :key="feat" class="arch-feature-tag">{{ feat }}</span>
				</div>
				<div class="arch-alt-providers">
					<span class="arch-alt-label">or</span>
					<div v-for="alt in providers.alternatives" :key="alt.kind" class="arch-alt-provider">
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
							<path :d="alt.icon" />
						</svg>
						<span>{{ alt.name }}</span>
					</div>
				</div>
			</div>

			<!-- Webhooks -->
			<div class="arch-external arch-external--webhooks" :style="{ '--item-stagger': 10 }">
				<ArchSystemIcon :icon="webhooks.icon" :size="18" variant="ext" />
				<span class="arch-item-name">{{ webhooks.name }}</span>
				<span class="arch-item-detail">{{ webhooks.detail }}</span>
			</div>
		</div>

		<!-- Analytics block -->
		<ArchSystemAnalytics />
	</div>
</template>

<style scoped>
.arch-system {
	margin: 2rem 0;
	display: flex;
	flex-direction: column;
	gap: 0;
	align-items: stretch;
}

/* ── Layers ── */
.arch-layer {
	border: 1px solid var(--color-border-default);
	border-radius: 12px;
	padding: 16px;
	background: var(--color-bg-elevated);
	opacity: 0;
	transform: translateY(16px);
	transition:
		opacity 0.6s var(--ease-spring),
		transform 0.6s var(--ease-spring),
		border-color var(--motion-moderate),
		box-shadow var(--motion-moderate);
	transition-delay: calc(var(--stagger) * 0.15s);
	position: relative;
	overflow: hidden;
}

.arch-layer::before {
	content: '';
	position: absolute;
	inset: 0;
	opacity: 0;
	transition: opacity var(--motion-slow);
	pointer-events: none;
}

.arch-layer--brand::before {
	background: radial-gradient(ellipse at 30% 20%, rgba(196, 120, 90, 0.06) 0%, transparent 70%);
}

.arch-layer--accent::before {
	background: radial-gradient(ellipse at 70% 80%, rgba(212, 165, 116, 0.05) 0%, transparent 70%);
}

.arch-layer:hover::before {
	opacity: 1;
}

.arch-layer:hover {
	border-color: var(--color-border-strong);
	box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
	transition-delay: 0s;
}

.is-visible .arch-layer {
	opacity: 1;
	transform: translateY(0);
}

.arch-layer-header {
	display: flex;
	align-items: baseline;
	gap: 10px;
	margin-bottom: 14px;
	padding-bottom: 10px;
	border-bottom: 1px solid var(--color-border-subtle);
}

.arch-layer-label {
	font-weight: var(--font-weight-semibold);
	font-size: 0.9375rem;
	color: var(--color-text-primary);
	letter-spacing: -0.01em;
}

.arch-layer--brand .arch-layer-label {
	color: var(--color-brand);
}
.arch-layer--accent .arch-layer-label {
	color: var(--color-accent);
}

.arch-layer-tech {
	font-size: 0.75rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
}

/* ── Items grid ── */
.arch-layer-items {
	display: grid;
	grid-template-columns: repeat(3, 1fr);
	gap: 10px;
}

.arch-layer-items--row2 {
	margin-top: 10px;
}

@media (max-width: 580px) {
	.arch-layer-items {
		grid-template-columns: 1fr;
	}
}

.arch-item {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 10px 12px;
	border-radius: 8px;
	background: var(--color-bg-surface);
	border: 1px solid transparent;
	transition:
		border-color var(--motion-moderate),
		background var(--motion-moderate),
		transform var(--motion-moderate) var(--ease-spring);
	opacity: 0;
	transform: translateY(10px) scale(0.97);
	cursor: default;
}

.is-visible .arch-item {
	opacity: 1;
	transform: translateY(0) scale(1);
	transition:
		border-color var(--motion-moderate),
		background var(--motion-moderate),
		transform var(--motion-moderate) var(--ease-spring),
		opacity var(--motion-slow) var(--ease-spring);
	transition-delay: calc(0.2s + var(--item-stagger) * 0.06s);
}

.arch-item:hover {
	border-color: var(--color-border-default);
	background: var(--color-bg-surface-hover);
	transform: translateY(-1px) scale(1.01);
	transition-delay: 0s;
}

.arch-item-text {
	display: flex;
	flex-direction: column;
	gap: 1px;
	min-width: 0;
}

.arch-item-name {
	font-weight: var(--font-weight-semibold);
	font-size: 0.8125rem;
	color: var(--color-text-primary);
	white-space: nowrap;
}

.arch-item-detail {
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
}

/* ── Delivery row ── */
.arch-delivery-row {
	display: grid;
	grid-template-columns: 1fr auto;
	gap: 10px;
	opacity: 0;
	transform: translateY(12px);
	transition:
		opacity 0.6s var(--ease-spring),
		transform 0.6s var(--ease-spring);
	transition-delay: calc(var(--stagger) * 0.15s);
}

.is-visible .arch-delivery-row {
	opacity: 1;
	transform: translateY(0);
}

@media (max-width: 580px) {
	.arch-delivery-row {
		grid-template-columns: 1fr;
	}
}

/* ── Primary provider (MTA) ── */
.arch-primary-provider {
	padding: 16px;
	border-radius: 12px;
	border: 1px solid color-mix(in oklab, var(--color-brand) 30%, var(--color-border-default));
	background: var(--color-bg-elevated);
	transition:
		border-color var(--motion-moderate),
		transform var(--motion-moderate) var(--ease-spring),
		box-shadow var(--motion-moderate);
	opacity: 0;
	transform: translateY(10px);
	position: relative;
	overflow: hidden;
}

.arch-primary-provider::before {
	content: '';
	position: absolute;
	inset: 0;
	background: radial-gradient(ellipse at 20% 30%, rgba(196, 120, 90, 0.06) 0%, transparent 70%);
	pointer-events: none;
}

.is-visible .arch-primary-provider {
	opacity: 1;
	transform: translateY(0);
	transition-delay: calc(0.3s + var(--item-stagger) * 0.08s);
}

.arch-primary-provider:hover {
	border-color: color-mix(in oklab, var(--color-brand) 50%, var(--color-border-default));
	transform: translateY(-2px);
	box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
	transition-delay: 0s;
}

.arch-primary-provider-header {
	display: flex;
	align-items: center;
	gap: 12px;
	position: relative;
}

.arch-primary-provider-text {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.arch-primary-provider-text .arch-item-name {
	font-size: 0.875rem;
}

.arch-primary-provider-features {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin-top: 10px;
	position: relative;
}

.arch-feature-tag {
	font-size: 0.6875rem;
	font-family: var(--font-mono);
	color: var(--color-text-secondary);
	background: var(--color-bg-surface);
	padding: 3px 8px;
	border-radius: 4px;
	border: 1px solid var(--color-border-subtle);
	white-space: nowrap;
}

.arch-alt-providers {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-wrap: wrap;
	margin-top: 10px;
	padding-top: 10px;
	border-top: 1px solid var(--color-border-subtle);
	position: relative;
}

.arch-alt-label {
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
	font-style: italic;
}

.arch-alt-provider {
	display: flex;
	align-items: center;
	gap: 5px;
	font-size: 0.75rem;
	color: var(--color-text-tertiary);
	padding: 3px 10px;
	border-radius: 6px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	transition:
		color var(--motion-moderate),
		border-color var(--motion-moderate);
}

.arch-alt-provider:hover {
	color: var(--color-text-secondary);
	border-color: var(--color-border-default);
}

.arch-alt-provider svg {
	color: var(--color-text-tertiary);
	flex-shrink: 0;
}

/* ── External services (webhooks) ── */
.arch-external {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 4px;
	padding: 14px 20px;
	border-radius: 10px;
	border: 1px solid var(--color-border-default);
	background: var(--color-bg-elevated);
	text-align: center;
	transition:
		border-color var(--motion-moderate),
		transform var(--motion-moderate) var(--ease-spring),
		box-shadow var(--motion-moderate);
	opacity: 0;
	transform: translateY(10px);
}

.is-visible .arch-external {
	opacity: 1;
	transform: translateY(0);
	transition-delay: calc(0.3s + var(--item-stagger) * 0.08s);
}

.arch-external:hover {
	border-color: color-mix(in oklab, var(--color-brand) 40%, var(--color-border-default));
	transform: translateY(-2px);
	box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
	transition-delay: 0s;
}
</style>
