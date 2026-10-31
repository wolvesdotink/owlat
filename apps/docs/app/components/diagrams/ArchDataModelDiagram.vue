<script setup lang="ts">
/**
 * The layered entity diagram of `ArchDataModel`. Owns the hover state: hovering
 * an entity dims everything it is not connected to.
 *
 * The entrance rules key off the parent's `.is-visible`; scoped CSS only
 * scopes the last selector part, so that ancestor class still matches.
 */
import { ref } from 'vue';
import { connections, layers, typeConfig } from '../../utils/diagrams/archDataModel';

const activeEntity = ref<string | null>(null);

function isConnected(entityId: string) {
	if (!activeEntity.value) return true;
	if (entityId === activeEntity.value) return true;
	return connections[activeEntity.value]?.includes(entityId) ?? false;
}
</script>

<template>
	<div class="dm-diagram" @mouseleave="activeEntity = null">
		<div class="dm-diagram-label">
			<span class="dm-diagram-label-tag">Data Model</span>
			<span class="dm-diagram-label-sub">Entity relationships</span>
		</div>

		<div class="dm-layers">
			<div
				v-for="(layer, li) in layers"
				:key="layer.label"
				class="dm-layer"
				:style="{ '--li': li }"
			>
				<!-- Layer header -->
				<div class="dm-layer-header">
					<span class="dm-layer-name">{{ layer.label }}</span>
					<span class="dm-layer-sub">{{ layer.sublabel }}</span>
				</div>

				<!-- Entity cards -->
				<div
					class="dm-layer-entities"
					:class="{ 'dm-layer-entities--single': layer.entities.length === 1 }"
				>
					<div
						v-for="(entity, ei) in layer.entities"
						:key="entity.id"
						class="dm-entity"
						:class="[
							`dm-entity--${typeConfig[entity.type].color}`,
							{
								'is-active': activeEntity === entity.id,
								'is-dimmed': activeEntity !== null && !isConnected(entity.id),
							},
						]"
						:style="{ '--ei': ei, '--li': li }"
						@mouseenter="activeEntity = entity.id"
					>
						<div class="dm-entity-icon">
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
								<path :d="typeConfig[entity.type].icon" />
							</svg>
						</div>
						<div class="dm-entity-text">
							<div class="dm-entity-top">
								<span class="dm-entity-type">{{ typeConfig[entity.type].label }}</span>
							</div>
							<span class="dm-entity-label">{{ entity.label }}</span>
							<span class="dm-entity-detail">{{ entity.detail }}</span>
						</div>
					</div>
				</div>

				<!-- Flow arrow between layers -->
				<div v-if="li < layers.length - 1" class="dm-flow-arrow" :style="{ '--li': li }">
					<svg width="16" height="20" viewBox="0 0 16 20" fill="none">
						<path
							d="M8 0 L8 14 M3 10 L8 16 L13 10"
							stroke="currentColor"
							stroke-width="1.2"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
				</div>
			</div>
		</div>
	</div>
</template>

<style scoped>
/* ── Diagram container ── */
.dm-diagram {
	border: 1px solid var(--color-border-default);
	border-radius: 12px;
	background: var(--color-bg-elevated);
	padding: 40px 16px 16px;
	overflow: hidden;
	opacity: 0;
	transform: translateY(12px);
	transition:
		opacity 0.6s var(--ease-spring),
		transform 0.6s var(--ease-spring),
		border-color var(--motion-moderate);
}

.dm-diagram::before {
	content: '';
	position: absolute;
	inset: 0;
	background:
		radial-gradient(ellipse at 30% 25%, rgba(196, 120, 90, 0.04) 0%, transparent 50%),
		radial-gradient(ellipse at 70% 70%, rgba(107, 143, 168, 0.04) 0%, transparent 50%);
	pointer-events: none;
}

.is-visible .dm-diagram {
	opacity: 1;
	transform: translateY(0);
}

.dm-diagram:hover {
	border-color: var(--color-border-strong);
}

.dm-diagram-label {
	position: absolute;
	top: 12px;
	left: 14px;
	display: flex;
	align-items: center;
	gap: 8px;
	z-index: 2;
}

.dm-diagram-label-tag {
	font-size: 0.6875rem;
	font-weight: 700;
	padding: 2px 8px;
	border-radius: 4px;
	background: color-mix(in oklab, var(--color-brand) 10%, var(--color-bg-surface));
	border: 1px solid color-mix(in oklab, var(--color-brand) 18%, var(--color-border-subtle));
	color: var(--color-brand);
}

.dm-diagram-label-sub {
	font-size: 0.625rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
}

/* ── Layers ── */
.dm-layers {
	display: flex;
	flex-direction: column;
	gap: 0;
}

.dm-layer {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 0;
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(0.15s + var(--li) * 0.1s);
}

.is-visible .dm-layer {
	opacity: 1;
	transform: translateY(0);
}

.dm-layer-header {
	display: flex;
	align-items: center;
	gap: 6px;
	margin-bottom: 6px;
}

.dm-layer-name {
	font-size: 0.5625rem;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.08em;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
}

.dm-layer-sub {
	font-size: 0.5625rem;
	color: var(--color-text-tertiary);
	opacity: 0.6;
	font-family: var(--font-mono);
}

.dm-layer-sub::before {
	content: '·';
	margin-right: 6px;
}

/* ── Entity cards row ── */
.dm-layer-entities {
	display: flex;
	gap: 8px;
	width: 100%;
	justify-content: center;
}

.dm-layer-entities--single {
	max-width: 320px;
}

