<script setup lang="ts">
/* In-code mock of the deliverability dashboard (mirrors
 * apps/web/app/pages/dashboard/admin/delivery/deliverability.vue anatomy: health
 * summary, DNS authentication checks, ramp + placement). The domain reuses
 * acme.io from the marketing SDK snippet; numbers are modest illustrative
 * stats. Decorative only — aria-hidden is carried by the parent section.
 * Swap for a real capture by replacing the body with an <img>. */

const checks = [
	{ name: 'SPF', detail: 'Aligned' },
	{ name: 'DKIM', detail: '2048-bit key' },
	{ name: 'DMARC', detail: 'p=quarantine' },
];
</script>

<template>
	<ShowcaseWindowFrame url="app.owlat.app/dashboard/admin/delivery">
		<div class="h-[340px] bg-surface-2 p-4 text-left overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between">
				<p class="text-[11px] font-semibold text-text-primary">Deliverability</p>
				<span
					class="inline-flex items-center gap-1 rounded-full border border-border-default text-text-secondary font-mono text-[7.5px] px-2 py-0.5"
				>
					<span class="w-1 h-1 rounded-full bg-success" />
					acme.io
				</span>
			</div>

			<!-- Health summary -->
			<div
				class="rounded-lg border border-border-subtle bg-surface-3 p-3 mt-3 flex items-center gap-3"
			>
				<span
					class="w-9 h-9 rounded-full bg-success-subtle text-success text-[13px] font-semibold flex items-center justify-center"
				>
					A
				</span>
				<div>
					<p class="text-[9px] font-semibold text-text-primary">Healthy</p>
					<p class="text-[7.5px] text-text-tertiary">All checks passing · reputation growing</p>
				</div>
			</div>

			<!-- DNS authentication checks -->
			<p
				class="text-[7.5px] font-medium uppercase tracking-[0.08em] text-text-tertiary mt-3 mb-1.5"
			>
				Authentication
			</p>
			<div
				class="rounded-lg border border-border-subtle bg-surface-3 divide-y divide-border-subtle"
			>
				<div
					v-for="check in checks"
					:key="check.name"
					class="flex items-center gap-2 px-2.5 py-1.5"
				>
					<svg
						width="9"
						height="9"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
						stroke-linejoin="round"
						class="text-success shrink-0"
					>
						<path d="M20 6 9 17l-5-5" />
					</svg>
					<span class="font-mono text-[8px] font-medium text-text-primary">{{ check.name }}</span>
					<span class="ml-auto text-[7.5px] text-text-tertiary">{{ check.detail }}</span>
				</div>
			</div>

			<!-- Ramp -->
			<div class="rounded-lg border border-border-subtle bg-surface-3 p-3 mt-2.5">
				<div class="flex items-baseline justify-between">
					<p class="text-[8px] font-medium text-text-primary">Own-MTA sending share</p>
					<p class="text-[8px] font-semibold text-text-primary tabular-nums">62%</p>
				</div>
				<div class="h-1.5 rounded-full bg-border-subtle mt-1.5 overflow-hidden">
					<div class="h-full w-[62%] rounded-full bg-brand" />
				</div>
				<p class="text-[7px] text-text-tertiary mt-1">Ramping · backed off on complaint spikes</p>
			</div>

			<!-- Placement -->
			<div class="rounded-lg border border-border-subtle bg-surface-3 p-3 mt-2.5">
				<div class="flex items-baseline justify-between">
					<p class="text-[8px] font-medium text-text-primary">Seed placement</p>
					<p class="text-[7px] text-text-tertiary">Last run · today</p>
				</div>
				<div class="flex items-center gap-2 mt-1.5">
					<div class="flex-1 h-1.5 rounded-full bg-border-subtle overflow-hidden">
						<div class="h-full w-[94%] rounded-full bg-success" />
					</div>
					<span class="text-[7.5px] text-text-secondary tabular-nums">94% inbox</span>
				</div>
			</div>
		</div>
	</ShowcaseWindowFrame>
</template>
