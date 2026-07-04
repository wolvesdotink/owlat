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

function handleTilt(event: MouseEvent, el: HTMLElement) {
	const rect = el.getBoundingClientRect();
	const x = (event.clientX - rect.left) / rect.width - 0.5;
	const y = (event.clientY - rect.top) / rect.height - 0.5;
	el.style.transform = `perspective(600px) rotateY(${x * 5}deg) rotateX(${-y * 5}deg) translateY(-2px)`;
}

function resetTilt(el: HTMLElement) {
	el.style.transform = '';
}
</script>

<template>
	<section
		id="pricing"
		ref="target"
		class="px-8 max-md:px-6 py-28 max-md:py-20 border-t border-border-subtle"
		:class="{ visible: isVisible }"
	>
		<div class="max-w-[1000px] mx-auto">
			<!-- Header -->
			<div class="text-center mb-16">
				<span class="price-el font-mono text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-brand mb-4 block" style="--i: 0">
					Run it yourself
				</span>
				<h2 class="price-el font-display text-[clamp(2rem,4.5vw,3.25rem)] font-normal leading-[1.1] tracking-[-0.02em] text-text-primary mb-4" style="--i: 1">
					Free forever. Your infrastructure.
				</h2>
				<p class="price-el text-base text-text-tertiary max-w-[540px] mx-auto" style="--i: 2">
					Open-source under Apache 2.0. Hosted cloud is coming later — self-host today and own your data.
				</p>
			</div>

			<!-- Self-host + Hosted cards -->
			<div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
				<!-- Self-Host (highlighted) -->
				<div
					class="price-card relative rounded-2xl p-7 border border-brand/40 ring-1 ring-brand/10"
					style="--i: 3; background: linear-gradient(180deg, color-mix(in oklab, var(--color-brand-subtle) 60%, var(--color-bg-elevated)) 0%, var(--color-bg-elevated) 100%)"
					@mousemove="handleTilt($event, $event.currentTarget as HTMLElement)"
					@mouseleave="resetTilt($event.currentTarget as HTMLElement)"
				>
					<span class="absolute -top-3 left-1/2 -translate-x-1/2 text-[0.6875rem] font-semibold text-text-inverse bg-brand px-3 py-0.5 rounded-full">
						Available today
					</span>

					<h3 class="text-lg font-semibold text-text-primary mb-1">Self-Host</h3>
					<p class="text-[0.8125rem] text-text-tertiary mb-5">Run on your own VPS. No limits. No billing.</p>

					<p class="mb-6">
						<span class="font-display text-4xl font-semibold text-text-primary tracking-tight">Free</span>
						<span class="text-sm text-text-tertiary"> forever</span>
					</p>

					<!-- Feature list -->
					<ul class="space-y-2.5 mb-7">
						<li
							v-for="(feature, fi) in selfHostFeatures"
							:key="feature"
							class="feature-item flex items-start gap-2.5 text-[0.8125rem] text-text-secondary leading-snug"
							:style="{ '--fi': fi }"
						>
							<svg class="feature-check w-[15px] h-[15px] text-success shrink-0 mt-[3px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
								<path d="M20 6 9 17l-5-5" class="check-path" />
							</svg>
							{{ feature }}
						</li>
					</ul>

					<!-- CTA -->
					<a
						href="https://docs.owlat.app/developer/self-hosting"
						class="block w-full text-center px-4 py-2.5 text-[0.8125rem] font-semibold rounded-xl no-underline transition-all duration-(--motion-moderate) btn-press bg-brand text-text-inverse hover:bg-brand-hover hover:shadow-brand-hover"
					>
						Start self-hosting →
					</a>
				</div>

				<!-- Hosted Cloud (muted / coming soon) -->
				<div
					class="price-card relative rounded-2xl p-7 border border-border-default opacity-75"
					style="--i: 4; background: var(--color-bg-elevated)"
					@mousemove="handleTilt($event, $event.currentTarget as HTMLElement)"
					@mouseleave="resetTilt($event.currentTarget as HTMLElement)"
				>
					<span class="absolute -top-3 left-1/2 -translate-x-1/2 text-[0.6875rem] font-semibold text-text-tertiary bg-bg-surface border border-border-default px-3 py-0.5 rounded-full">
						Coming soon
					</span>

					<h3 class="text-lg font-semibold text-text-primary mb-1">Hosted Cloud</h3>
					<p class="text-[0.8125rem] text-text-tertiary mb-5">We run it for you. Launch in Q3.</p>

					<p class="mb-6">
						<span class="font-display text-4xl font-semibold text-text-secondary tracking-tight">€—</span>
						<span class="text-sm text-text-tertiary"> /mo</span>
					</p>

					<ul class="space-y-2.5 mb-7">
						<li class="flex items-start gap-2.5 text-[0.8125rem] text-text-tertiary leading-snug">
							<svg class="w-[15px] h-[15px] text-text-disabled shrink-0 mt-[3px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
								<circle cx="12" cy="12" r="10" />
								<path d="M12 8v4" /><path d="M12 16h.01" />
							</svg>
							Managed infrastructure
						</li>
						<li class="flex items-start gap-2.5 text-[0.8125rem] text-text-tertiary leading-snug">
							<svg class="w-[15px] h-[15px] text-text-disabled shrink-0 mt-[3px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
								<circle cx="12" cy="12" r="10" />
								<path d="M12 8v4" /><path d="M12 16h.01" />
							</svg>
							Dedicated IPs &amp; warmup
						</li>
						<li class="flex items-start gap-2.5 text-[0.8125rem] text-text-tertiary leading-snug">
							<svg class="w-[15px] h-[15px] text-text-disabled shrink-0 mt-[3px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
								<circle cx="12" cy="12" r="10" />
								<path d="M12 8v4" /><path d="M12 16h.01" />
							</svg>
							Automatic updates &amp; backups
						</li>
					</ul>

					<a
						href="/waitlist"
						class="block w-full text-center px-4 py-2.5 text-[0.8125rem] font-semibold rounded-xl no-underline transition-all duration-(--motion-moderate) btn-press bg-bg-surface text-text-primary border border-border-default hover:border-brand"
					>
						Join waitlist
					</a>
				</div>
			</div>

			<!-- Resource requirements -->
			<div class="price-card border border-border-default rounded-2xl p-7 mb-10" style="--i: 6; background: var(--color-bg-elevated)">
				<h3 class="text-base font-semibold text-text-primary mb-1">Resource requirements</h3>
				<p class="text-[0.8125rem] text-text-tertiary mb-5">What your VPS needs to run Owlat.</p>
				<div class="rounded-xl border border-border-subtle overflow-hidden bg-bg-elevated/60">
					<table class="w-full text-[0.8125rem]">
						<thead>
							<tr class="bg-bg-surface/40 border-b border-border-subtle">
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
.price-el {
	opacity: 0;
	transform: translateY(14px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--i, 0) * 0.06s);
}

.price-card {
	opacity: 0;
	transform: translateY(16px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring),
		border-color var(--motion-moderate) var(--ease-spring),
		box-shadow var(--motion-moderate) var(--ease-spring);
	transition-delay: calc(0.12s + var(--i, 0) * 0.06s);
	will-change: transform;
}

.visible .price-el,
.visible .price-card {
	opacity: 1;
	transform: none;
}

.price-card:hover {
	box-shadow: var(--shadow-3);
}

/* Animated checkmark draw */
.check-path {
	stroke-dasharray: 28;
	stroke-dashoffset: 28;
	transition: stroke-dashoffset var(--motion-slow) var(--ease-spring);
	transition-delay: calc(0.3s + var(--fi, 0) * 0.08s);
}

.visible .check-path {
	stroke-dashoffset: 0;
}

/* Feature items staggered entrance */
.feature-item {
	opacity: 0;
	transform: translateX(-6px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(0.2s + var(--fi, 0) * 0.05s);
}

.visible .feature-item {
	opacity: 1;
	transform: none;
}
</style>
