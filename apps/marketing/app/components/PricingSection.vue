<script setup lang="ts">
const { t } = useI18n();
const localePath = useLocalePath();

const { target, isVisible } = useScrollReveal();

// The cell values are message keys too, not just the row labels: "4 GB" and
// "2 vCPU" happen to survive translation unchanged, but "Required" does not,
// and a locale that writes units differently needs the whole cell.
const resourceRows = [
	{
		labelKey: 'pricing.resources.ram',
		minKey: 'pricing.resources.ramMin',
		recommendedKey: 'pricing.resources.ramRecommended',
	},
	{
		labelKey: 'pricing.resources.disk',
		minKey: 'pricing.resources.diskMin',
		recommendedKey: 'pricing.resources.diskRecommended',
	},
	{
		labelKey: 'pricing.resources.cpu',
		minKey: 'pricing.resources.cpuMin',
		recommendedKey: 'pricing.resources.cpuRecommended',
	},
	{
		labelKey: 'pricing.resources.domain',
		minKey: 'pricing.resources.required',
		recommendedKey: 'pricing.resources.required',
	},
];

const selfHostFeatures = [
	'pricing.selfHost.features.allFeatures',
	'pricing.selfHost.features.sends',
	'pricing.selfHost.features.members',
	'pricing.selfHost.features.contacts',
	'pricing.selfHost.features.updates',
	'pricing.selfHost.features.license',
];

const hostedFeatures = [
	'pricing.hosted.features.managed',
	'pricing.hosted.features.ips',
	'pricing.hosted.features.backups',
];
</script>

