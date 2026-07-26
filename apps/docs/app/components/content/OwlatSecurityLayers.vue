<script setup lang="ts">
import { onMounted, ref } from 'vue';

const visible = ref(false);

onMounted(() => {
	requestAnimationFrame(() => {
		visible.value = true;
	});
});

const layers = [
	{
		label: 'Sender identity',
		short: 'Who sent it?',
		detail: 'SPF, DKIM and DMARC badges, plus the Sealed Mail signature.',
		color: 'info',
		icon: 'M9 12l2 2 4-4m5.6-4A12 12 0 0112 3 12 12 0 013.4 6 12 12 0 003 9c0 5.6 3.8 10.3 9 11.6 5.2-1.3 9-6 9-11.6 0-1-.1-2-.4-3z',
	},
	{
		label: 'Transport',
		short: 'How did it travel?',
		detail: 'Required inbound TLS, MTA-STS, DANE posture and TLS reporting.',
		color: 'accent',
		icon: 'M5 12h14m-4-4 4 4-4 4M9 8l-4 4 4 4',
	},
	{
		label: 'Message content',
		short: 'Who can read it?',
		detail: 'OpenPGP sealing keeps the real subject and body opaque to relays.',
		color: 'success',
		icon: 'M7 11V8a5 5 0 0110 0v3m-9 0h8a2 2 0 012 2v7H6v-7a2 2 0 012-2z',
	},
	{
		label: 'Stored data',
		short: 'What rests on disk?',
		detail: 'Message bodies, raw mail blobs and mail secrets are sealed at rest.',
		color: 'brand',
		icon: 'M4 7c0 2.2 3.6 4 8 4s8-1.8 8-4-3.6-4-8-4-8 1.8-8 4zm0 0v10c0 2.2 3.6 4 8 4s8-1.8 8-4V7M4 12c0 2.2 3.6 4 8 4s8-1.8 8-4',
	},
];
</script>

<template>
	<figure class="osl" :class="{ 'is-visible': visible }">
		<figcaption class="osl-heading">
			<span>Owlat's layered model</span>
			<strong>No single protocol solves every email risk</strong>
		</figcaption>

		<div class="osl-message">
			<div class="osl-message-icon">
				<svg
					width="24"
					height="24"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path d="M4 6h16v12H4zM4 8l8 5 8-5" />
				</svg>
			</div>
			<div>
				<strong>One message</strong>
				<span>Four independent questions</span>
			</div>
		</div>

		<div class="osl-rail" aria-hidden="true" />

		<div class="osl-layers">
			<div
				v-for="(layer, index) in layers"
				:key="layer.label"
				class="osl-layer"
				:class="`osl-layer--${layer.color}`"
				:style="{ '--layer-index': index }"
			>
				<div class="osl-layer-icon">
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path :d="layer.icon" />
					</svg>
				</div>
				<div class="osl-layer-copy">
					<span class="osl-layer-short">{{ layer.short }}</span>
					<strong>{{ layer.label }}</strong>
					<span>{{ layer.detail }}</span>
				</div>
			</div>
		</div>
	</figure>
</template>

<style scoped>
.osl {
	position: relative;
	display: grid;
	grid-template-columns: minmax(126px, 0.7fr) 44px minmax(0, 2.4fr);
	align-items: center;
	gap: 0;
	margin: 2rem 0;
	padding: 20px;
	border: 1px solid var(--color-border-default);
	border-radius: 14px;
	background:
		radial-gradient(
			circle at 7% 45%,
			color-mix(in oklab, var(--color-brand) 9%, transparent),
			transparent 26%
		),
		var(--color-bg-elevated);
	overflow: hidden;
}

.osl-heading {
	grid-column: 1 / -1;
	display: flex;
	flex-direction: column;
	gap: 3px;
	margin-bottom: 18px;
}

.osl-heading > span {
	color: var(--color-brand);
	font-family: var(--font-mono);
	font-size: 0.625rem;
	font-weight: var(--font-weight-semibold);
	letter-spacing: 0.08em;
	text-transform: uppercase;
}

.osl-heading > strong {
	color: var(--color-text-primary);
	font-size: 0.9375rem;
	font-weight: var(--font-weight-semibold);
}

.osl-message {
	display: flex;
	align-items: center;
	gap: 10px;
	opacity: 0;
	transform: translateX(-10px);
	transition:
		opacity 0.5s var(--ease-spring),
		transform 0.5s var(--ease-spring);
}

.is-visible .osl-message {
	opacity: 1;
	transform: translateX(0);
}

