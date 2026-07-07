<script setup lang="ts">
import { watch } from 'vue';

const { target, isVisible } = useScrollReveal();

// A/B test count-up percentages
const variantA = useCountUp(24.2, { duration: 2200, decimals: 1 });
const variantB = useCountUp(38.7, { duration: 2600, decimals: 1 });

watch(isVisible, (v) => {
	if (v) {
		setTimeout(() => variantA.start(), 600);
		setTimeout(() => variantB.start(), 750);
	}
});
</script>

<template>
	<section
		id="features"
		ref="target"
		class="px-8 max-md:px-6 py-28 max-md:py-20"
		:class="{ visible: isVisible }"
	>
		<div class="max-w-[1200px] mx-auto">
			<!-- Section header -->
			<div class="mb-16 max-md:mb-12">
				<span
					class="bento-el text-xs font-medium uppercase tracking-widest text-text-tertiary mb-4 block"
					style="--i: 0"
				>
					Platform
				</span>
				<h2
					class="bento-el text-[clamp(2rem,4.5vw,3.25rem)] font-semibold leading-[1.1] tracking-tight text-text-primary mb-4"
					style="--i: 1"
				>
					Everything you need<br class="max-md:hidden" />
					to ship email
				</h2>
				<p class="bento-el text-base text-text-secondary max-w-[420px]" style="--i: 2">
					From builder to inbox, every tool in one platform.
				</p>
			</div>

			<!-- Bento Grid -->
			<div class="grid grid-cols-12 gap-3 max-lg:grid-cols-6 max-md:grid-cols-1">
				<!-- Email Editor (large card) -->
				<div class="bento-card group col-span-8 max-lg:col-span-6 max-md:col-span-1 min-h-[260px]">
					<div class="flex max-md:flex-col gap-8 h-full">
						<div class="flex-1 min-w-0">
							<h3 class="card-title">Block-Based Email Editor</h3>
							<p class="card-desc">
								17 drag-and-drop block types with inline text editing. Build with text, images,
								buttons, columns, tables, carousels, and more. Save blocks to your library, manage
								translations per language, and preview across devices in real time.
							</p>
						</div>
						<!-- Visual: mini email builder -->
						<div
							class="flex flex-col gap-2 w-[200px] max-md:w-full shrink-0 self-center"
							aria-hidden="true"
						>
							<div class="editor-block" style="--d: 0">
								<div
									class="flex items-center gap-2 p-3 rounded-lg bg-bg-surface border border-border-subtle transition-colors duration-(--motion-moderate) group-hover:border-border-default"
								>
									<div class="w-5 h-5 rounded-full bg-text-tertiary/15" />
									<div class="flex-1 space-y-1">
										<div class="h-1.5 w-3/4 rounded-full bg-text-tertiary/15" />
										<div class="h-1.5 w-1/2 rounded-full bg-text-tertiary/10" />
									</div>
								</div>
							</div>
							<div class="editor-block" style="--d: 1">
								<div
									class="h-14 rounded-lg bg-bg-surface border border-border-subtle flex items-center justify-center transition-colors duration-(--motion-moderate) group-hover:border-border-default"
								>
									<svg
										width="18"
										height="18"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="1.5"
										class="text-text-disabled transition-colors duration-(--motion-moderate) group-hover:text-text-tertiary"
									>
										<rect x="3" y="3" width="18" height="18" rx="2" />
										<circle cx="8.5" cy="8.5" r="1.5" />
										<path d="m21 15-5-5L5 21" />
									</svg>
								</div>
							</div>
							<div class="editor-block" style="--d: 2">
								<div class="flex justify-center p-2">
									<div
										class="px-6 py-1.5 rounded-md bg-brand text-text-inverse text-[0.6rem] font-semibold transition-transform duration-(--motion-moderate) group-hover:scale-105"
									>
										Call to Action
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>

				<!-- Audience Engine -->
				<div
					class="bento-card group col-span-4 max-lg:col-span-6 max-md:col-span-1 min-h-[260px] flex flex-col"
				>
					<div class="flex-1">
						<h3 class="card-title">Audience Engine</h3>
						<p class="card-desc">
							Store contacts with custom properties, organize into topics with double opt-in, build
							dynamic segments with filters, import via CSV, and capture leads with embeddable forms.
						</p>
					</div>
					<!-- Visual: avatar stack -->
					<div class="flex items-center gap-1 mt-4" aria-hidden="true">
						<div class="flex -space-x-2.5">
							<div v-for="i in 5" :key="i" class="avatar-circle" :style="{ '--d': i - 1 }">
								<div
									class="w-8 h-8 rounded-full border-2 border-bg-elevated transition-transform duration-(--motion-moderate) group-hover:scale-110"
									:style="{
										background: ['#c4785a', '#d4a574', '#7a9b6e', '#c9a55a', '#a8674d'][i - 1],
										transitionDelay: `${i * 30}ms`,
									}"
								/>
							</div>
						</div>
						<span class="avatar-count text-xs font-medium text-text-tertiary ml-2">+2.4k</span>
					</div>
				</div>

				<!-- Campaigns + A/B Testing -->
				<div
					class="bento-card group col-span-4 max-lg:col-span-3 max-md:col-span-1 min-h-[240px] flex flex-col"
				>
					<div class="flex-1">
						<h3 class="card-title">Campaigns + A/B Testing</h3>
						<p class="card-desc">
							Schedule sends for optimal timing, test subject lines and content variants side by side,
							then track opens, clicks, and engagement as results come in.
						</p>
					</div>
					<!-- Visual: A/B test bars -->
					<div class="visual-ab mt-4" aria-hidden="true">
						<div class="ab-chart">
							<div class="ab-track" style="--d: 0">
								<div class="ab-label-row">
									<span class="ab-variant">A</span>
									<span class="ab-pct">{{ variantA.display.value }}%</span>
								</div>
								<div class="ab-rail">
									<div class="ab-fill" style="--h: 55%; --d: 0" />
								</div>
							</div>
							<div class="ab-track" style="--d: 1">
								<div class="ab-label-row">
									<span class="ab-variant winning-label">B</span>
									<span class="ab-pct ab-pct-winner">{{ variantB.display.value }}%</span>
								</div>
								<div class="ab-rail">
									<div class="ab-fill winning" style="--h: 82%; --d: 1" />
								</div>
							</div>
						</div>
					</div>
				</div>

				<!-- Automations -->
				<div
					class="bento-card group col-span-4 max-lg:col-span-3 max-md:col-span-1 min-h-[240px] flex flex-col"
				>
					<div class="flex-1">
						<h3 class="card-title">Automations</h3>
						<p class="card-desc">
							Build trigger-based flows for onboarding, re-engagement, and lifecycle messaging. Add
							delays, conditions, and branching logic — no code required.
						</p>
					</div>
					<!-- Visual: flow diagram -->
					<div class="flex items-center justify-center gap-0 mt-4" aria-hidden="true">
						<div class="flow-node" style="--d: 0">
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								class="text-brand"
							>
								<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
							</svg>
						</div>
						<div class="flow-line"><div class="flow-dot" /></div>
						<div class="flow-node" style="--d: 1">
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								class="text-accent"
							>
								<circle cx="12" cy="12" r="10" />
								<path d="M12 6v6l4 2" />
							</svg>
						</div>
						<div class="flow-line"><div class="flow-dot" style="animation-delay: 0.8s" /></div>
						<div class="flow-node" style="--d: 2">
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								class="text-success"
							>
								<path d="M22 2 11 13" />
								<path d="M22 2 15 22l-4-9-9-4z" />
							</svg>
						</div>
					</div>
				</div>

				<!-- Transactional Delivery -->
				<div
					class="bento-card group col-span-4 max-lg:col-span-6 max-md:col-span-1 min-h-[240px] flex flex-col"
				>
					<div class="flex-1">
						<h3 class="card-title">Transactional Delivery</h3>
						<p class="card-desc">
							Send password resets, order confirmations, and receipts via API. Reference templates
							by slug or ID, inject dynamic data variables, and fall back to the default language
							automatically.
						</p>
					</div>
					<!-- Visual: mini terminal -->
					<div
						class="mt-4 rounded-lg border border-border-subtle p-3 font-mono text-[0.6rem] leading-[1.8] text-text-tertiary"
						style="background: var(--owlat-code-bg)"
						aria-hidden="true"
					>
						<div class="code-line" style="--d: 0">
							<span class="c-kw">POST</span> <span class="text-text-secondary">/api/v1/send</span>
						</div>
						<div class="code-line" style="--d: 1">
							<span class="c-str">"slug"</span>: <span class="c-str">"welcome"</span>
						</div>
						<div class="code-line" style="--d: 2">
							<span class="text-success">→ 200 OK</span><span class="typing-cursor" />
						</div>
					</div>
				</div>

				<!-- Deliverability (full width) -->
				<div class="bento-card group col-span-12 max-lg:col-span-6 max-md:col-span-1">
					<div class="flex max-md:flex-col items-center gap-8">
						<div class="flex-1 min-w-0">
							<h3 class="card-title">Deliverability</h3>
							<p class="card-desc mb-0">
								Verify your sending domain with guided DNS setup for SPF, DKIM, and DMARC. Manage
								blocklists, automatically include one-click unsubscribe headers, and stream delivery
								events via webhooks for full visibility.
							</p>
						</div>
						<!-- Visual: DNS verification badges -->
						<div class="flex items-center gap-3 shrink-0" aria-hidden="true">
							<div
								v-for="(record, i) in ['SPF', 'DKIM', 'DMARC']"
								:key="record"
								class="dns-badge"
								:style="{ '--d': i }"
							>
								<svg
									class="check-icon"
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2.5"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<path d="M20 6 9 17l-5-5" />
								</svg>
								<span class="text-[0.75rem] font-medium">{{ record }}</span>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</section>
