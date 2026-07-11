<script setup lang="ts">
import { api } from '@owlat/api';

useHead({ title: 'Send Details — Owlat' });

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
</script>

<template>
	<div class="p-6 lg:p-8">
		<UiQueryBoundary
			:loading="isLoading && !send"
			:error="error"
			error-title="Couldn't load send details"
			loading-label="Loading send details..."
			@retry="refetch"
		>
			<!-- Not Found -->
			<div
				v-if="!send"
				class="card flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox icon="lucide:mail" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">Send not found</p>
				<p class="text-sm text-text-tertiary mt-1">
					This email send may have been deleted or you don't have access to it.
				</p>
				<NuxtLink :to="`/dashboard/campaigns/${campaignId}/report`" class="btn btn-secondary mt-6">
					Back to Campaign Report
				</NuxtLink>
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
						Back to Campaign Report
					</NuxtLink>

					<div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
						<div>
							<h1 class="text-2xl font-semibold text-text-primary">
								{{ send.contactFirstName || send.contactEmail?.split('@')[0] || 'Unknown' }}
								{{ send.contactLastName || '' }}
							</h1>
							<p class="mt-1 text-text-secondary">{{ send.contactEmail }}</p>
							<div
								v-if="send.campaign"
								class="mt-2 flex items-center gap-2 text-sm text-text-tertiary"
							>
								<Icon name="lucide:megaphone" class="w-4 h-4" />
								<span>{{ send.campaign.name }}</span>
								<span v-if="send.personalizedSubject" class="text-text-tertiary">
									&mdash; {{ send.personalizedSubject }}
								</span>
							</div>
						</div>

						<div class="flex items-center gap-3 flex-shrink-0">
							<span
								v-if="send.abVariant"
								class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-brand/10 text-brand"
							>
								Variant {{ send.abVariant }}
							</span>
							<DashboardSendStatusBadge :status="send.status" fallback="queued" />
						</div>
					</div>
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
