<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Send Details — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const route = useRoute();
const emailId = computed(() => route.params['id'] as Id<'transactionalEmails'>);
const sendId = computed(() => route.params['sendId'] as Id<'transactionalSends'>);

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
				<p class="text-text-secondary text-sm">Loading send details...</p>
			</div>
		</div>

		<!-- Not Found -->
		<div
			v-else-if="!send"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:mail" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">Send not found</p>
			<p class="text-sm text-text-tertiary mt-1">
				This email send may have been deleted or you don't have access to it.
			</p>
			<NuxtLink :to="'/dashboard/send/transactional'" class="btn btn-secondary mt-6">
				Back to Transactional Emails
			</NuxtLink>
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
					Back to Transactional Emails
				</NuxtLink>

				<div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
					<div>
						<h1 class="text-2xl font-semibold text-text-primary">
							{{ send.contact?.firstName || send.email?.split('@')[0] || 'Unknown' }}
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
