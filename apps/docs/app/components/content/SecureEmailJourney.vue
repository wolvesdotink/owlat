<script setup lang="ts">
import { onMounted, ref } from 'vue';

const visible = ref(false);

onMounted(() => {
	requestAnimationFrame(() => {
		visible.value = true;
	});
});

const flows = [
	{
		id: 'transport',
		eyebrow: 'Ordinary secure email',
		title: 'TLS protects each connection',
		detail: 'The message is opened and handled again at every mail server.',
		state: 'Hop-by-hop',
		nodes: [
			{
				label: 'Sender',
				detail: 'Mail app',
				badge: 'Readable',
				icon: 'M4 4h16v16H4zM4 7l8 6 8-6',
			},
			{
				label: 'Sending server',
				detail: 'Queues + routes',
				badge: 'Can read',
				icon: 'M4 6h16v5H4zM4 13h16v5H4zM7 8.5h.01M7 15.5h.01',
			},
			{
				label: 'Receiving server',
				detail: 'Filters + stores',
				badge: 'Can read',
				icon: 'M4 6h16v5H4zM4 13h16v5H4zM17 8.5h.01M17 15.5h.01',
			},
			{
				label: 'Recipient',
				detail: 'Mail app',
				badge: 'Readable',
				icon: 'M3 19V9l9-6 9 6v10H3zm0-10l9 6 9-6',
			},
		],
		links: ['TLS', 'STARTTLS', 'TLS'],
	},
	{
		id: 'sealed',
		eyebrow: 'Owlat Sealed Mail',
		title: 'The message stays sealed across the route',
		detail: 'Transport TLS still protects the links, while OpenPGP protects the message itself.',
		state: 'End-to-end',
		nodes: [
			{
				label: 'Sender workspace',
				detail: 'Seal + sign',
				badge: 'Readable',
				icon: 'M7 11V8a5 5 0 0110 0v3m-9 0h8a2 2 0 012 2v7H6v-7a2 2 0 012-2z',
			},
			{
				label: 'Sending server',
				detail: 'Routes ciphertext',
				badge: 'Sealed',
				icon: 'M4 6h16v5H4zM4 13h16v5H4zM7 8.5h.01M7 15.5h.01',
			},
			{
				label: 'Receiving server',
				detail: 'Receives ciphertext',
				badge: 'Sealed',
				icon: 'M4 6h16v5H4zM4 13h16v5H4zM17 8.5h.01M17 15.5h.01',
			},
			{
				label: 'Recipient workspace',
				detail: 'Open + verify',
				badge: 'Readable',
				icon: 'M17 11V8a5 5 0 00-9.9-1M8 11h8a2 2 0 012 2v7H6v-7a2 2 0 012-2z',
			},
		],
		links: ['TLS + sealed', 'STARTTLS + sealed', 'TLS + sealed'],
	},
];
</script>

<template>
	<div class="sej" :class="{ 'is-visible': visible }">
		<figure
			v-for="(flow, flowIndex) in flows"
			:key="flow.id"
			class="sej-flow"
			:class="`sej-flow--${flow.id}`"
			:style="{ '--flow-index': flowIndex }"
		>
			<figcaption class="sej-heading">
				<div>
					<span class="sej-eyebrow">{{ flow.eyebrow }}</span>
					<strong>{{ flow.title }}</strong>
					<span class="sej-detail">{{ flow.detail }}</span>
				</div>
				<span class="sej-state">{{ flow.state }}</span>
			</figcaption>

			<div class="sej-route">
				<template v-for="(node, nodeIndex) in flow.nodes" :key="node.label">
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

					<div v-if="nodeIndex < flow.links.length" class="sej-link">
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
							{{ flow.links[nodeIndex] }}
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

			<div class="sej-summary">
				<svg
					width="15"
					height="15"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path
						v-if="flow.id === 'transport'"
						d="M12 9v4m0 4h.01M10.3 4.4L2.9 17.2A2 2 0 004.6 20h14.8a2 2 0 001.7-2.8L13.7 4.4a2 2 0 00-3.4 0z"
					/>
					<path
						v-else
						d="M9 12l2 2 4-4m5.6-4A12 12 0 0112 3 12 12 0 013.4 6 12 12 0 003 9c0 5.6 3.8 10.3 9 11.6 5.2-1.3 9-6 9-11.6 0-1-.1-2-.4-3z"
					/>
				</svg>
				<span v-if="flow.id === 'transport'">
					TLS hides traffic on the links, but each provider is still an endpoint with plaintext
					access.
				</span>
				<span v-else>
					Relays see routing headers and ciphertext; the true subject and body stay inside the
					sealed message.
				</span>
			</div>
		</figure>
	</div>
