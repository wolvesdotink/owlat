<script setup lang="ts">
/* In-code mock of a campaign report. Campaign names/status echo
 * apps/api/convex/seedDemo/fixtures/campaigns.json ("Summer Sale 2026",
 * "June Announcements"); numbers are modest illustrative stats. Decorative
 * only — aria-hidden is carried by the parent section. Swap for a real
 * capture by replacing the body with an <img>. */

const { t } = useI18n();

// Labels AND values come from the catalog: a German visitor reads "2.412" and
// "38,7 %", not the English number formatting.
const stats = [
	{ labelKey: 'showcase.campaigns.stats.sentLabel', valueKey: 'showcase.campaigns.stats.sentValue' },
	{ labelKey: 'showcase.campaigns.stats.openLabel', valueKey: 'showcase.campaigns.stats.openValue' },
	{
		labelKey: 'showcase.campaigns.stats.clickLabel',
		valueKey: 'showcase.campaigns.stats.clickValue',
	},
	{
		labelKey: 'showcase.campaigns.stats.bouncedLabel',
		valueKey: 'showcase.campaigns.stats.bouncedValue',
	},
];

// Opens per day since send — plain illustrative shape for the bar chart.
const bars = [22, 38, 64, 92, 78, 54, 40, 33, 26, 21, 17, 14];

const rows = [
	{
		id: 'summer',
		nameKey: 'showcase.campaigns.rows.summer.name',
		metaKey: 'showcase.campaigns.rows.summer.meta',
		statusKey: 'showcase.campaigns.rows.summer.status',
		sent: true,
	},
	{
		id: 'june',
		nameKey: 'showcase.campaigns.rows.june.name',
		metaKey: 'showcase.campaigns.rows.june.meta',
		statusKey: 'showcase.campaigns.rows.june.status',
		sent: false,
	},
];
</script>

<template>
	<ShowcaseWindowFrame url="app.owlat.app/dashboard/campaigns">
		<div class="h-[340px] bg-surface-2 p-4 text-left overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-2">
					<p class="text-[11px] font-semibold text-text-primary">
						{{ t('showcase.campaigns.name') }}
					</p>
					<span
						class="rounded-full bg-success-subtle text-success text-[7.5px] font-medium px-2 py-0.5"
					>
						{{ t('showcase.campaigns.status') }}
					</span>
				</div>
				<span
					class="rounded-full border border-border-default text-text-secondary text-[8px] font-medium px-2.5 py-1"
				>
					{{ t('showcase.campaigns.export') }}
				</span>
			</div>
			<p class="text-[8px] text-text-tertiary mt-0.5">{{ t('showcase.campaigns.subject') }}</p>

			<!-- Stat tiles -->
			<div class="grid grid-cols-4 gap-2 mt-3.5">
				<div
					v-for="stat in stats"
					:key="stat.labelKey"
					class="rounded-lg border border-border-subtle bg-surface-3 px-2.5 py-2"
				>
					<p class="text-[7px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
						{{ t(stat.labelKey) }}
					</p>
					<p class="text-[12px] font-semibold text-text-primary mt-0.5 tabular-nums">
						{{ t(stat.valueKey) }}
					</p>
				</div>
			</div>

			<!-- Opens chart -->
			<div class="rounded-lg border border-border-subtle bg-surface-3 p-3 mt-2.5">
				<div class="flex items-baseline justify-between">
					<p class="text-[8px] font-medium text-text-primary">
						{{ t('showcase.campaigns.chartTitle') }}
					</p>
					<p class="text-[7px] text-text-tertiary">{{ t('showcase.campaigns.chartRange') }}</p>
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
					{{ t('showcase.campaigns.recentTitle') }}
				</p>
				<div
					class="rounded-lg border border-border-subtle bg-surface-3 divide-y divide-border-subtle"
				>
					<div
						v-for="row in rows"
						:key="row.id"
						class="flex items-center justify-between px-2.5 py-1.5"
					>
						<div>
							<p class="text-[8.5px] font-medium text-text-primary">{{ t(row.nameKey) }}</p>
							<p class="text-[7px] text-text-tertiary">{{ t(row.metaKey) }}</p>
						</div>
						<span
							class="rounded-full text-[7px] font-medium px-2 py-0.5"
							:class="
								row.sent
									? 'bg-success-subtle text-success'
									: 'border border-border-default text-text-tertiary'
							"
						>
							{{ t(row.statusKey) }}
						</span>
					</div>
				</div>
			</div>
		</div>
	</ShowcaseWindowFrame>
</template>