</template>

<style scoped>
/* === Entry reveal: opacity + small translateY only === */
.bento-el {
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring);
	transition-delay: calc(var(--i, 0) * 0.05s);
}

.visible .bento-el,
.visible .bento-card {
	opacity: 1;
	transform: none;
}

/* === Card surface === */
.bento-card {
	opacity: 0;
	transform: translateY(8px);
	background: var(--surface-2);
	border: 1px solid var(--color-border-subtle);
	border-radius: var(--radius-card);
	box-shadow: var(--shadow-2);
	padding: 1.75rem;
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring),
		background var(--motion-fast) var(--ease-spring),
		box-shadow var(--motion-fast) var(--ease-spring);
}

/* Hover: one surface step, one elevation step */
.bento-card:hover {
	background: var(--surface-2-hover);
	box-shadow: var(--shadow-3);
}

/* === Card content === */
.card-title {
	font-size: 1.0625rem;
	font-weight: 550;
	color: var(--color-text-primary);
	margin-bottom: 0.5rem;
	line-height: 1.3;
	letter-spacing: -0.01em;
}

.card-desc {
	font-size: 0.9375rem;
	color: var(--color-text-secondary);
	line-height: 1.65;
	margin: 0;
}

/* === Visual: email editor blocks === */
.editor-block {
	opacity: 0;
	transform: translateX(-12px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(0.4s + var(--d, 0) * 0.08s);
}

.visible .editor-block {
	opacity: 1;
	transform: none;
}

.group:hover .editor-block {
	transform: translateX(3px);
	transition-delay: calc(var(--d, 0) * 0.03s);
}

/* === Visual: avatar stack === */
.avatar-circle {
	opacity: 0;
	transform: scale(0.5);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(0.5s + var(--d, 0) * 0.06s);
}

.visible .avatar-circle {
	opacity: 1;
	transform: scale(1);
}

.group:hover .avatar-circle {
	transform: translateX(calc(var(--d, 0) * 2px));
}

.avatar-count {
	opacity: 0;
	transition: opacity var(--motion-slow) ease var(--motion-slow);
}

.visible .avatar-count {
	opacity: 1;
}

/* === Visual: A/B test bars === */
.visual-ab {
	overflow: hidden;
}

.ab-chart {
	display: flex;
	flex-direction: column;
	gap: 10px;
}

.ab-track {
	opacity: 0;
	transform: translateX(-12px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(0.5s + var(--d, 0) * 0.12s);
}

.visible .ab-track {
	opacity: 1;
	transform: none;
}

.ab-label-row {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	margin-bottom: 4px;
}

.ab-variant {
	font-size: 0.6rem;
	font-weight: 600;
	color: var(--color-text-disabled);
}

.ab-variant.winning-label {
	color: var(--color-brand-muted);
}

.ab-pct {
	font-size: 0.6rem;
	font-weight: 500;
	color: var(--color-text-disabled);
	letter-spacing: -0.01em;
	font-variant-numeric: tabular-nums;
}

.ab-pct-winner {
	color: var(--color-brand-muted);
}

.ab-rail {
	height: 6px;
	border-radius: 3px;
	background: var(--color-border-subtle);
	overflow: hidden;
	position: relative;
}

.ab-fill {
	height: 100%;
	width: 0;
	border-radius: 3px;
	background: var(--color-border-strong);
	transition: width 1.2s var(--ease-spring);
	transition-delay: calc(0.6s + var(--d, 0) * 0.18s);
}

.ab-fill.winning {
	background: linear-gradient(90deg, var(--color-brand-muted), var(--color-brand));
}

.visible .ab-fill {
	width: var(--h);
}

/* === Visual: automation flow === */
.flow-node {
	width: 36px;
	height: 36px;
	border-radius: 10px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-default);
	display: flex;
	align-items: center;
	justify-content: center;
	opacity: 0;
	transform: scale(0.7);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring),
		border-color var(--motion-moderate) var(--ease-spring);
	transition-delay: calc(0.4s + var(--d, 0) * 0.12s);
}

