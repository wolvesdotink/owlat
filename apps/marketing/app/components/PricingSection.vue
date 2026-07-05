<script setup lang="ts">
const { target, isVisible } = useScrollReveal();

const resourceRows = [
	{ label: 'RAM', min: '4 GB', recommended: '8 GB' },
	{ label: 'Disk', min: '20 GB', recommended: '40 GB' },
	{ label: 'CPU', min: '2 vCPU', recommended: '4 vCPU' },
	{ label: 'Domain + DNS', min: 'Required', recommended: 'Required' },
];

const selfHostFeatures = [
	'All features — no gated tiers',
	'Unlimited sends',
	'Unlimited team members',
	'Unlimited contacts',
	'In-app updates (one-click)',
	'Apache 2.0 licensed',
];

const hostedFeatures = ['Managed infrastructure', 'Dedicated IPs & warmup', 'Automatic updates & backups'];
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
				<span
					class="price-el text-xs font-medium uppercase tracking-widest text-text-tertiary mb-4 block"
					style="--i: 0"
				>
					Pricing
				</span>
				<h2
					class="price-el text-[clamp(2rem,4.5vw,3.25rem)] font-semibold leading-[1.1] tracking-tight text-text-primary mb-4"
					style="--i: 1"
				>
					Free forever. Your infrastructure.
				</h2>
				<p class="price-el text-base text-text-secondary leading-relaxed max-w-prose" style="--i: 2">
					Open-source under Apache 2.0. Hosted cloud is coming later — self-host today and own your
					data.
				</p>
			</div>

			<!-- Self-host + Hosted cards -->
			<div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-10">
				<!-- Self-Host (highlighted via border only) -->
				<div class="price-card price-card-highlight" style="--i: 3">
					<p class="text-xs text-text-tertiary mb-3">Available today</p>
					<h3 class="text-lg font-[550] text-text-primary mb-1">Self-Host</h3>
					<p class="text-[0.8125rem] text-text-tertiary mb-5">Run on your own VPS. No limits. No billing.</p>

					<p class="mb-6">
						<span class="text-4xl font-[550] text-text-primary tracking-tight">Free</span>
						<span class="text-sm text-text-tertiary"> forever</span>
					</p>

					<ul class="space-y-2.5 mb-7">
						<li
							v-for="feature in selfHostFeatures"
							:key="feature"
							class="flex items-start gap-2.5 text-[0.8125rem] text-text-secondary leading-snug"
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
							{{ feature }}
						</li>
					</ul>

					<a
						href="https://docs.owlat.app/developer/self-hosting"
						class="block w-full text-center px-4 py-2.5 text-[0.8125rem] font-semibold rounded-[10px] no-underline transition-colors duration-(--motion-fast) btn-press bg-brand text-text-inverse hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base"
					>
						Start self-hosting →
					</a>
				</div>

				<!-- Hosted Cloud (coming soon) -->
				<div class="price-card" style="--i: 4">
					<p class="text-xs text-text-tertiary mb-3">Coming soon</p>
					<h3 class="text-lg font-[550] text-text-primary mb-1">Hosted Cloud</h3>
					<p class="text-[0.8125rem] text-text-tertiary mb-5">We run it for you. Launch in Q3.</p>

					<p class="mb-6">
						<span class="text-4xl font-[550] text-text-secondary tracking-tight">€—</span>
						<span class="text-sm text-text-tertiary"> /mo</span>
					</p>

					<ul class="space-y-2.5 mb-7">
						<li
							v-for="feature in hostedFeatures"
							:key="feature"
							class="flex items-start gap-2.5 text-[0.8125rem] text-text-tertiary leading-snug"
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
							{{ feature }}
						</li>
					</ul>

					<a
						href="/waitlist"
						class="block w-full text-center px-4 py-2.5 text-[0.8125rem] font-semibold rounded-[10px] no-underline transition-colors duration-(--motion-fast) btn-press bg-bg-surface text-text-primary border border-border-default hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base"
					>
						Join waitlist
					</a>
				</div>
			</div>

			<!-- Resource requirements -->
			<div class="price-card" style="--i: 5">
				<h3 class="text-base font-[550] text-text-primary mb-1">Resource requirements</h3>
				<p class="text-[0.8125rem] text-text-tertiary mb-5">What your VPS needs to run Owlat.</p>
				<div class="rounded-(--radius-card) border border-border-subtle overflow-x-auto">
					<table class="w-full text-[0.8125rem]">
						<thead>
							<tr class="border-b border-border-subtle">
								<th class="px-3.5 py-2.5 text-left text-text-tertiary font-medium" />
								<th class="px-3.5 py-2.5 text-right text-text-tertiary font-medium">Minimum</th>
								<th class="px-3.5 py-2.5 text-right text-text-tertiary font-medium">Recommended</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-border-subtle">
							<tr v-for="row in resourceRows" :key="row.label">
								<td class="px-3.5 py-2 text-text-primary font-medium">{{ row.label }}</td>
								<td class="px-3.5 py-2 text-right text-text-secondary">{{ row.min }}</td>
								<td class="px-3.5 py-2 text-right text-text-primary font-medium">{{ row.recommended }}</td>
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
	background: var(--surface-2);
	border: 1px solid var(--color-border-subtle);
	border-radius: var(--radius-card);
	box-shadow: var(--shadow-2);
	padding: 1.75rem;
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring);
	transition-delay: calc(var(--i, 0) * 0.05s);
}

.price-card-highlight {
	border-color: var(--color-border-strong);
}

.visible .price-el,
.visible .price-card {
	opacity: 1;
	transform: none;
}
</style>
