<script setup lang="ts">
/**
 * What Microsoft SNDS currently says about the sending addresses, for the
 * Deliverability Center. A red address sends Microsoft mail at a reduced rate
 * (`delivery/sndsStanding.ts`), which the operator has to be able to see; a
 * yellow one is a warning only. Renders nothing without a fresh reading.
 */
import { TriangleWarningIcon } from '@coolicons/vue';

const props = defineProps<{
	standings: readonly { ip: string; filterResult: 'red' | 'yellow'; periodStart: number }[];
}>();

const { t, locale } = useI18n();

const RECOVERY_DOCS =
	'https://docs.owlat.app/developer/external-reputation-feedback#when-snds-reports-an-address-red';

const hasRed = computed(() => props.standings.some((standing) => standing.filterResult === 'red'));

// SNDS days are UTC days.
function day(periodStart: number): string {
	return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeZone: 'UTC' }).format(
		new Date(periodStart)
	);
}
</script>

<template>
	<div
		v-if="standings.length > 0"
		role="status"
		class="card p-5"
		:class="hasRed ? 'border-error/30 bg-error/5' : 'border-warning/30 bg-warning/5'"
		data-testid="microsoft-snds-note"
	>
		<div class="flex gap-3">
			<TriangleWarningIcon
				class="w-5 h-5 shrink-0 mt-0.5"
				:class="hasRed ? 'text-error' : 'text-warning'"
				aria-hidden="true"
			/>
			<div class="min-w-0 space-y-1.5">
				<h3 class="font-medium text-text-primary">
					{{ t('dashboard.admin.delivery.deliverability.microsoftSnds.title') }}
				</h3>
				<p v-for="standing in standings" :key="standing.ip" class="text-sm text-text-secondary">
					{{
						t(`dashboard.admin.delivery.deliverability.microsoftSnds.${standing.filterResult}`, {
							ip: standing.ip,
							day: day(standing.periodStart),
						})
					}}
				</p>
				<a
					v-if="hasRed"
					:href="RECOVERY_DOCS"
					target="_blank"
					rel="noopener"
					class="link text-sm font-medium"
				>
					{{ t('dashboard.admin.delivery.deliverability.microsoftSnds.action') }}
				</a>
			</div>
		</div>
	</div>
</template>