/* ── Entity card ── */
.dm-entity {
	display: flex;
	align-items: flex-start;
	gap: 8px;
	padding: 8px 12px;
	border-radius: 8px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	flex: 1;
	min-width: 0;
	max-width: 220px;
	cursor: default;
	transition:
		opacity var(--motion-moderate),
		border-color var(--motion-moderate),
		box-shadow var(--motion-moderate),
		filter var(--motion-moderate),
		transform var(--motion-moderate);
	opacity: 0;
	transform: translateY(4px);
	animation: dm-entity-enter 0.4s var(--ease-spring) both;
	animation-delay: calc(0.25s + var(--li) * 0.1s + var(--ei) * 0.05s);
}

.is-visible .dm-entity {
	opacity: 1;
	transform: translateY(0);
}

.dm-entity:hover,
.dm-entity.is-active {
	border-color: var(--color-border-default);
	box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
	transform: translateY(-1px);
}

.dm-entity.is-dimmed {
	opacity: 0.25;
	filter: grayscale(0.4);
	transform: translateY(0);
}

@keyframes dm-entity-enter {
	from {
		opacity: 0;
		transform: translateY(6px);
	}
	to {
		opacity: 1;
		transform: translateY(0);
	}
}

/* Color-coded left accent */
.dm-entity--brand {
	border-left: 2px solid var(--color-brand);
}
.dm-entity--accent {
	border-left: 2px solid var(--color-accent);
}
.dm-entity--info {
	border-left: 2px solid var(--color-info);
}
.dm-entity--warning {
	border-left: 2px solid var(--color-warning);
}
.dm-entity--success {
	border-left: 2px solid var(--color-success);
}

.dm-entity--brand.is-active {
	border-left-color: var(--color-brand);
	box-shadow: 0 2px 12px color-mix(in oklab, var(--color-brand) 15%, transparent);
}
.dm-entity--accent.is-active {
	border-left-color: var(--color-accent);
	box-shadow: 0 2px 12px color-mix(in oklab, var(--color-accent) 15%, transparent);
}
.dm-entity--info.is-active {
	border-left-color: var(--color-info);
	box-shadow: 0 2px 12px color-mix(in oklab, var(--color-info) 15%, transparent);
}
.dm-entity--warning.is-active {
	border-left-color: var(--color-warning);
	box-shadow: 0 2px 12px color-mix(in oklab, var(--color-warning) 15%, transparent);
}
.dm-entity--success.is-active {
	border-left-color: var(--color-success);
	box-shadow: 0 2px 12px color-mix(in oklab, var(--color-success) 15%, transparent);
}

.dm-entity-icon {
	flex-shrink: 0;
	width: 28px;
	height: 28px;
	border-radius: 6px;
	display: flex;
	align-items: center;
	justify-content: center;
	margin-top: 1px;
}

.dm-entity--brand .dm-entity-icon {
	background: color-mix(in oklab, var(--color-brand) 10%, var(--color-bg-surface));
	color: var(--color-brand);
}
.dm-entity--accent .dm-entity-icon {
	background: color-mix(in oklab, var(--color-accent) 10%, var(--color-bg-surface));
	color: var(--color-accent);
}
.dm-entity--info .dm-entity-icon {
	background: color-mix(in oklab, var(--color-info) 10%, var(--color-bg-surface));
	color: var(--color-info);
}
.dm-entity--warning .dm-entity-icon {
	background: color-mix(in oklab, var(--color-warning) 10%, var(--color-bg-surface));
	color: var(--color-warning);
}
.dm-entity--success .dm-entity-icon {
	background: color-mix(in oklab, var(--color-success) 10%, var(--color-bg-surface));
	color: var(--color-success);
}

.dm-entity-text {
	display: flex;
	flex-direction: column;
	gap: 0;
	min-width: 0;
}

.dm-entity-top {
	display: flex;
	align-items: center;
	gap: 4px;
}

.dm-entity-type {
	font-size: 0.5625rem;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.06em;
}

.dm-entity--brand .dm-entity-type {
	color: var(--color-brand);
}
.dm-entity--accent .dm-entity-type {
	color: var(--color-accent);
}
.dm-entity--info .dm-entity-type {
	color: var(--color-info);
}
.dm-entity--warning .dm-entity-type {
	color: var(--color-warning);
}
.dm-entity--success .dm-entity-type {
	color: var(--color-success);
}

.dm-entity-label {
	font-weight: var(--font-weight-semibold);
	font-size: 0.75rem;
	color: var(--color-text-primary);
	line-height: 1.3;
}

.dm-entity-detail {
	font-size: 0.5625rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
	line-height: 1.4;
}

/* ── Flow arrows between layers ── */
.dm-flow-arrow {
	display: flex;
	justify-content: center;
	padding: 6px 0;
	color: var(--color-border-default);
	opacity: 0;
	transition: opacity var(--motion-slow) var(--ease-spring);
	transition-delay: calc(0.3s + var(--li) * 0.1s);
}

.is-visible .dm-flow-arrow {
	opacity: 0.5;
}

/* ── Responsive ── */
@media (max-width: 600px) {
	.dm-layer-entities {
		flex-wrap: wrap;
	}

	.dm-entity {
		max-width: none;
		flex: 1 1 calc(50% - 4px);
		min-width: 140px;
	}
}

@media (max-width: 480px) {
	.dm-entity {
		flex: 1 1 100%;
	}

	.dm-entity-icon {
		display: none;
	}

	.dm-layer-sub {
		display: none;
	}
}
</style>
