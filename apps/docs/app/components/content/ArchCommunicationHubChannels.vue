<script setup lang="ts">
/**
 * Inbound row of `::arch-communication-hub`: one adapter card per channel.
 * Entrance and pulse animations key off the parent's `.is-visible` root.
 */
import { communicationHubChannels } from '../../utils/archCommunicationHub';
</script>

<template>
	<div class="hub-section hub-channels">
		<div class="hub-section-label">
			<span class="hub-section-tag hub-section-tag--inbound">Inbound</span>
			<span class="hub-section-title">Channel Adapters</span>
		</div>
		<div class="hub-channel-grid">
			<div
				v-for="(ch, i) in communicationHubChannels"
				:key="ch.name"
				class="hub-channel"
				:style="{ '--i': i }"
			>
				<div class="hub-channel-icon">
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path :d="ch.icon" />
					</svg>
				</div>
				<span class="hub-channel-name">{{ ch.name }}</span>
				<div class="hub-channel-pulse" />
			</div>
		</div>
	</div>
</template>

<style scoped>
.hub-section-label {
	display: flex;
	align-items: center;
	gap: 10px;
	margin-bottom: 10px;
}

.hub-section-tag {
	font-size: 0.625rem;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.08em;
	padding: 2px 8px;
	border-radius: 4px;
	line-height: 1.6;
}

.hub-section-tag--inbound {
	background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-surface));
	color: var(--color-brand);
	border: 1px solid color-mix(in oklab, var(--color-brand) 20%, var(--color-border-subtle));
}

.hub-section-title {
	font-size: 0.75rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
}

/* ── Channel cards ── */
.hub-channel-grid {
	display: grid;
	grid-template-columns: repeat(5, 1fr);
	gap: 8px;
}

@media (max-width: 600px) {
	.hub-channel-grid {
		grid-template-columns: repeat(3, 1fr);
	}
}

@media (max-width: 400px) {
	.hub-channel-grid {
		grid-template-columns: repeat(2, 1fr);
	}
}

.hub-channel {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 10px 12px;
	border-radius: 8px;
	background: var(--color-bg-elevated);
	border: 1px solid var(--color-border-default);
	position: relative;
	overflow: hidden;
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring),
		border-color var(--motion-moderate),
		box-shadow var(--motion-moderate);
	transition-delay: calc(0.1s + var(--i) * 0.06s);
}

.is-visible .hub-channel {
	opacity: 1;
	transform: translateY(0);
}

.hub-channel:hover {
	border-color: color-mix(in oklab, var(--color-brand) 30%, var(--color-border-default));
	box-shadow: 0 2px 12px rgba(196, 120, 90, 0.08);
	transition-delay: 0s;
}

.hub-channel-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 30px;
	height: 30px;
	border-radius: 7px;
	background: color-mix(in oklab, var(--color-brand) 10%, var(--color-bg-surface));
	color: var(--color-brand);
	flex-shrink: 0;
	transition: box-shadow var(--motion-moderate);
}

.hub-channel:hover .hub-channel-icon {
	box-shadow: 0 0 10px rgba(196, 120, 90, 0.15);
}

.hub-channel-name {
	font-weight: var(--font-weight-semibold);
	font-size: 0.8125rem;
	color: var(--color-text-primary);
}

.hub-channel-pulse {
	position: absolute;
	top: 6px;
	right: 6px;
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: var(--color-success);
}

.is-visible .hub-channel-pulse {
	animation: channel-pulse 2.5s ease-in-out infinite;
	animation-delay: calc(var(--i) * 0.4s + 1s);
}

@keyframes channel-pulse {
	0%,
	100% {
		opacity: 0.4;
		box-shadow: 0 0 0 0 transparent;
	}
	50% {
		opacity: 1;
		box-shadow: 0 0 6px 2px rgba(122, 155, 110, 0.3);
	}
}
</style>
