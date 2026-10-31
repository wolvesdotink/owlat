<script setup lang="ts">
/**
 * `::arch-communication-hub` — the Vision page's end-to-end diagram: inbound
 * channels → content filter → agent pipeline (with the knowledge graph) →
 * verification queue → outbound delivery.
 *
 * This component owns the column layout, the staggered entrance and the
 * connectors between stages; each stage is its own `ArchCommunicationHub*`
 * component, the shared card shell is `ArchCommunicationHubCard`, and the
 * copy lives in `app/utils/archCommunicationHub`. The stages' entrance
 * animations key off the `.is-visible` class set here.
 */
import { ref, onMounted } from 'vue';

const visible = ref(false);
onMounted(() => {
	requestAnimationFrame(() => {
		visible.value = true;
	});
});
</script>

<template>
	<div class="hub" :class="{ 'is-visible': visible }">
		<!-- Row 1: Inbound Channels -->
		<ArchCommunicationHubChannels :style="{ '--stagger': 0 }" />

		<!-- Connector: Channels → Pipeline -->
		<ArchCommunicationHubConverge :style="{ '--stagger': 1 }" />

		<!-- Content Filter -->
		<ArchCommunicationHubFilter :style="{ '--stagger': 2 }" />

		<!-- Connector: Filter → Pipeline -->
		<div class="hub-connector hub-connector--single" :style="{ '--stagger': 3 }">
			<div class="hub-connector-line" />
			<div class="hub-connector-label">clean messages only</div>
			<div class="hub-connector-line" />
		</div>

		<!-- Row 2: Agent Pipeline (center) with Knowledge Graph connection -->
		<div class="hub-core" :style="{ '--stagger': 4 }">
			<!-- Knowledge Graph (left) -->
			<ArchCommunicationHubKnowledge />

			<!-- Agent Pipeline (center) -->
			<ArchCommunicationHubPipeline />
		</div>

		<!-- Connector: Pipeline → Queue -->
		<div class="hub-connector hub-connector--single" :style="{ '--stagger': 5 }">
			<div class="hub-connector-line" />
			<div class="hub-connector-label">draft + confidence score</div>
			<div class="hub-connector-line" />
			<div class="hub-connector-flow-dot" />
		</div>

		<!-- Row 3: Verification Queue -->
		<ArchCommunicationHubQueue :style="{ '--stagger': 6 }" />

		<!-- Connector: Queue → Outbound -->
		<div class="hub-connector hub-connector--queue-out" :style="{ '--stagger': 7 }">
			<div class="hub-connector-line" />
		</div>

		<!-- Row 4: Outbound + Knowledge Feedback -->
		<div class="hub-output-row" :style="{ '--stagger': 8 }">
			<ArchCommunicationHubCard
				variant="outbound"
				title="Outbound Delivery"
				icon="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
				detail="Route to correct channel"
			/>
			<div class="hub-feedback">
				<div class="hub-feedback-line" />
				<div class="hub-feedback-label">
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
						<path
							d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
						/>
					</svg>
					<span>Knowledge updated</span>
				</div>
			</div>
		</div>

		<!-- Tenant isolation badge -->
		<div class="hub-isolation" :style="{ '--stagger': 9 }">
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
				<path
					d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
				/>
			</svg>
			<span>Strict tenant isolation — every operation scoped to a single organization</span>
		</div>
	</div>
</template>

<style scoped>
.hub {
	margin: 2rem 0;
	display: flex;
	flex-direction: column;
	align-items: stretch;
	gap: 0;
}

/* ── Sections (generic wrapper) ── */
.hub-section {
	opacity: 0;
	transform: translateY(14px);
	transition:
		opacity 0.6s var(--ease-spring),
		transform 0.6s var(--ease-spring);
	transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .hub-section {
	opacity: 1;
	transform: translateY(0);
}

/* ── Connectors ── */
.hub-connector {
	display: flex;
	flex-direction: column;
	align-items: center;
	padding: 10px 0;
	opacity: 0;
	transition: opacity var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--stagger) * 0.12s);
	position: relative;
}

.is-visible .hub-connector {
	opacity: 1;
}

.hub-connector-line {
	width: 2px;
	height: 16px;
	background: linear-gradient(to bottom, var(--color-brand-dim), var(--color-border-strong));
	border-radius: 1px;
	transform-origin: top;
}

