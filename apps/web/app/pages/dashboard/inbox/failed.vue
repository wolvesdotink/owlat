<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { formatDateTime } from '~/utils/formatters';

useHead({ title: 'Failed Messages — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
});

// Fetch permanently-failed messages
const { data: failedMessages, isLoading, error } = useConvexQuery(
	api.inbox.queries.getFailed,
	() => ({ limit: 50 }),
);

// Manual re-enqueue
const { run: retryFailedMessage } = useBackendOperation(
	api.inbox.mutations.retryFailedMessage,
	{ label: 'Retry message' }
);

const actionInProgress = ref<string | null>(null);

const { showToast } = useToast();

const onRetry = async (messageId: Id<'inboundMessages'>) => {
	actionInProgress.value = messageId;
	try {
		const result = await retryFailedMessage({ inboundMessageId: messageId });
		if (result === undefined) return;
		showToast('Message re-enqueued for processing');
	} finally {
		actionInProgress.value = null;
	}
};
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex items-center gap-4 mb-8">
			<NuxtLink
				to="/dashboard/inbox"
				class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
			</NuxtLink>
			<div>
				<h1 class="text-2xl font-semibold text-text-primary flex items-center gap-3">
					<Icon name="lucide:alert-triangle" class="w-7 h-7 text-error" />
					Failed Messages
				</h1>
				<p class="text-text-secondary mt-1">
					Inbound messages whose processing failed after the automatic retries were
					exhausted. Read the error and re-enqueue once the cause is resolved.
				</p>
			</div>
		</div>

		<!-- Loading -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading failed messages...</p>
			</div>
		</div>

		<!-- Error — a faulted query must NOT look like an empty (all-clear) list -->
		<UiErrorAlert
			v-else-if="error"
			title="Couldn't load failed messages"
			message="We hit an error loading failed messages. Reload the page to try again."
			class="my-8"
		/>

		<!-- Empty State -->
		<div
			v-else-if="!failedMessages || failedMessages.length === 0"
			class="flex flex-col items-center justify-center py-16 text-center"
		>
			<UiIconBox icon="lucide:check-circle" size="xl" variant="success" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">No failed messages</p>
			<p class="text-sm text-text-tertiary mt-1">
				Every inbound message processed successfully.
			</p>
		</div>

		<!-- Failed Messages -->
		<div v-else class="space-y-4">
			<div
				v-for="message in failedMessages"
				:key="message._id"
				class="card border-error/20"
			>
				<div class="flex items-start justify-between mb-3">
					<div class="flex items-center gap-3">
						<div class="flex-shrink-0 w-10 h-10 rounded-full bg-error-subtle flex items-center justify-center">
							<Icon name="lucide:alert-triangle" class="w-5 h-5 text-error" />
						</div>
						<div>
							<p class="text-text-primary font-medium text-sm">{{ message.from }}</p>
							<p class="text-xs text-text-tertiary">
								{{ formatDateTime(message._creationTime) }}
							</p>
						</div>
					</div>
				</div>

				<!-- Failure reason -->
				<div
					v-if="message.errorMessage"
					class="mb-4 p-3 bg-error-subtle rounded-lg"
				>
					<p class="text-xs text-error font-medium uppercase tracking-wider mb-2">Failure reason</p>
					<p class="text-sm text-text-primary break-words">{{ message.errorMessage }}</p>
				</div>

				<!-- Message preview -->
				<p v-if="message.subject" class="text-text-primary font-medium text-sm mb-1">
					{{ message.subject }}
				</p>
				<p class="text-text-secondary text-sm line-clamp-3 mb-4">
					{{ message.textBody || '(No text content)' }}
				</p>

				<!-- Actions -->
				<div class="flex items-center gap-2 border-t border-border-subtle pt-4">
					<button
						class="btn btn-secondary btn-sm gap-1"
						:disabled="actionInProgress === message._id"
						@click="onRetry(message._id)"
					>
						<Icon name="lucide:refresh-cw" class="w-3 h-3" />
						Retry processing
					</button>
				</div>
			</div>
		</div>
	</div>
</template>