.visible .flow-node {
	opacity: 1;
	transform: scale(1);
}

.group:hover .flow-node {
	border-color: var(--color-brand-muted);
	transform: scale(1.08);
}

.flow-line {
	width: 32px;
	height: 2px;
	background: var(--color-border-default);
	position: relative;
	overflow: hidden;
}

.flow-dot {
	position: absolute;
	top: -2px;
	left: -6px;
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: var(--color-brand);
	opacity: 0;
}

.visible .flow-dot {
	animation: flow-travel 2s ease-in-out infinite;
	animation-delay: inherit;
}

@keyframes flow-travel {
	0% {
		left: -6px;
		opacity: 0;
	}
	15% {
		opacity: 1;
	}
	85% {
		opacity: 1;
	}
	100% {
		left: 100%;
		opacity: 0;
	}
}

/* === Visual: code lines === */
.code-line {
	opacity: 0;
	transform: translateX(-8px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(0.5s + var(--d, 0) * 0.12s);
}

.visible .code-line {
	opacity: 1;
	transform: none;
}

.typing-cursor {
	display: inline-block;
	width: 1px;
	height: 0.75em;
	background: var(--color-brand);
	margin-left: 2px;
	vertical-align: middle;
	animation: cursor-blink 1s step-end infinite;
}

@keyframes cursor-blink {
	0%,
	100% {
		opacity: 1;
	}
	50% {
		opacity: 0;
	}
}

/* === Visual: DNS badges === */
.dns-badge {
	display: flex;
	align-items: center;
	gap: 0.375rem;
	padding: 0.5rem 0.75rem;
	border-radius: 8px;
	background: var(--color-success-subtle);
	color: var(--color-success);
	border: 1px solid color-mix(in oklab, var(--color-success) 15%, transparent);
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(0.5s + var(--d, 0) * 0.1s);
}

.visible .dns-badge {
	opacity: 1;
	transform: none;
}

.check-icon {
	opacity: 0;
	transition: opacity var(--motion-moderate) var(--ease-spring);
	transition-delay: calc(0.9s + var(--d, 0) * 0.15s);
}

.visible .check-icon {
	opacity: 1;
}

.group:hover .dns-badge {
	box-shadow: var(--shadow-1);
}

/* Respect reduced-motion: drop the looping + transform micro-interactions */
@media (prefers-reduced-motion: reduce) {
	.flow-dot,
	.typing-cursor {
		animation: none;
	}
	.group:hover .editor-block,
	.group:hover .avatar-circle,
	.group:hover .flow-node {
		transform: none;
	}
}
</style>
