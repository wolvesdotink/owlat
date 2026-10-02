<script setup lang="ts">
/**
 * How close a domain is to the next DMARC enforcement step, and the exact
 * record to publish when it gets there.
 *
 * Owlat never changes the policy itself: the record shown here is advice, and
 * the policy selector on the domain (linked below) is the one control that
 * rewrites the domain's `_dmarc` record.
 */
import { formatPassRate, readinessState } from '~/utils/dmarcReportView';

const props = defineProps<{
	domain: string;
	readiness: {
		streakDays: number;
		requiredDays: number;
		latestAlignedRate: number | null;
		isReady: boolean;
		currentPolicy: 'none' | 'quarantine' | 'reject';
		nextPolicy: 'none' | 'quarantine' | 'reject' | null;
		recommendedRecord: { type: 'TXT'; host: string; value: string } | null;
	};
}>();

const { t } = useI18n();

const state = computed(() => readinessState(props.readiness));

const tone = computed(() => {
	if (state.value === 'ready' || state.value === 'enforced') return 'success' as const;
	if (state.value === 'failing') return 'error' as const;
	return 'neutral' as const;
});

const icon = computed(
	() =>
		({
			ready: 'lucide:shield-check',
			enforced: 'lucide:shield-check',
			building: 'lucide:hourglass',
			failing: 'lucide:shield-alert',
			'no-data': 'lucide:inbox',
		})[state.value]
);

const progress = computed(() =>
	Math.min(100, Math.round((props.readiness.streakDays / props.readiness.requiredDays) * 100))
);

const domainsLink = computed(
	() => `/dashboard/admin/delivery/domains?domain=${encodeURIComponent(props.domain)}`
);
</script>

<template>
	<div class="space-y-4" data-testid="dmarc-readiness" :data-state="state">
		<div class="flex items-start gap-3">
			<UiIconBox
				:icon="icon"
				size="sm"
				:variant="tone === 'neutral' ? 'surface' : tone"
				rounded="lg"
			/>
			<div class="min-w-0">
				<p class="font-medium text-text-primary">
					{{
						t(`components.delivery.dmarcReadiness.headline.${state}`, {
							next: readiness.nextPolicy ?? '',
							current: readiness.currentPolicy,
						})
					}}
				</p>
				<p class="mt-0.5 text-sm text-text-secondary">
					{{
						t(`components.delivery.dmarcReadiness.body.${state}`, {
							days: readiness.streakDays,
							required: readiness.requiredDays,
							rate: formatPassRate(readiness.latestAlignedRate),
							next: readiness.nextPolicy ?? '',
						})
					}}
				</p>
			</div>
		</div>

		<div v-if="state === 'building' || state === 'ready'">
			<div class="flex items-center justify-between text-xs text-text-secondary mb-1">
				<span>
					{{
						t('components.delivery.dmarcReadiness.streak', {
							days: readiness.streakDays,
							required: readiness.requiredDays,
						})
					}}
				</span>
				<span>{{ progress }}%</span>
			</div>
			<UiProgressBar
				:value="progress"
				variant="success"
				:aria-label="t('components.delivery.dmarcReadiness.progressLabel')"
			/>
		</div>

		<div v-if="state === 'ready' && readiness.recommendedRecord" class="space-y-3">
			<DomainsDNSRecordPanel
				:record="readiness.recommendedRecord"
				:label="
					t('components.delivery.dmarcReadiness.recordLabel', { next: readiness.nextPolicy ?? '' })
				"
				:domain="domain"
			/>
			<p class="text-xs text-text-secondary">
				{{ t('components.delivery.dmarcReadiness.howToApply') }}
				<NuxtLink :to="domainsLink" class="text-brand hover:underline">
					{{ t('components.delivery.dmarcReadiness.openDomain') }}
				</NuxtLink>
			</p>
		</div>
	</div>
</template>
