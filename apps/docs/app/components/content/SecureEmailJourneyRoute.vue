<script setup lang="ts">
/**
 * One route through the mail system: the alternating node → link → node chain
 * rendered by `SecureEmailJourney`.
 *
 * Split out of the parent so each file stays inside the ~500 LOC guideline the
 * repo's file-size ratchet enforces. The seam is a real one — this component
 * owns the whole node/link grid and its responsive collapse, while the parent
 * owns the surrounding figure, heading and summary.
 *
 * `--flow-color` and `--flow-index` are NOT props: they are custom properties
 * set by the parent on `.sej-flow`, and CSS custom properties inherit, so the
 * per-flow colour and stagger reach this subtree on their own.
 */
import type { SecureEmailJourneyNode } from '../../utils/secureEmailJourney';

defineProps<{
	nodes: SecureEmailJourneyNode[];
	links: string[];
	/**
	 * Drives the entrance stagger. Passed explicitly rather than read from an
	 * ancestor `.is-visible` class so the component does not depend on a
	 * selector that lives in the parent's scoped stylesheet.
	 */
	isVisible: boolean;
}>();
</script>

<template>
	<div class="sej-route" :class="{ 'is-visible': isVisible }">
		<template v-for="(node, nodeIndex) in nodes" :key="node.label">
			<div
				class="sej-node"
				:class="{ 'is-sealed': node.badge === 'Sealed' }"
				:style="{ '--node-index': nodeIndex }"
			>
				<div class="sej-icon">
					<svg
						width="22"
						height="22"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path :d="node.icon" />
					</svg>
				</div>
				<span class="sej-node-label">{{ node.label }}</span>
				<span class="sej-node-detail">{{ node.detail }}</span>
				<span class="sej-node-badge">{{ node.badge }}</span>
			</div>

			<div v-if="nodeIndex < links.length" class="sej-link">
				<span class="sej-link-label">
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
						<path d="M7 11V8a5 5 0 0110 0v3M6 11h12v9H6z" />
					</svg>
					{{ links[nodeIndex] }}
				</span>
				<div class="sej-link-line">
					<span class="sej-packet">
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
							<path d="M4 6h16v12H4zM4 8l8 5 8-5" />
						</svg>
					</span>
				</div>
			</div>
		</template>
	</div>
</template>

<style scoped>
.sej-route {
	display: grid;
	grid-template-columns:
		minmax(80px, 1fr) minmax(70px, 0.72fr) minmax(80px, 1fr) minmax(70px, 0.72fr)
		minmax(80px, 1fr) minmax(70px, 0.72fr) minmax(80px, 1fr);
	align-items: start;
}

.sej-node {
	display: flex;
	min-width: 0;
	align-items: center;
	flex-direction: column;
	gap: 3px;
	text-align: center;
	opacity: 0;
	transform: scale(0.94);
	transition:
		opacity 0.45s var(--ease-spring),
		transform 0.45s var(--ease-spring);
	transition-delay: calc(0.18s + var(--flow-index) * 0.12s + var(--node-index) * 0.08s);
}

.sej-route.is-visible .sej-node {
	opacity: 1;
	transform: scale(1);
}

.sej-icon {
	display: grid;
	width: 48px;
	height: 48px;
	margin-bottom: 4px;
	place-items: center;
	border: 1px solid color-mix(in oklab, var(--flow-color) 28%, var(--color-border-default));
	border-radius: 13px;
	background: color-mix(in oklab, var(--flow-color) 8%, var(--color-bg-surface));
	box-shadow: 0 8px 24px color-mix(in oklab, var(--flow-color) 8%, transparent);
	color: var(--flow-color);
	transition:
		transform var(--motion-moderate) var(--ease-spring),
		box-shadow var(--motion-moderate) var(--ease-spring);
}

.sej-node:hover .sej-icon {
	transform: translateY(-2px);
	box-shadow: 0 10px 28px color-mix(in oklab, var(--flow-color) 15%, transparent);
}

.sej-node-label {
	color: var(--color-text-primary);
	font-size: 0.6875rem;
	font-weight: var(--font-weight-semibold);
	line-height: 1.35;
}

.sej-node-detail {
	color: var(--color-text-tertiary);
	font-size: 0.625rem;
	line-height: 1.35;
}

.sej-node-badge {
	margin-top: 4px;
	padding: 1px 7px;
	border-radius: 999px;
	background: var(--color-bg-soft);
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
	font-size: 0.5625rem;
	font-weight: var(--font-weight-semibold);
	letter-spacing: 0.03em;
	text-transform: uppercase;
}

.sej-node.is-sealed .sej-node-badge {
	background: color-mix(in oklab, var(--color-success) 10%, var(--color-bg-surface));
	color: var(--color-success);
}

.sej-link {
	position: relative;
	min-width: 0;
	padding-top: 16px;
}

.sej-link-label {
	display: flex;
	min-height: 18px;
	align-items: center;
	justify-content: center;
	gap: 4px;
	color: var(--flow-color);
	font-family: var(--font-mono);
	font-size: 0.5625rem;
	font-weight: var(--font-weight-semibold);
	white-space: nowrap;
}

.sej-link-line {
	position: relative;
	height: 1px;
	margin-top: 8px;
	background: color-mix(in oklab, var(--flow-color) 42%, var(--color-border-default));
}

.sej-link-line::after {
	position: absolute;
	top: -3px;
	right: -1px;
	width: 7px;
	height: 7px;
	border-top: 1px solid var(--flow-color);
	border-right: 1px solid var(--flow-color);
	content: '';
	transform: rotate(45deg);
}

.sej-packet {
	position: absolute;
	top: -7px;
	left: 0;
	display: grid;
	width: 17px;
	height: 15px;
	place-items: center;
	border-radius: 4px;
	background: var(--color-bg-elevated);
	color: var(--flow-color);
	animation: sej-travel 3.4s ease-in-out infinite;
}

@keyframes sej-travel {
	0%,
	10% {
		left: 0;
		opacity: 0;
	}
	20% {
		opacity: 1;
	}
	80% {
		opacity: 1;
	}
	90%,
	100% {
		left: calc(100% - 16px);
		opacity: 0;
	}
}

@media (max-width: 760px) {
	.sej-route {
		grid-template-columns: 1fr;
		gap: 0;
	}

	.sej-node {
		display: grid;
		grid-template-columns: 44px minmax(0, 1fr) auto;
		grid-template-rows: auto auto;
		column-gap: 10px;
		text-align: left;
	}

	.sej-icon {
		width: 44px;
		height: 44px;
		grid-row: 1 / 3;
		margin: 0;
	}

	.sej-node-label {
		align-self: end;
	}

	.sej-node-detail {
		align-self: start;
	}

	.sej-node-badge {
		grid-column: 3;
		grid-row: 1 / 3;
		align-self: center;
		margin: 0;
	}

	.sej-link {
		display: grid;
		min-height: 48px;
		grid-template-columns: 44px minmax(0, 1fr);
		align-items: center;
		column-gap: 10px;
		padding: 0;
	}

	.sej-link-label {
		grid-column: 2;
		justify-content: flex-start;
	}

	.sej-link-line {
		position: absolute;
		top: 3px;
		bottom: 3px;
		left: 21px;
		width: 1px;
		height: auto;
		margin: 0;
	}

	.sej-link-line::after {
		top: auto;
		right: -3px;
		bottom: 0;
	}

	.sej-packet {
		display: none;
	}
}

@media (prefers-reduced-motion: reduce) {
	.sej-node {
		opacity: 1;
		transform: none;
		transition: none;
	}

	.sej-packet {
		animation: none;
	}
}
</style>
