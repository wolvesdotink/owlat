<script setup lang="ts">
const { target, isVisible } = useScrollReveal();
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
				<div class="bento-card col-span-8 max-lg:col-span-6 max-md:col-span-1 min-h-[260px]">
					<div class="flex max-md:flex-col gap-8 h-full">
						<div class="flex-1 min-w-0">
							<h3 class="card-title">Block-Based Email Editor</h3>
							<p class="card-desc">
								17 drag-and-drop block types with inline text editing. Build with text, images,
								buttons, columns, tables, carousels, and more. Save blocks to your library, manage
								translations per language, and preview across devices in real time.
							</p>
						</div>
						<!-- Visual: mini email builder (static) -->
						<div
							class="flex flex-col gap-2 w-[200px] max-md:w-full shrink-0 self-center"
							aria-hidden="true"
						>
							<div
								class="flex items-center gap-2 p-3 rounded-lg bg-bg-surface border border-border-subtle"
							>
								<div class="w-5 h-5 rounded-full bg-text-tertiary/15" />
								<div class="flex-1 space-y-1">
									<div class="h-1.5 w-3/4 rounded-full bg-text-tertiary/15" />
									<div class="h-1.5 w-1/2 rounded-full bg-text-tertiary/10" />
								</div>
							</div>
							<div
								class="h-14 rounded-lg bg-bg-surface border border-border-subtle flex items-center justify-center"
							>
								<svg
									width="18"
									height="18"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="1.5"
									class="text-text-disabled"
								>
									<rect x="3" y="3" width="18" height="18" rx="2" />
									<circle cx="8.5" cy="8.5" r="1.5" />
									<path d="m21 15-5-5L5 21" />
								</svg>
							</div>
							<div class="flex justify-center p-2">
								<div
									class="px-6 py-1.5 rounded-md bg-brand text-text-inverse text-[0.6rem] font-semibold"
								>
									Call to Action
								</div>
							</div>
						</div>
					</div>
				</div>

				<!-- Audience Engine -->
				<div class="bento-card col-span-4 max-lg:col-span-6 max-md:col-span-1 min-h-[260px]">
					<h3 class="card-title">Audience Engine</h3>
					<p class="card-desc">
						Store contacts with custom properties, organize into topics with double opt-in, build
						dynamic segments with filters, import via CSV, and capture leads with embeddable forms.
					</p>
				</div>

				<!-- Campaigns + A/B Testing -->
				<div class="bento-card col-span-4 max-lg:col-span-3 max-md:col-span-1 min-h-[240px]">
					<h3 class="card-title">Campaigns + A/B Testing</h3>
					<p class="card-desc">
						Schedule sends for optimal timing, test subject lines and content variants side by side,
						then track opens, clicks, and engagement as results come in.
					</p>
				</div>

				<!-- Automations -->
				<div class="bento-card col-span-4 max-lg:col-span-3 max-md:col-span-1 min-h-[240px]">
					<h3 class="card-title">Automations</h3>
					<p class="card-desc">
						Build trigger-based flows for onboarding, re-engagement, and lifecycle messaging. Add
						delays, conditions, and branching logic — no code required.
					</p>
				</div>

				<!-- Transactional Delivery -->
				<div
					class="bento-card col-span-4 max-lg:col-span-6 max-md:col-span-1 min-h-[240px] flex flex-col"
				>
					<div class="flex-1">
						<h3 class="card-title">Transactional Delivery</h3>
						<p class="card-desc">
							Send password resets, order confirmations, and receipts via API. Reference templates
							by slug or ID, inject dynamic data variables, and fall back to the default language
							automatically.
						</p>
					</div>
					<!-- Visual: mini terminal (static) -->
					<div
						class="mt-4 rounded-lg border border-border-subtle p-3 font-mono text-[0.6rem] leading-[1.8] text-text-tertiary"
						style="background: var(--owlat-code-bg)"
						aria-hidden="true"
					>
						<div>
							<span class="c-kw">POST</span> <span class="text-text-secondary">/api/v1/send</span>
						</div>
						<div><span class="c-str">"slug"</span>: <span class="c-str">"welcome"</span></div>
						<div><span class="text-success">→ 200 OK</span></div>
					</div>
				</div>

				<!-- Deliverability (full width) -->
				<div class="bento-card col-span-12 max-lg:col-span-6 max-md:col-span-1">
					<h3 class="card-title">Deliverability</h3>
					<p class="card-desc">
						Verify your sending domain with guided DNS setup for SPF, DKIM, and DMARC. Manage
						blocklists, automatically include one-click unsubscribe headers, and stream delivery
						events via webhooks for full visibility.
					</p>
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
</style>
