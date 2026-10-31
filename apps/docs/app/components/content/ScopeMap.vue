<script setup lang="ts">
import { ref, onMounted } from 'vue';
import ScopeMapCard from '../diagrams/ScopeMapCard.vue';
import { apps, connections, packages, type Connection } from '../../utils/diagrams/scopeMap';

const visible = ref(false);
onMounted(() => {
	requestAnimationFrame(() => {
		visible.value = true;
	});
});

const activeConnection = ref<Connection | null>(null);

function isHighlighted(name: string): boolean {
	if (!activeConnection.value) return false;
	return activeConnection.value.from === name || activeConnection.value.to === name;
}
</script>

<template>
	<div class="scope-map" :class="{ 'is-visible': visible }">
		<!-- Apps section -->
		<div class="scope-section" :style="{ '--stagger': 0 }">
			<div class="scope-section-header">
				<span class="scope-section-label scope-section-label--brand">Applications</span>
				<span class="scope-section-count">{{ apps.length }} apps</span>
			</div>
			<div class="scope-grid scope-grid--apps">
				<ScopeMapCard
					v-for="(app, i) in apps"
					:key="app.name"
					:item="app"
					tone="brand"
					:highlighted="isHighlighted(app.name)"
					:stagger="i"
				/>
			</div>
		</div>

		<!-- Connection strip -->
		<div class="scope-connections" :style="{ '--stagger': 1 }">
			<div class="scope-connections-line" />
			<div class="scope-connections-labels">
				<div
					v-for="conn in connections"
					:key="`${conn.from}-${conn.to}`"
					class="scope-conn-tag"
					:class="{
						'scope-conn-tag--dashed': conn.dashed,
						'scope-conn-tag--active': activeConnection === conn,
					}"
					@mouseenter="activeConnection = conn"
					@mouseleave="activeConnection = null"
				>
					<span class="scope-conn-from">{{ conn.from }}</span>
					<svg class="scope-conn-arrow" width="12" height="8" viewBox="0 0 12 8" fill="none">
						<path
							d="M1 4h10m0 0L8 1m3 3L8 7"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
					<span class="scope-conn-to">{{ conn.to }}</span>
					<span class="scope-conn-label">{{ conn.label }}</span>
				</div>
			</div>
			<div class="scope-connections-line" />
		</div>

		<!-- Packages section -->
		<div class="scope-section" :style="{ '--stagger': 2 }">
			<div class="scope-section-header">
				<span class="scope-section-label scope-section-label--accent">Packages</span>
				<span class="scope-section-count">{{ packages.length }} packages</span>
			</div>
			<div class="scope-grid scope-grid--packages">
				<ScopeMapCard
					v-for="(pkg, i) in packages"
					:key="pkg.name"
					:item="pkg"
					tone="accent"
					:highlighted="isHighlighted(pkg.name)"
					:stagger="apps.length + i"
				/>
			</div>
		</div>

		<!-- Shared dependency note -->
		<div class="scope-shared-note" :style="{ '--stagger': 3 }">
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
				<path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
			</svg>
			<span
				>All packages import from <code>shared</code> for block types, editor types, and
				compatibility data.</span
			>
		</div>
	</div>
</template>

<style scoped>
.scope-map {
	margin: 2rem 0;
	display: flex;
	flex-direction: column;
	gap: 0;
}

/* ── Sections ── */
.scope-section {
	opacity: 0;
	transform: translateY(16px);
	transition:
		opacity 0.6s var(--ease-spring),
		transform 0.6s var(--ease-spring);
	transition-delay: calc(var(--stagger) * 0.18s);
}

.is-visible .scope-section {
	opacity: 1;
	transform: translateY(0);
}

.scope-section-header {
	display: flex;
	align-items: baseline;
	gap: 10px;
	margin-bottom: 14px;
}

.scope-section-label {
	font-weight: var(--font-weight-semibold);
	font-size: 0.9375rem;
	letter-spacing: -0.01em;
}

.scope-section-label--brand {
	color: var(--color-brand);
}
.scope-section-label--accent {
	color: var(--color-accent);
}

.scope-section-count {
	font-size: 0.75rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
}

/* ── Grid ── */
.scope-grid {
	display: grid;
	gap: 10px;
}

