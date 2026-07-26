<script setup lang="ts">
/**
 * `::secure-email-journey` — the two-route illustration on the Secure Email
 * guide. Contrasts an ordinary hop-by-hop TLS route, where every mail server
 * is an endpoint holding plaintext, with a Sealed Mail route where the relays
 * carry ciphertext.
 *
 * This component owns the figure, heading and summary; the node/link chain and
 * its responsive collapse live in `SecureEmailJourneyRoute`, and the flow copy
 * lives in `app/utils/secureEmailJourney`.
 */
import { onMounted, ref } from 'vue';
import { secureEmailJourneyFlows } from '../../utils/secureEmailJourney';

const isVisible = ref(false);

onMounted(() => {
	requestAnimationFrame(() => {
		isVisible.value = true;
	});
});
</script>

<template>
	<div class="sej" :class="{ 'is-visible': isVisible }">
		<figure
			v-for="(flow, flowIndex) in secureEmailJourneyFlows"
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

			<SecureEmailJourneyRoute :nodes="flow.nodes" :links="flow.links" :is-visible="isVisible" />

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
	.sej-flow {
		opacity: 1;
		transform: none;
		transition: none;
	}
}
</style>
