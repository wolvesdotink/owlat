<script setup lang="ts">
/* In-code mock of a campaign report. Campaign names/status echo
 * apps/api/convex/seedDemo/fixtures/campaigns.json ("Summer Sale 2026",
 * "June Announcements"); numbers are modest illustrative stats. Decorative
 * only — aria-hidden is carried by the parent section. Swap for a real
 * capture by replacing the body with an <img>. */

const stats = [
	{ label: 'Sent', value: '2,412' },
	{ label: 'Open rate', value: '38.7%' },
	{ label: 'Click rate', value: '6.1%' },
	{ label: 'Bounced', value: '0.4%' },
];

// Opens per day since send — plain illustrative shape for the bar chart.
const bars = [22, 38, 64, 92, 78, 54, 40, 33, 26, 21, 17, 14];

const rows = [
	{ name: 'Summer Sale 2026', meta: 'Sent · 6 days ago', status: 'Sent', sent: true },
	{ name: 'June Announcements', meta: 'Draft · updated today', status: 'Draft', sent: false },
];
</script>

<template>
	<ShowcaseWindowFrame url="app.owlat.app/dashboard/campaigns">
		<div class="h-[340px] bg-surface-2 p-4 text-left overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-2">
					<p class="text-[11px] font-semibold text-text-primary">Summer Sale 2026</p>
					<span
						class="rounded-full bg-success-subtle text-success text-[7.5px] font-medium px-2 py-0.5"
					>
						Sent
					</span>
				</div>
				<span
					class="rounded-full border border-border-default text-text-secondary text-[8px] font-medium px-2.5 py-1"
				>
					Export
				</span>
			</div>
			<p class="text-[8px] text-text-tertiary mt-0.5">Summer Sale — 20% off this week only</p>

			<!-- Stat tiles -->
			<div class="grid grid-cols-4 gap-2 mt-3.5">
				<div
					v-for="stat in stats"
					:key="stat.label"
					class="rounded-lg border border-border-subtle bg-surface-3 px-2.5 py-2"
				>
					<p class="text-[7px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
						{{ stat.label }}
					</p>
					<p class="text-[12px] font-semibold text-text-primary mt-0.5 tabular-nums">
						{{ stat.value }}
					</p>
				</div>
			</div>

			<!-- Opens chart -->
			<div class="rounded-lg border border-border-subtle bg-surface-3 p-3 mt-2.5">
				<div class="flex items-baseline justify-between">
					<p class="text-[8px] font-medium text-text-primary">Opens</p>
					<p class="text-[7px] text-text-tertiary">Last 12 days</p>
				</div>
				<div class="flex items-end gap-1 h-[52px] mt-2">
					<div
						v-for="(bar, i) in bars"
						:key="i"
						class="flex-1 rounded-t-xs bg-brand"
						:style="{ height: `${bar}%`, opacity: 0.35 + (bar / 100) * 0.55 }"
					/>
				</div>
			</div>

			<!-- Recent campaigns -->
			<div class="mt-2.5">
				<p class="text-[7.5px] font-medium uppercase tracking-[0.08em] text-text-tertiary mb-1.5">
					Recent campaigns
				</p>
				<div
					class="rounded-lg border border-border-subtle bg-surface-3 divide-y divide-border-subtle"
				>
					<div
						v-for="row in rows"
						:key="row.name"
						class="flex items-center justify-between px-2.5 py-1.5"
					>
						<div>
							<p class="text-[8.5px] font-medium text-text-primary">{{ row.name }}</p>
							<p class="text-[7px] text-text-tertiary">{{ row.meta }}</p>
						</div>
						<span
							class="rounded-full text-[7px] font-medium px-2 py-0.5"
							:class="
								row.sent
									? 'bg-success-subtle text-success'
									: 'border border-border-default text-text-tertiary'
							"
						>
							{{ row.status }}
						</span>
					</div>
				</div>
			</div>
		</div>
	</ShowcaseWindowFrame>
</template>
