<script setup lang="ts">
/**
 * "Audience & sending": new contacts per day over the last 30 days, then the
 * sending health rows. New contacts is intake only — unsubscribes and removals
 * are not subtracted — so it is labelled "New contacts", never growth. Each
 * status row pairs its colour with an icon and a sentence, so the state never
 * rests on colour alone. Thresholds are the shared reputation thresholds the
 * backend classifies risk with.
 */
import { api } from '@owlat/api';
import { REPUTATION_THRESHOLDS } from '@owlat/shared/reputation';
import type { MarketingDelivery } from '~/utils/marketingOverviewTypes';
import { formatNumber, formatPercentage } from '~/utils/formatters';

const props = defineProps<{ delivery: MarketingDelivery }>();

const { t } = useI18n();

const { data: growth, isLoading: growthLoading } = useOrganizationQuery(
	api.contacts.analytics.getSubscriberGrowth
);
const { level: healthLevel, reason: healthReason } = useDeliveryHealth();

const newContactBars = computed(() =>
	(growth.value?.days ?? []).map((d) => ({ label: d.label, value: d.count }))
);
const newContactsTotal = computed(() =>
	(growth.value?.days ?? []).reduce((sum, d) => sum + d.count, 0)
);

type RowTone = 'ok' | 'warn' | 'error' | 'neutral';

interface StatusRow {
	key: string;
	tone: RowTone;
	label: string;
	detail: string;
}

function toneFor(rate: number, thresholds: { medium: number; high: number }): RowTone {
	if (rate >= thresholds.high) return 'error';
	if (rate >= thresholds.medium) return 'warn';
	return 'ok';
}

const rows = computed<StatusRow[]>(() => {
	const out: StatusRow[] = [];
	if (healthLevel.value !== null) {
		out.push({
			key: 'health',
			tone: healthLevel.value,
			label:
				healthLevel.value === 'ok'
					? t('components.marketing.audience.healthOk')
					: t('components.marketing.audience.healthIssue'),
			detail: healthLevel.value === 'ok' ? '' : healthReason.value,
		});
	}
	const reputation = props.delivery.reputation;
	if (!reputation) {
		out.push({
			key: 'rates',
			tone: 'neutral',
			label: t('components.marketing.audience.noRates'),
			detail: '',
		});
		return out;
	}
	out.push({
		key: 'bounce',
		tone: toneFor(reputation.bounceRate, REPUTATION_THRESHOLDS.bounce),
		label: t('components.marketing.audience.bounceRate', {
			rate: formatPercentage(reputation.bounceRate, 2),
		}),
		detail: t('components.marketing.audience.limit', {
			limit: formatPercentage(REPUTATION_THRESHOLDS.bounce.medium, 0),
		}),
	});
	out.push({
		key: 'complaint',
		tone: toneFor(reputation.complaintRate, REPUTATION_THRESHOLDS.complaint),
		label: t('components.marketing.audience.complaintRate', {
			rate: formatPercentage(reputation.complaintRate, 2),
		}),
		detail: t('components.marketing.audience.limit', {
			limit: formatPercentage(REPUTATION_THRESHOLDS.complaint.medium, 1),
		}),
	});
	return out;
});

const toneIcon: Record<RowTone, string> = {
	ok: 'lucide:check-circle-2',
	warn: 'lucide:alert-triangle',
	error: 'lucide:alert-octagon',
	neutral: 'lucide:circle-dashed',
};
const toneClass: Record<RowTone, string> = {
	ok: 'text-success',
	warn: 'text-warning',
	error: 'text-error',
	neutral: 'text-text-tertiary',
};
</script>

<template>
	<div class="flex flex-col gap-5">
		<div>
			<div class="flex items-baseline justify-between gap-2">
				<h4 class="text-xs font-medium text-text-secondary">
					{{ t('components.marketing.audience.newContacts') }}
				</h4>
				<span class="text-xs tabular-nums text-text-tertiary">
					{{
						t('components.marketing.audience.newContactsTotal', {
							count: formatNumber(newContactsTotal),
						})
					}}
				</span>
			</div>
			<UiSkeleton v-if="growthLoading && !growth" class="mt-3 h-16 w-full" />
			<UiBars
				v-else
				class="mt-3"
				:data="newContactBars"
				:height="64"
				:ariaLabel="t('components.marketing.audience.newContactsAria')"
			/>
			<p v-if="growth?.truncated" class="mt-2 text-[11px] text-text-tertiary">
				{{ t('components.marketing.audience.truncated') }}
			</p>
		</div>

		<ul class="flex flex-col gap-2.5">
			<li v-for="row in rows" :key="row.key" class="flex items-start gap-2 text-sm">
				<Icon
					:name="toneIcon[row.tone]"
					:class="['w-4 h-4 mt-0.5 shrink-0', toneClass[row.tone]]"
				/>
				<div class="min-w-0">
					<p class="text-text-primary tabular-nums">{{ row.label }}</p>
					<p v-if="row.detail" class="text-xs text-text-tertiary">{{ row.detail }}</p>
				</div>
			</li>
		</ul>
	</div>
</template>
