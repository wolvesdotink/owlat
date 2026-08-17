<script setup lang="ts">
import { watch } from 'vue';

const { t } = useI18n();

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
				<span class="bento-el lp-eyebrow mb-4" style="--i: 0">{{ t('features.eyebrow') }}</span>
				<I18nT
					keypath="features.title"
					tag="h2"
					class="bento-el lp-title mb-4"
					style="--i: 1"
					scope="global"
				>
					<template #break><br class="max-md:hidden" /></template>
					<template #accent>
						<span class="lp-title-accent">{{ t('features.titleAccent') }}</span>
					</template>
				</I18nT>
				<p class="bento-el text-base text-text-secondary max-w-[540px]" style="--i: 2">
					{{ t('features.intro') }}
				</p>
			</div>

			<!-- Bento grid -->
			<div class="grid grid-cols-12 gap-4 max-lg:grid-cols-6 max-md:grid-cols-1">
				<!-- Email Editor -->
				<div class="bento-card col-span-8 max-lg:col-span-6 max-md:col-span-1" style="--i: 0">
					<div class="card-icon" aria-hidden="true">
						<svg
							width="17"
							height="17"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.75"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<rect x="3" y="3" width="18" height="18" rx="2" />
							<path d="M3 9h18" />
							<path d="M9 21V9" />
						</svg>
					</div>
					<h3 class="card-title">{{ t('features.editor.title') }}</h3>
					<p class="card-desc">{{ t('features.editor.desc') }}</p>
				</div>

				<!-- Audience Engine -->
				<div class="bento-card col-span-4 max-lg:col-span-6 max-md:col-span-1" style="--i: 1">
					<div class="card-icon" aria-hidden="true">
						<svg
							width="17"
							height="17"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.75"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
							<circle cx="9" cy="7" r="4" />
							<path d="M22 21v-2a4 4 0 0 0-3-3.87" />
							<path d="M16 3.13a4 4 0 0 1 0 7.75" />
						</svg>
					</div>
					<h3 class="card-title">{{ t('features.audience.title') }}</h3>
					<p class="card-desc">{{ t('features.audience.desc') }}</p>
				</div>

				<!-- Campaigns + A/B Testing -->
				<div
					class="bento-card col-span-4 max-lg:col-span-3 max-md:col-span-1 flex flex-col"
					style="--i: 2"
				>
					<div class="flex-1">
						<div class="card-icon" aria-hidden="true">
							<svg
								width="17"
								height="17"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.75"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<path d="M3 3v16a2 2 0 0 0 2 2h16" />
								<path d="M7 13v4" />
								<path d="M12 9v8" />
								<path d="M17 5v12" />
							</svg>
						</div>
						<h3 class="card-title">{{ t('features.campaigns.title') }}</h3>
						<p class="card-desc">{{ t('features.campaigns.desc') }}</p>
					</div>
					<!-- Visual: A/B test bars (count-up) -->
					<div class="mt-6" aria-hidden="true">
						<div class="flex flex-col gap-2.5">
							<div class="ab-track" style="--d: 0">
								<div class="flex items-baseline justify-between mb-1">
									<span class="font-mono text-2xs font-medium text-text-disabled">A</span>
									<span class="font-mono text-2xs text-text-disabled tabular-nums"
										>{{ variantA.display.value }}%</span
									>
								</div>
								<div class="ab-rail"><div class="ab-fill" style="--h: 55%; --d: 0" /></div>
							</div>
							<div class="ab-track" style="--d: 1">
								<div class="flex items-baseline justify-between mb-1">
									<span class="font-mono text-2xs font-medium text-brand-muted">B</span>
									<span class="font-mono text-2xs text-brand-muted tabular-nums"
										>{{ variantB.display.value }}%</span
									>
								</div>
								<div class="ab-rail"><div class="ab-fill winning" style="--h: 82%; --d: 1" /></div>
							</div>
						</div>
					</div>
				</div>

				<!-- Automations -->
				<div class="bento-card col-span-4 max-lg:col-span-3 max-md:col-span-1" style="--i: 3">
					<div class="card-icon" aria-hidden="true">
						<svg
							width="17"
							height="17"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.75"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
						</svg>
					</div>
					<h3 class="card-title">{{ t('features.automations.title') }}</h3>
					<p class="card-desc">{{ t('features.automations.desc') }}</p>
				</div>

				<!-- Transactional Delivery -->
				<div class="bento-card col-span-4 max-lg:col-span-6 max-md:col-span-1" style="--i: 4">
					<div class="card-icon" aria-hidden="true">
						<svg
							width="17"
							height="17"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.75"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="m7 8-4 4 4 4" />
							<path d="m17 8 4 4-4 4" />
							<path d="m14 4-4 16" />
						</svg>
					</div>
					<h3 class="card-title">{{ t('features.transactional.title') }}</h3>
					<p class="card-desc">{{ t('features.transactional.desc') }}</p>
				</div>

				<!-- Deliverability (full width) -->
				<div class="bento-card col-span-12 max-lg:col-span-6 max-md:col-span-1" style="--i: 5">
					<div class="flex max-md:flex-col items-center gap-8">
						<div class="flex-1 min-w-0">
							<div class="card-icon" aria-hidden="true">
								<svg
									width="17"
									height="17"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="1.75"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<path
										d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
									/>
									<path d="m9 12 2 2 4-4" />
								</svg>
							</div>
							<h3 class="card-title">{{ t('features.deliverability.title') }}</h3>
							<p class="card-desc mb-0">{{ t('features.deliverability.desc') }}</p>
						</div>
						<!-- Visual: DNS verification chips -->
						<div class="flex items-center gap-2.5 shrink-0" aria-hidden="true">
							<div
								v-for="(record, i) in ['SPF', 'DKIM', 'DMARC']"
								:key="record"
								class="dns-badge"
								:style="{ '--d': i }"
							>
								<svg
									class="check-icon text-success"
									width="13"
									height="13"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2.5"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<path d="M20 6 9 17l-5-5" />
								</svg>
								<span class="font-mono text-2xs font-medium text-text-secondary">{{ record }}</span>
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
.bento-el,
.bento-card {
	opacity: 0;
	transform: translateY(8px);
}