<template>
	<section
		id="pricing"
		ref="target"
		class="px-8 max-md:px-6 py-28 max-md:py-20 border-t border-border-subtle"
		:class="{ visible: isVisible }"
	>
		<div class="max-w-[1200px] mx-auto">
			<!-- Section header -->
			<div class="mb-16 max-md:mb-12">
				<span class="price-el lp-eyebrow mb-4" style="--i: 0">{{ t('pricing.eyebrow') }}</span>
				<I18nT
					keypath="pricing.title"
					tag="h2"
					class="price-el lp-title mb-4"
					style="--i: 1"
					scope="global"
				>
					<template #accent>
						<span class="lp-title-accent">{{ t('pricing.titleAccent') }}</span>
					</template>
				</I18nT>
				<p
					class="price-el text-base text-text-secondary leading-relaxed max-w-[540px]"
					style="--i: 2"
				>
					{{ t('pricing.intro') }}
				</p>
			</div>

			<!-- Self-host + Hosted cards -->
			<div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-10">
				<!-- Self-Host (featured: stronger border + black pill CTA) -->
				<div class="price-card price-card-highlight" style="--i: 3">
					<p class="text-caption text-text-tertiary mb-3">{{ t('pricing.selfHost.badge') }}</p>
					<h3 class="text-lg font-medium tracking-[-0.01em] text-text-primary mb-1">
						{{ t('pricing.selfHost.name') }}
					</h3>
					<p class="text-caption text-text-tertiary mb-5">{{ t('pricing.selfHost.tagline') }}</p>

					<p class="mb-6">
						<span class="text-4xl font-medium text-text-primary tracking-tight">{{
							t('pricing.selfHost.price')
						}}</span>
						<span class="text-sm text-text-tertiary">&nbsp;{{ t('pricing.selfHost.period') }}</span>
					</p>

					<ul class="space-y-2.5 mb-7">
						<li
							v-for="feature in selfHostFeatures"
							:key="feature"
							class="flex items-start gap-2.5 text-caption text-text-secondary leading-snug"
						>
							<svg
								class="w-[15px] h-[15px] text-text-tertiary shrink-0 mt-[3px]"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path d="M20 6 9 17l-5-5" />
							</svg>
							{{ t(feature) }}
						</li>
					</ul>

					<a
						href="https://docs.owlat.app/developer/self-hosting"
						class="btn btn-primary btn-sm group w-full no-underline"
					>
						<span>{{ t('pricing.selfHost.cta') }}</span>
						<svg
							class="transition-transform duration-(--motion-fast) group-hover:translate-x-[3px]"
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<path d="M5 12h14" />
							<path d="m12 5 7 7-7 7" />
						</svg>
					</a>
				</div>

				<!-- Hosted Cloud (coming soon) -->
				<div class="price-card" style="--i: 4">
					<p class="text-caption text-text-tertiary mb-3">{{ t('pricing.hosted.badge') }}</p>
					<h3 class="text-lg font-medium tracking-[-0.01em] text-text-primary mb-1">
						{{ t('pricing.hosted.name') }}
					</h3>
					<p class="text-caption text-text-tertiary mb-5">{{ t('pricing.hosted.tagline') }}</p>

					<p class="mb-6">
						<span class="text-4xl font-medium text-text-secondary tracking-tight">{{
							t('pricing.hosted.price')
						}}</span>
						<span class="text-sm text-text-tertiary">&nbsp;{{ t('pricing.hosted.period') }}</span>
					</p>

					<ul class="space-y-2.5 mb-7">
						<li
							v-for="feature in hostedFeatures"
							:key="feature"
							class="flex items-start gap-2.5 text-caption text-text-tertiary leading-snug"
						>
							<svg
								class="w-[15px] h-[15px] text-text-tertiary shrink-0 mt-[3px]"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path d="M20 6 9 17l-5-5" />
							</svg>
							{{ t(feature) }}
						</li>
					</ul>

					<a :href="localePath('/waitlist')" class="btn btn-hairline btn-sm w-full no-underline">
						{{ t('pricing.hosted.cta') }}
					</a>
				</div>
			</div>

			<!-- Resource requirements -->
			<div class="price-card" style="--i: 5">
				<h3 class="text-base font-medium tracking-[-0.01em] text-text-primary mb-1">
					{{ t('pricing.resources.title') }}
				</h3>
				<p class="text-caption text-text-tertiary mb-5">{{ t('pricing.resources.subtitle') }}</p>
				<div class="rounded-(--radius-card) border border-border-subtle overflow-x-auto">
					<table class="w-full text-caption">
						<thead>
							<tr class="border-b border-border-subtle">
								<th class="px-3.5 py-2.5 text-left text-text-tertiary font-medium" />
								<th class="px-3.5 py-2.5 text-right text-text-tertiary font-medium">
									{{ t('pricing.resources.minimum') }}
								</th>
								<th class="px-3.5 py-2.5 text-right text-text-tertiary font-medium">
									{{ t('pricing.resources.recommended') }}
								</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-border-subtle">
							<tr v-for="row in resourceRows" :key="row.labelKey">
								<td class="px-3.5 py-2 text-text-primary font-medium">{{ t(row.labelKey) }}</td>
								<td class="px-3.5 py-2 text-right text-text-secondary">{{ t(row.minKey) }}</td>
								<td class="px-3.5 py-2 text-right text-text-primary font-medium">
									{{ t(row.recommendedKey) }}
								</td>
							</tr>
						</tbody>
					</table>
				</div>
			</div>
		</div>
	</section>
</template>

<style scoped>
/* === Entry reveal: opacity + small translateY only === */
.price-el {
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring);
	transition-delay: calc(var(--i, 0) * 0.05s);
}

.price-card {
	opacity: 0;
	transform: translateY(8px);
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

.price-card:hover {
	border-color: var(--color-border-default);
	box-shadow: var(--shadow-3);
	transition-delay: 0s;
}

/* Featured tier: slightly stronger hairline */
.price-card-highlight,
.price-card-highlight:hover {
	border-color: var(--color-border-strong);
}

.visible .price-el,
.visible .price-card {
	opacity: 1;
	transform: none;
}
</style>