.is-visible .hub-connector-line {
	animation: line-draw 0.5s var(--ease-spring) both;
	animation-delay: calc(var(--stagger) * 0.12s + 0.2s);
}

@keyframes line-draw {
	from {
		transform: scaleY(0);
	}
	to {
		transform: scaleY(1);
	}
}

.hub-connector-label {
	font-size: 0.6875rem;
	color: var(--color-text-tertiary);
	font-family: var(--font-mono);
	padding: 3px 12px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	border-radius: 4px;
	white-space: nowrap;
}

/* Converging connector (channels → pipeline) */
.hub-connector--converge {
	padding: 6px 0 24px;
}

/* Single connector (pipeline → queue) — offset to align with pipeline center */
.hub-connector--single {
	/* Use same column math as converge: stem sits between c2 and c4 */
	--cg: 8px;
	--cw: calc((100% - 4 * var(--cg)) / 5);
	--c2: calc(var(--cw) * 2.5 + 2 * var(--cg));
	--c4: calc(var(--cw) * 4.5 + 4 * var(--cg));
	--stem: calc((var(--c2) + var(--c4)) / 2);
	align-items: stretch;
	position: relative;
}

.hub-connector--single .hub-connector-line,
.hub-connector--single .hub-connector-label {
	margin-left: var(--stem);
	transform: translateX(-50%);
}

.hub-connector--single .hub-connector-label {
	width: fit-content;
}

/* Simple connector (queue → outbound) */
.hub-connector--queue-out .hub-connector-line {
	height: 24px;
}

/* ── Core area (Knowledge Graph + Pipeline side by side) ── */
.hub-core {
	display: grid;
	grid-template-columns: auto 1fr;
	gap: 0;
	align-items: stretch;
	opacity: 0;
	transform: translateY(14px);
	transition:
		opacity 0.6s var(--ease-spring),
		transform 0.6s var(--ease-spring);
	transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .hub-core {
	opacity: 1;
	transform: translateY(0);
}

@media (max-width: 640px) {
	.hub-core {
		grid-template-columns: 1fr;
	}
}

/* ── Output row ── */
.hub-output-row {
	display: grid;
	grid-template-columns: 1fr auto;
	gap: 12px;
	align-items: center;
	opacity: 0;
	transform: translateY(12px);
	transition:
		opacity 0.6s var(--ease-spring),
		transform 0.6s var(--ease-spring);
	transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .hub-output-row {
	opacity: 1;
	transform: translateY(0);
}

@media (max-width: 480px) {
	.hub-output-row {
		grid-template-columns: 1fr;
	}
}

/* Feedback loop */
.hub-feedback {
	display: flex;
	align-items: center;
	gap: 8px;
}

.hub-feedback-line {
	width: 20px;
	height: 2px;
	background: var(--color-border-strong);
	border-radius: 1px;
}

.hub-feedback-label {
	display: flex;
	align-items: center;
	gap: 5px;
	padding: 5px 10px;
	border-radius: 6px;
	background: var(--color-bg-surface);
	border: 1px dashed color-mix(in oklab, var(--color-accent) 30%, var(--color-border-default));
	white-space: nowrap;
}

.hub-feedback-label svg {
	color: var(--color-accent-muted);
	flex-shrink: 0;
}

.is-visible .hub-feedback-label svg {
	animation: feedback-spin 3s ease-in-out infinite 2.5s;
}

@keyframes feedback-spin {
	0%,
	100% {
		transform: rotate(0deg);
	}
	25% {
		transform: rotate(-15deg);
	}
	75% {
		transform: rotate(15deg);
	}
}

.hub-feedback-label span {
	font-size: 0.6875rem;
	color: var(--color-accent-muted);
	font-family: var(--font-mono);
}

/* ── Tenant isolation badge ── */
.hub-isolation {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-top: 14px;
	padding: 10px 14px;
	border-radius: 8px;
	border: 1px solid color-mix(in oklab, var(--color-warning) 15%, var(--color-border-default));
	background: color-mix(in oklab, var(--color-warning) 3%, var(--color-bg-soft));
	opacity: 0;
	transform: translateY(10px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--stagger) * 0.12s);
}

.is-visible .hub-isolation {
	opacity: 1;
	transform: translateY(0);
}

.hub-isolation svg {
	color: var(--color-warning);
	flex-shrink: 0;
}

.hub-isolation span {
	font-size: 0.6875rem;
	color: var(--color-text-secondary);
}
</style>
