<script setup lang="ts">
/**
 * "Bounces and complaints cannot reach Owlat", for the Deliverability Center.
 *
 * A transport that sends but whose webhook key is unset has every bounce and
 * complaint report rejected, so nothing is ever suppressed. The Delivery hub's
 * readiness panel says so on its transport gate; this note says the same here,
 * read off the same per-stream facts (`getTransportSummary`), so the two pages
 * cannot disagree. Renders nothing while reports can arrive.
 */
import { api } from '@owlat/api';
import { TriangleWarningIcon } from '@coolicons/vue';

const { t } = useI18n();

const { data: summary } = useOrganizationQuery(api.delivery.status.getTransportSummary);

const missing = computed(() => {
	const streams = summary.value?.streams;
	if (!streams) return [];
	return [
		...new Set([
			...(streams.transactional.canSend ? streams.transactional.feedbackMissing : []),
			...(streams.campaign.canSend ? streams.campaign.feedbackMissing : []),
		]),
	];
});
</script>

<template>
	<div
		v-if="missing.length > 0"
		role="status"
		class="card border-error/30 bg-error/5 p-5"
		data-testid="bounce-feedback-note"
	>
		<div class="flex gap-3">
			<TriangleWarningIcon class="w-5 h-5 text-error shrink-0 mt-0.5" aria-hidden="true" />
			<div class="min-w-0 space-y-1.5">
				<h3 class="font-medium text-text-primary">
					{{ t('dashboard.admin.delivery.deliverability.bounceFeedback.title') }}
				</h3>
				<p class="text-sm text-text-secondary">
					{{
						t('dashboard.admin.delivery.deliverability.bounceFeedback.detail', {
							variables: missing.join(', '),
						})
					}}
				</p>
				<NuxtLink to="/dashboard/admin/delivery/transport" class="link text-sm font-medium">
					{{ t('dashboard.admin.delivery.deliverability.bounceFeedback.action') }}
				</NuxtLink>
			</div>
		</div>
	</div>
</template>
