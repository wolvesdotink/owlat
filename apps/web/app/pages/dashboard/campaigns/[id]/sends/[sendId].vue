<script setup lang="ts">
import { api } from '@owlat/api';

const { t } = useI18n();

useHead({ title: () => t('dashboard.campaigns.detail.sends.detail.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const campaignId = useRouteId<'campaigns'>();
const sendId = useRouteId<'emailSends'>('sendId');

const {
	data: send,
	isLoading,
	error,
	refetch,
} = useConvexQuery(api.delivery.sends.get, () => ({
	id: sendId.value,
}));

const contactName = computed(() => {
	const value = send.value;
	if (!value) return '';
	const first = value.contactFirstName || value.contactEmail?.split('@')[0] || t('common.unknown');
	return value.contactLastName ? `${first} ${value.contactLastName}` : first;
});
</script>

<template>
	<div class="p-6 lg:p-8">
		<UiQueryBoundary
			:loading="isLoading && !send"
			:error="error"
			:error-title="t('dashboard.campaigns.detail.sends.detail.errorTitle')"
			:loading-label="t('dashboard.campaigns.detail.sends.detail.loadingLabel')"
			@retry="refetch"
		>
			<!-- Not Found -->
			<div
				v-if="!send"
				class="card flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox icon="lucide:mail" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">
					{{ t('dashboard.campaigns.detail.sends.detail.notFoundTitle') }}
				</p>
				<p class="text-sm text-text-tertiary mt-1">
					{{ t('dashboard.campaigns.detail.sends.detail.notFoundDescription') }}
				</p>
				<UiButton
					variant="secondary"
					:to="`/dashboard/campaigns/${campaignId}/report`"
					class="mt-6"
				>
					{{ t('dashboard.campaigns.detail.sends.detail.backToReport') }}
				</UiButton>
			</div>

			<!-- Send Detail -->
			<div v-else>
				<!-- Header -->
				<div class="mb-8">
					<NuxtLink
						:to="`/dashboard/campaigns/${campaignId}/report`"
						class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary text-sm mb-4 transition-colors"
					>
						<Icon name="lucide:arrow-left" class="w-4 h-4" />
						{{ t('dashboard.campaigns.detail.sends.detail.backToReport') }}
					</NuxtLink>

					<UiPageHeader :title="contactName" :description="send.contactEmail">
						<template #meta>
							<div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-text-tertiary">
								<span
									v-if="send.abVariant"
									class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-brand/10 text-brand"
								>
									{{
										t('dashboard.campaigns.detail.sends.detail.variant', {
											variant: send.abVariant,
										})
									}}
								</span>
								<DashboardSendStatusBadge :status="send.status" fallback="queued" />
								<div v-if="send.campaign" class="flex items-center gap-2">
									<Icon name="lucide:megaphone" class="w-4 h-4" />
									<span>{{ send.campaign.name }}</span>
									<span v-if="send.personalizedSubject" class="text-text-tertiary">
										&mdash; {{ send.personalizedSubject }}
									</span>
								</div>
							</div>
						</template>
					</UiPageHeader>
				</div>

				<!-- Timeline -->
				<DashboardEmailSendTimeline
					:status="send.status"
					:queued-at="send.queuedAt"
					:sent-at="send.sentAt"
					:delivered-at="send.deliveredAt"
					:opened-at="send.openedAt"
					:clicked-at="send.clickedAt"
					:bounced-at="send.bouncedAt"
					:complained-at="send.complainedAt"
					:open-count="send.openCount"
					:clicked-links="send.clickedLinks"
					:error-message="send.errorMessage"
					:error-code="send.errorCode"
					:provider-message-id="send.providerMessageId"
					:show-queued="true"
				/>
			</div>
		</UiQueryBoundary>
	</div>
</template>
