<script setup lang="ts">
/**
 * One phase panel of the `ArchRoadmap` runway. The parent owns which phase is
 * expanded; this panel asks for it on hover, focus, Enter or Space.
 *
 * The entrance rules key off the parent's `.is-visible`; scoped CSS only
 * scopes the last selector part, so that ancestor class still matches.
 */
import type { Phase } from '../../utils/diagrams/archRoadmap';

defineProps<{
	phase: Phase;
	/** Position on the runway; drives the entrance stagger and depth. */
	index: number;
	expanded: boolean;
}>();

const emit = defineEmits<{ expand: [id: number] }>();

function onKey(e: KeyboardEvent, id: number) {
	if (e.key === 'Enter' || e.key === ' ') {
		e.preventDefault();
		emit('expand', id);
	}
}

function isFuture(s: string) {
	return s === 'planned' || s === 'future';
}
function statusText(s: string) {
	return s === 'active'
		? 'Building now'
		: s === 'upcoming'
			? 'Up next'
			: s === 'planned'
				? 'Planned'
				: 'Exploring';
}
</script>

<template>
	<div
		class="rm-phase"
		:class="[
			`rm-phase--${phase.status}`,
			{
				'is-expanded': expanded,
				'is-collapsed': !expanded,
			},
		]"
		:style="{ '--i': index, '--depth': index }"
		:tabindex="0"
		:aria-label="`Phase: ${phase.label} — ${phase.title}. ${statusText(phase.status)}. Press Enter to expand.`"
		:aria-expanded="expanded"
		role="article"
		@mouseenter="emit('expand', phase.id)"
		@focus="emit('expand', phase.id)"
		@keydown="onKey($event, phase.id)"
	>
		<!-- Phase number / marker -->
		<div class="rm-marker">
			<span class="rm-marker-num">{{ phase.label }}</span>
			<div v-if="phase.status === 'active'" class="rm-marker-ping" />
		</div>

		<!-- Content column -->
		<div class="rm-content">
			<div class="rm-head">
				<div class="rm-icon">
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
						<path :d="phase.icon" />
					</svg>
				</div>
				<div class="rm-titles">
					<span class="rm-title">{{ phase.title }}</span>
					<span class="rm-status">{{ statusText(phase.status) }}</span>
				</div>
			</div>

			<!-- Detail area: always visible for active/upcoming, animated for future -->
			<div class="rm-detail">
				<div class="rm-ships">
					<span
						v-for="(item, si) in phase.ships"
						:key="si"
						class="rm-ship"
						:style="{ '--si': si }"
						>{{ item }}</span
					>
				</div>
				<div class="rm-foundation">{{ phase.foundation }}</div>
			</div>
		</div>

		<!-- Decorative depth line -->
		<div class="rm-depth-edge" />
	</div>
</template>

<style scoped>
/* ── Phase panels ── */
.rm-phase {
	position: relative;
	display: flex;
	flex-direction: column;
	padding: 14px 18px 16px;
	border-right: 1px solid var(--color-border-subtle);
	cursor: default;
	outline: none;
	overflow: hidden;
	flex: var(--phase-flex, 3);
	min-width: 0;

	/* Entrance */
	opacity: 0;
	transform: translateY(10px);
	transition:
		opacity 0.4s var(--ease-spring),
		transform 0.4s var(--ease-spring);
}

.is-visible .rm-phase {
	opacity: 1;
	transform: translateY(0);
}

/* Expanding: width goes first (no delay) */
.rm-phase.is-expanded {
	transition:
		flex 0.4s var(--ease-spring),
		opacity 0.4s var(--ease-spring),
		transform 0.4s var(--ease-spring),
		background 0.3s;
}

/* Collapsing: width waits for content to fade out first */
.rm-phase.is-collapsed {
	transition:
		flex 0.4s var(--ease-spring) 0.15s,
		opacity 0.4s var(--ease-spring),
		transform 0.4s var(--ease-spring),
		background 0.3s;
}

.rm-phase:last-child {
	border-right: none;
}

.rm-phase:focus-visible {
	outline: 2px solid var(--color-brand);
	outline-offset: -2px;
	z-index: 2;
}

/* ── Phase sizing: expanded gets space, collapsed compress ── */
.rm-phase.is-expanded {
	--phase-flex: 5;
	background: color-mix(in oklab, var(--color-brand) 3%, transparent);
}

.rm-phase.is-collapsed {
	--phase-flex: 1;
}

/* Progressive fade for far-future collapsed phases */
.is-visible .rm-phase--planned.is-collapsed {
	opacity: 0.75;
}
.is-visible .rm-phase--future.is-collapsed {
	opacity: 0.6;
}
.is-visible .rm-phase.is-expanded {
	opacity: 1;
}

/* ── Depth edge: the right-border accent ── */
.rm-depth-edge {
	position: absolute;
	right: 0;
	top: 0;
	bottom: 0;
	width: 3px;
	opacity: 0;
	transition: opacity var(--motion-moderate);
}

.rm-phase.is-expanded .rm-depth-edge {
	background: var(--color-brand);
	opacity: 0.5;
}

.rm-phase--upcoming.is-expanded .rm-depth-edge {
	background: var(--color-info);
}

/* ── Marker ── */
.rm-marker {
	display: flex;
	align-items: center;
	gap: 6px;
	margin-bottom: 10px;
	position: relative;
}

.rm-marker-num {
	font-size: 0.5625rem;
	font-weight: 700;
	font-family: var(--font-mono);
	text-transform: uppercase;
	letter-spacing: 0.08em;
	color: var(--color-text-tertiary);
	padding: 2px 7px;
	border-radius: 3px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	transition:
		color var(--motion-moderate),
		background var(--motion-moderate),
		border-color var(--motion-moderate);
}