.osl-message-icon {
	display: grid;
	width: 50px;
	height: 50px;
	flex: none;
	place-items: center;
	border: 1px solid color-mix(in oklab, var(--color-brand) 32%, var(--color-border-default));
	border-radius: 50%;
	background: color-mix(in oklab, var(--color-brand) 9%, var(--color-bg-surface));
	color: var(--color-brand);
	box-shadow: 0 0 0 8px color-mix(in oklab, var(--color-brand) 4%, transparent);
}

.osl-message > div:last-child {
	display: flex;
	min-width: 0;
	flex-direction: column;
	gap: 2px;
}

.osl-message strong {
	color: var(--color-text-primary);
	font-size: 0.75rem;
	font-weight: var(--font-weight-semibold);
}

.osl-message span {
	color: var(--color-text-tertiary);
	font-size: 0.625rem;
	line-height: 1.4;
}

.osl-rail {
	position: relative;
	height: 2px;
	margin: 0 8px;
	background: linear-gradient(to right, var(--color-brand), var(--color-border-strong));
	transform: scaleX(0);
	transform-origin: left;
	transition: transform 0.7s var(--ease-spring) 0.15s;
}

.osl-rail::after {
	position: absolute;
	top: -3px;
	right: 0;
	width: 8px;
	height: 8px;
	border-top: 2px solid var(--color-border-strong);
	border-right: 2px solid var(--color-border-strong);
	content: '';
	transform: rotate(45deg);
}

.is-visible .osl-rail {
	transform: scaleX(1);
}

.osl-layers {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 8px;
}

.osl-layer {
	--layer-color: var(--color-brand);
	display: flex;
	min-width: 0;
	align-items: flex-start;
	gap: 10px;
	padding: 11px;
	border: 1px solid var(--color-border-subtle);
	border-radius: 10px;
	background: var(--color-bg-surface);
	opacity: 0;
	transform: translateX(10px);
	transition:
		opacity 0.5s var(--ease-spring),
		transform 0.5s var(--ease-spring),
		border-color var(--motion-moderate) var(--ease-spring);
	transition-delay: calc(0.22s + var(--layer-index) * 0.08s);
}

.osl-layer--info {
	--layer-color: var(--color-info);
}

.osl-layer--accent {
	--layer-color: var(--color-accent);
}

.osl-layer--success {
	--layer-color: var(--color-success);
}

.is-visible .osl-layer {
	opacity: 1;
	transform: translateX(0);
}

.osl-layer:hover {
	border-color: color-mix(in oklab, var(--layer-color) 40%, var(--color-border-default));
}

.osl-layer-icon {
	display: grid;
	width: 32px;
	height: 32px;
	flex: none;
	place-items: center;
	border-radius: 8px;
	background: color-mix(in oklab, var(--layer-color) 10%, var(--color-bg-surface));
	color: var(--layer-color);
}

.osl-layer-copy {
	display: flex;
	min-width: 0;
	flex-direction: column;
	gap: 2px;
}

.osl-layer-short {
	color: var(--layer-color) !important;
	font-family: var(--font-mono);
	font-size: 0.5625rem !important;
	font-weight: var(--font-weight-semibold);
	letter-spacing: 0.04em;
	text-transform: uppercase;
}

.osl-layer-copy strong {
	color: var(--color-text-primary);
	font-size: 0.6875rem;
	font-weight: var(--font-weight-semibold);
}

.osl-layer-copy span:last-child {
	color: var(--color-text-tertiary);
	font-size: 0.625rem;
	line-height: 1.45;
}

@media (max-width: 760px) {
	.osl {
		grid-template-columns: 1fr;
		gap: 14px;
	}

	.osl-rail {
		width: 2px;
		height: 24px;
		margin: 0 0 0 24px;
		background: linear-gradient(to bottom, var(--color-brand), var(--color-border-strong));
		transform: scaleY(0);
		transform-origin: top;
	}

	.osl-rail::after {
		top: auto;
		right: -3px;
		bottom: 0;
	}

	.is-visible .osl-rail {
		transform: scaleY(1);
	}
}

@media (max-width: 520px) {
	.osl {
		padding: 14px;
	}

	.osl-layers {
		grid-template-columns: 1fr;
	}
}

@media (prefers-reduced-motion: reduce) {
	.osl-message,
	.osl-layer {
		opacity: 1;
		transform: none;
		transition: none;
	}

	.osl-rail {
		transform: none;
		transition: none;
	}
}
</style>