.scope-grid--apps {
	grid-template-columns: repeat(3, 1fr);
}

.scope-grid--packages {
	grid-template-columns: repeat(2, 1fr);
}

@media (max-width: 720px) {
	.scope-grid--apps {
		grid-template-columns: repeat(2, 1fr);
	}
	.scope-grid--packages {
		grid-template-columns: 1fr;
	}
}

@media (max-width: 480px) {
	.scope-grid--apps {
		grid-template-columns: 1fr;
	}
}

/* ── Connections strip ── */
.scope-connections {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 0;
	padding: 6px 0;
	opacity: 0;
	transition: opacity var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--stagger) * 0.18s + 0.1s);
}

.is-visible .scope-connections {
	opacity: 1;
}

.scope-connections-line {
	width: 2px;
	height: 20px;
	background: var(--color-border-strong);
	border-radius: 1px;
	position: relative;
}

.is-visible .scope-connections-line {
	animation: scope-line-draw 0.6s var(--ease-spring) both;
	animation-delay: calc(var(--stagger) * 0.18s + 0.3s);
}

@keyframes scope-line-draw {
	from {
		transform: scaleY(0);
	}
	to {
		transform: scaleY(1);
	}
}

.is-visible .scope-connections-line::after {
	content: '';
	position: absolute;
	left: -1px;
	width: 4px;
	height: 4px;
	border-radius: 50%;
	background: var(--color-brand-dim);
	animation: scope-traveling-dot 3s ease-in-out infinite 1.5s;
}

@keyframes scope-traveling-dot {
	0% {
		top: 0;
		opacity: 0;
	}
	10% {
		opacity: 1;
	}
	90% {
		opacity: 1;
	}
	100% {
		top: 100%;
		opacity: 0;
	}
}

.scope-connections-labels {
	display: flex;
	flex-wrap: wrap;
	justify-content: center;
	gap: 6px;
	padding: 8px 0;
	max-width: 100%;
}

/* ── Connection tags ── */
.scope-conn-tag {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 4px 10px;
	border-radius: 6px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	font-size: 0.6875rem;
	font-family: var(--font-mono);
	color: var(--color-text-secondary);
	cursor: default;
	transition:
		border-color var(--motion-moderate),
		background var(--motion-moderate),
		box-shadow var(--motion-moderate);
	white-space: nowrap;
}

.scope-conn-tag--dashed {
	border-style: dashed;
}

.scope-conn-tag:hover,
.scope-conn-tag--active {
	border-color: var(--color-brand);
	background: color-mix(in oklab, var(--color-brand) 6%, var(--color-bg-surface));
	box-shadow: 0 0 8px rgba(196, 120, 90, 0.1);
}

.scope-conn-from,
.scope-conn-to {
	font-weight: var(--font-weight-semibold);
	color: var(--color-text-primary);
}

.scope-conn-arrow {
	color: var(--color-text-disabled);
	flex-shrink: 0;
}

.scope-conn-label {
	color: var(--color-text-tertiary);
	margin-left: 2px;
}

/* ── Shared note ── */
.scope-shared-note {
	display: flex;
	align-items: center;
	gap: 10px;
	margin-top: 16px;
	padding: 12px 16px;
	border-radius: 10px;
	border: 1px dashed var(--color-border-default);
	background: var(--color-bg-soft);
	font-size: 0.8125rem;
	color: var(--color-text-secondary);
	opacity: 0;
	transform: translateY(12px);
	transition:
		opacity 0.6s var(--ease-spring),
		transform 0.6s var(--ease-spring),
		border-color var(--motion-moderate);
	transition-delay: calc(var(--stagger) * 0.18s);
}

.is-visible .scope-shared-note {
	opacity: 1;
	transform: translateY(0);
}

.scope-shared-note:hover {
	border-color: color-mix(in oklab, var(--color-accent) 40%, var(--color-border-default));
}

.scope-shared-note svg {
	color: var(--color-accent);
	flex-shrink: 0;
}

.scope-shared-note code {
	font-family: var(--font-mono);
	font-size: 0.8125rem;
	color: var(--color-accent);
	background: color-mix(in oklab, var(--color-accent) 10%, var(--color-bg-surface));
	padding: 1px 5px;
	border-radius: 4px;
}
</style>
