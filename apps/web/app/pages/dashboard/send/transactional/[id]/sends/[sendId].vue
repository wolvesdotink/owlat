<script setup lang="ts">
import { api } from '@owlat/api';

const { t } = useI18n();

useHead({ title: () => t('dashboard.send.transactional.detail.sends.detail.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const emailId = useRouteId<'transactionalEmails'>();
const sendId = useRouteId<'transactionalSends'>('sendId');

const {
	data: send,
	isLoading,
	error,
	refetch,
} = useConvexQuery(api.transactional.sends.get, () => ({
	id: sendId.value,
}));

const contactName = computed(() => {
	const value = send.value;
	if (!value) return '';
	const first = value.contact?.firstName || value.email?.split('@')[0] || t('common.unknown');
	return value.contact?.lastName ? `${first} ${value.contact.lastName}` : first;
});
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- A failed read is not a missing send. -->
		<UiQueryBoundary v-if="error" :error="error" @retry="refetch" />

		<!-- Loading State -->
		<DashboardDetailSkeleton
			v-else-if="isLoading && !send"
			:label="t('dashboard.send.transactional.detail.sends.detail.loading')"
			back="link"
			meta
			body="cards"
			:sections="1"
		/>

		<!-- Not Found -->
		<div
			v-else-if="!send"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:mail" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">
				{{ t('dashboard.send.transactional.detail.sends.detail.notFound.title') }}
			</p>
			<p class="text-sm text-text-tertiary mt-1">
				{{ t('dashboard.send.transactional.detail.sends.detail.notFound.description') }}
			</p>
			<UiButton variant="secondary" :to="'/dashboard/send/transactional'" class="mt-6">
				{{ t('dashboard.send.transactional.detail.sends.detail.backToList') }}
			</UiButton>
		</div>

		<!-- Send Detail -->
		<div v-else>
			<!-- Header -->
			<div class="mb-8">
				<NuxtLink
					:to="'/dashboard/send/transactional'"
					class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary text-sm mb-4 transition-colors"
				>
					<Icon name="lucide:arrow-left" class="w-4 h-4" />
					{{ t('dashboard.send.transactional.detail.sends.detail.backToList') }}
				</NuxtLink>

				<UiPageHeader :title="contactName" :description="send.email">
					<template #meta>
						<div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-text-tertiary">
							<DashboardSendStatusBadge :status="send.status" fallback="sent" />
							<div v-if="send.transactionalEmail" class="flex items-center gap-2">
								<Icon name="lucide:zap" class="w-4 h-4" />
								<span>{{ send.transactionalEmail.name }}</span>
								<span class="font-mono text-xs bg-bg-surface px-1.5 py-0.5 rounded">
									{{ send.transactionalEmail.slug }}
								</span>
							</div>
						</div>
					</template>
				</UiPageHeader>
			</div>

			<!-- Timeline -->
			<DashboardEmailSendTimeline
				:status="send.status"
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
				:data-variables="send.dataVariables"
				:show-queued="false"
			/>
		</div>
	</div>
</template>