.bento-el {
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

/* === Card surface: white, hairline, hover lift === */
.bento-card {
	background: var(--surface-3);
	border: 1px solid var(--color-border-subtle);
	border-radius: var(--radius-card);
	box-shadow: var(--shadow-1);
	padding: 2rem;
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring),
		border-color var(--motion-fast) var(--ease-spring),
		box-shadow var(--motion-fast) var(--ease-spring);
	transition-delay: calc(var(--i, 0) * 0.05s);
}

.bento-card:hover {
	border-color: var(--color-border-default);
	box-shadow: var(--shadow-3);
	transition-delay: 0s;
}

/* === Card content === */
.card-icon {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 2.25rem;
	height: 2.25rem;
	border-radius: 0.625rem;
	background: var(--color-bg-soft);
	color: var(--color-text-secondary);
	margin-bottom: 1.125rem;
}

.card-title {
	font-size: 1.0625rem;
	font-weight: 450;
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

/* === Visual: A/B test bars === */
.ab-track {
	opacity: 0;
	transition: opacity var(--motion-slow) var(--ease-spring);
	transition-delay: calc(0.5s + var(--d, 0) * 0.12s);
}

.visible .ab-track {
	opacity: 1;
}

.ab-rail {
	height: 5px;
	border-radius: 3px;
	background: var(--color-border-subtle);
	overflow: hidden;
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

/* === Visual: DNS chips === */
.dns-badge {
	display: flex;
	align-items: center;
	gap: 0.375rem;
	padding: 0.5rem 0.75rem;
	border-radius: 9999px;
	background: var(--surface-3);
	border: 1px solid var(--color-border-default);
	opacity: 0;
	transform: translateY(6px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(0.4s + var(--d, 0) * 0.1s);
}

.visible .dns-badge {
	opacity: 1;
	transform: none;
}

.check-icon {
	opacity: 0;
	transition: opacity var(--motion-moderate) var(--ease-spring);
	transition-delay: calc(0.8s + var(--d, 0) * 0.15s);
}

.visible .check-icon {
	opacity: 1;
}
</style>