</template>

<style scoped>
.sej {
	display: grid;
	gap: 14px;
	margin: 2rem 0;
}

.sej-flow {
	margin: 0;
	padding: 18px;
	border: 1px solid var(--color-border-default);
	border-radius: 14px;
	background:
		radial-gradient(
			circle at 12% 0%,
			color-mix(in oklab, var(--flow-color) 8%, transparent),
			transparent 36%
		),
		var(--color-bg-elevated);
	overflow: hidden;
	opacity: 0;
	transform: translateY(12px);
	transition:
		opacity 0.6s var(--ease-spring),
		transform 0.6s var(--ease-spring),
		border-color var(--motion-moderate) var(--ease-spring);
	transition-delay: calc(var(--flow-index) * 0.12s);
}

.sej-flow--transport {
	--flow-color: var(--color-warning);
}

.sej-flow--sealed {
	--flow-color: var(--color-success);
}

.is-visible .sej-flow {
	opacity: 1;
	transform: translateY(0);
}

.sej-flow:hover {
	border-color: color-mix(in oklab, var(--flow-color) 46%, var(--color-border-default));
}

.sej-heading {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 18px;
	margin-bottom: 22px;
}

.sej-heading > div {
	display: flex;
	min-width: 0;
	flex-direction: column;
	gap: 3px;
}

.sej-eyebrow {
	color: var(--flow-color);
	font-family: var(--font-mono);
	font-size: 0.625rem;
	font-weight: var(--font-weight-semibold);
	letter-spacing: 0.08em;
	text-transform: uppercase;
}

.sej-heading strong {
	color: var(--color-text-primary);
	font-size: 0.9375rem;
	font-weight: var(--font-weight-semibold);
	line-height: 1.4;
}

.sej-detail {
	max-width: 36rem;
	color: var(--color-text-tertiary);
	font-size: 0.75rem;
	line-height: 1.5;
}

.sej-state {
	flex: none;
	padding: 3px 9px;
	border: 1px solid color-mix(in oklab, var(--flow-color) 28%, var(--color-border-subtle));
	border-radius: 999px;
	background: color-mix(in oklab, var(--flow-color) 9%, var(--color-bg-surface));
	color: var(--flow-color);
	font-family: var(--font-mono);
	font-size: 0.625rem;
	font-weight: var(--font-weight-semibold);
	letter-spacing: 0.03em;
}

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

.is-visible .sej-node {
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

.sej-summary {
	display: flex;
	align-items: flex-start;
	gap: 8px;
	margin-top: 20px;
	padding: 9px 11px;
	border-radius: 8px;
	background: color-mix(in oklab, var(--flow-color) 7%, var(--color-bg-surface));
	color: var(--color-text-secondary);
	font-size: 0.6875rem;
	line-height: 1.5;
}

.sej-summary svg {
	flex: none;
	margin-top: 1px;
	color: var(--flow-color);
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

@media (max-width: 460px) {
	.sej-flow {
		padding: 14px;
	}

	.sej-heading {
		flex-direction: column;
		gap: 8px;
	}
}

@media (prefers-reduced-motion: reduce) {
	.sej-flow,
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
