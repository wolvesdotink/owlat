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

const { data: send, isLoading } = useConvexQuery(api.transactional.sends.get, () => ({
	id: sendId.value,
}));
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Loading State -->
		<div v-if="isLoading && !send" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">
					{{ t('dashboard.send.transactional.detail.sends.detail.loading') }}
				</p>
			</div>
		</div>

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

				<div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
					<div>
						<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
							{{ send.contact?.firstName || send.email?.split('@')[0] || t('common.unknown') }}
							{{ send.contact?.lastName || '' }}
						</h1>
						<p class="mt-1 text-text-secondary">{{ send.email }}</p>
						<div
							v-if="send.transactionalEmail"
							class="mt-2 flex items-center gap-2 text-sm text-text-tertiary"
						>
							<Icon name="lucide:zap" class="w-4 h-4" />
							<span>{{ send.transactionalEmail.name }}</span>
							<span class="font-mono text-xs bg-bg-surface px-1.5 py-0.5 rounded">
								{{ send.transactionalEmail.slug }}
							</span>
						</div>
					</div>

					<DashboardSendStatusBadge :status="send.status" fallback="sent" />
				</div>
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