.rm-phase--active .rm-marker-num {
	color: var(--color-brand);
	background: color-mix(in oklab, var(--color-brand) 10%, var(--color-bg-surface));
	border-color: color-mix(in oklab, var(--color-brand) 25%, var(--color-border-subtle));
}

.rm-phase--upcoming .rm-marker-num {
	color: var(--color-info);
	background: color-mix(in oklab, var(--color-info) 8%, var(--color-bg-surface));
	border-color: color-mix(in oklab, var(--color-info) 20%, var(--color-border-subtle));
}

.rm-marker-ping {
	position: absolute;
	left: 0;
	top: 0;
	width: 100%;
	height: 100%;
	border-radius: 3px;
	border: 1.5px solid var(--color-brand);
	pointer-events: none;
	opacity: 0;
}

.is-visible .rm-marker-ping {
	animation: rm-ping 2.8s ease-out infinite 1.2s;
}

@keyframes rm-ping {
	0% {
		transform: scale(1);
		opacity: 0.5;
	}
	60% {
		transform: scale(1.5, 1.8);
		opacity: 0;
	}
	100% {
		transform: scale(1.5, 1.8);
		opacity: 0;
	}
}

/* ── Head: icon + titles ── */
.rm-head {
	display: flex;
	align-items: flex-start;
	gap: 10px;
	margin-bottom: 10px;
}

.rm-icon {
	flex-shrink: 0;
	width: 30px;
	height: 30px;
	border-radius: 7px;
	display: flex;
	align-items: center;
	justify-content: center;
	background: color-mix(in oklab, var(--color-brand) 6%, var(--color-bg-elevated));
	color: var(--color-text-secondary);
	transition:
		color var(--motion-moderate),
		background var(--motion-moderate),
		transform var(--motion-moderate) var(--ease-spring);
}

.rm-phase--active .rm-icon {
	background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
	color: var(--color-brand);
}

.rm-phase--upcoming .rm-icon {
	background: color-mix(in oklab, var(--color-info) 10%, var(--color-bg-surface));
	color: var(--color-info);
}

.rm-phase.is-expanded .rm-icon {
	transform: scale(1.05);
}

/* Smaller icon when collapsed */
.rm-phase.is-collapsed .rm-icon {
	width: 24px;
	height: 24px;
}

.rm-titles {
	display: flex;
	flex-direction: column;
	gap: 1px;
	min-width: 0;
}

.rm-title {
	font-weight: var(--font-weight-semibold);
	font-size: 0.875rem;
	color: var(--color-text-primary);
	line-height: 1.3;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	transition: font-size var(--motion-moderate);
}

.rm-phase.is-collapsed .rm-title {
	font-size: 0.75rem;
}

.rm-status {
	font-size: 0.5625rem;
	font-weight: var(--font-weight-semibold);
	font-family: var(--font-mono);
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--color-text-tertiary);
	transition: color var(--motion-moderate);
}

.rm-phase--active .rm-status {
	color: var(--color-brand);
}

.rm-phase--upcoming .rm-status {
	color: var(--color-info);
}

/* ── Detail: ships + foundation ── */
.rm-detail {
	display: flex;
	flex-direction: column;
	gap: 8px;
	opacity: 0;
	visibility: hidden;
	pointer-events: none;
	/* Collapsing: fade out immediately, then hide */
	transition:
		opacity 0.12s var(--ease-spring),
		visibility 0s linear 0.12s;
}

.rm-phase.is-expanded .rm-detail {
	opacity: 1;
	visibility: visible;
	pointer-events: auto;
	/* Expanding: wait for width to finish, then fade in */
	transition:
		visibility 0s linear var(--motion-slow),
		opacity var(--motion-moderate) var(--ease-spring) var(--motion-slow);
}

.rm-ships {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
}

.rm-ship {
	font-size: 0.5625rem;
	font-family: var(--font-mono);
	padding: 2px 6px;
	border-radius: 3px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	color: var(--color-text-secondary);
	white-space: nowrap;
	opacity: 0;
	transform: translateY(3px);
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring),
		border-color var(--motion-moderate),
		background var(--motion-moderate);
}

.is-visible .rm-ship {
	opacity: 1;
	transform: translateY(0);
}

.rm-phase.is-expanded .rm-ship {
	border-color: var(--color-border-default);
}

.rm-foundation {
	font-size: 0.5625rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
	line-height: 1.5;
	padding-top: 6px;
	border-top: 1px solid var(--color-border-subtle);
}

/* ── Responsive ── */
@media (max-width: 700px) {
	.rm-phase {
		flex: none !important;
		border-right: none;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	.rm-phase:last-child {
		border-bottom: none;
	}

	.rm-depth-edge {
		right: auto;
		left: 0;
		top: auto;
		bottom: 0;
		width: auto;
		height: 2px;
	}

	/* Show all details on mobile */
	.rm-phase .rm-detail {
		opacity: 1;
		visibility: visible;
		pointer-events: auto;
		transition: none;
	}

	.rm-phase.is-collapsed .rm-title {
		font-size: 0.875rem;
	}

	.rm-phase.is-collapsed .rm-icon {
		width: 30px;
		height: 30px;
	}
}

/* ── Reduced motion ──
   The parent's scoped `*` rule reaches this panel's root but not the elements
   inside it, so the panel repeats it. */
@media (prefers-reduced-motion: reduce) {
	*,
	*::before,
	*::after {
		transition-duration: 0.01ms !important;
		animation-duration: 0.01ms !important;
		animation-iteration-count: 1 !important;
	}
}
</style>
