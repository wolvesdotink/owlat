<script setup lang="ts">
/* In-code mock of the deliverability dashboard (mirrors
 * apps/web/app/pages/dashboard/admin/delivery/deliverability.vue anatomy: health
 * summary, DNS authentication checks, ramp + placement). The domain reuses
 * acme.io from the marketing SDK snippet; numbers are modest illustrative
 * stats. Decorative only — aria-hidden is carried by the parent section.
 * Swap for a real capture by replacing the body with an <img>. */

const { t } = useI18n();

// Record names (SPF/DKIM/DMARC) are protocol identifiers and stay verbatim in
// every locale; only the detail column is translated.
const checks = [
	{ name: 'SPF', detailKey: 'showcase.deliverability.checks.spf' },
	{ name: 'DKIM', detailKey: 'showcase.deliverability.checks.dkim' },
	{ name: 'DMARC', detailKey: 'showcase.deliverability.checks.dmarc' },
];
</script>

<template>
	<ShowcaseWindowFrame url="app.owlat.app/dashboard/admin/delivery">
		<div class="h-[340px] bg-surface-2 p-4 text-left overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between">
				<p class="text-[11px] font-semibold text-text-primary">
					{{ t('showcase.deliverability.title') }}
				</p>
				<span
					class="inline-flex items-center gap-1 rounded-full border border-border-default text-text-secondary font-mono text-[7.5px] px-2 py-0.5"
				>
					<span class="w-1 h-1 rounded-full bg-success" />
					{{ t('showcase.deliverability.domain') }}
				</span>
			</div>

			<!-- Health summary -->
			<div
				class="rounded-lg border border-border-subtle bg-surface-3 p-3 mt-3 flex items-center gap-3"
			>
				<span
					class="w-9 h-9 rounded-full bg-success-subtle text-success text-[13px] font-semibold flex items-center justify-center"
				>
					{{ t('showcase.deliverability.grade') }}
				</span>
				<div>
					<p class="text-[9px] font-semibold text-text-primary">
						{{ t('showcase.deliverability.healthTitle') }}
					</p>
					<p class="text-[7.5px] text-text-tertiary">
						{{ t('showcase.deliverability.healthDetail') }}
					</p>
				</div>
			</div>

			<!-- DNS authentication checks -->
			<p
				class="text-[7.5px] font-medium uppercase tracking-[0.08em] text-text-tertiary mt-3 mb-1.5"
			>
				{{ t('showcase.deliverability.authTitle') }}
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
					<span class="ml-auto text-[7.5px] text-text-tertiary">{{ t(check.detailKey) }}</span>
				</div>
			</div>

			<!-- Ramp -->
			<div class="rounded-lg border border-border-subtle bg-surface-3 p-3 mt-2.5">
				<div class="flex items-baseline justify-between">
					<p class="text-[8px] font-medium text-text-primary">
						{{ t('showcase.deliverability.rampTitle') }}
					</p>
					<p class="text-[8px] font-semibold text-text-primary tabular-nums">
						{{ t('showcase.deliverability.rampValue') }}
					</p>
				</div>
				<div class="h-1.5 rounded-full bg-border-subtle mt-1.5 overflow-hidden">
					<div class="h-full w-[62%] rounded-full bg-brand" />
				</div>
				<p class="text-[7px] text-text-tertiary mt-1">
					{{ t('showcase.deliverability.rampNote') }}
				</p>
			</div>

			<!-- Placement -->
			<div class="rounded-lg border border-border-subtle bg-surface-3 p-3 mt-2.5">
				<div class="flex items-baseline justify-between">
					<p class="text-[8px] font-medium text-text-primary">
						{{ t('showcase.deliverability.placementTitle') }}
					</p>
					<p class="text-[7px] text-text-tertiary">
						{{ t('showcase.deliverability.placementRun') }}
					</p>
				</div>
				<div class="flex items-center gap-2 mt-1.5">
					<div class="flex-1 h-1.5 rounded-full bg-border-subtle overflow-hidden">
						<div class="h-full w-[94%] rounded-full bg-success" />
					</div>
					<span class="text-[7.5px] text-text-secondary tabular-nums">
						{{ t('showcase.deliverability.placementValue') }}
					</span>
				</div>
			</div>
		</div>
	</ShowcaseWindowFrame>
</template>
