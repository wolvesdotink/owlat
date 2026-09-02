<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { formatDateTime } from '~/utils/formatters';

const { t } = useI18n();

useHead({ title: () => t('dashboard.inbox.quarantine.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
});

// Fetch quarantined messages
const {
	data: quarantinedMessages,
	isLoading,
	error,
} = useConvexQuery(api.inbox.queries.getQuarantined, () => ({ limit: 50 }));

// Mutations
const { run: releaseFromQuarantine } = useBackendOperation(
	api.inbox.mutations.releaseFromQuarantine,
	{ label: () => t('dashboard.inbox.quarantine.releaseOperation') }
);
const { run: blockSender } = useBackendOperation(api.inbox.mutations.blockSender, {
	label: () => t('dashboard.inbox.quarantine.blockOperation'),
});

const actionInProgress = ref<string | null>(null);

// Success toast
const { showToast } = useToast();
const { isAdmin } = usePermissions();

const onRelease = async (messageId: Id<'inboundMessages'>) => {
	actionInProgress.value = messageId;
	try {
		const result = await releaseFromQuarantine({ inboundMessageId: messageId });
		if (!result.ok) return;
		showToast(t('dashboard.inbox.quarantine.releasedToast'));
	} finally {
		actionInProgress.value = null;
	}
};

// Blocking a sender is a lasting action, so confirm before applying it.
const pendingBlock = ref<{ _id: Id<'inboundMessages'>; from: string } | null>(null);

const onBlock = async (messageId: Id<'inboundMessages'>) => {
	actionInProgress.value = messageId;
	try {
		const result = await blockSender({ inboundMessageId: messageId });
		if (!result.ok) return;
		showToast(t('dashboard.inbox.quarantine.blockedToast'));
	} finally {
		actionInProgress.value = null;
	}
};

const confirmBlock = async () => {
	if (!pendingBlock.value) return;
	await onBlock(pendingBlock.value._id);
	pendingBlock.value = null;
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
				<h1
					class="text-2xl font-medium tracking-[-0.02em] text-text-primary flex items-center gap-3"
				>
					<Icon name="lucide:shield-alert" class="w-7 h-7 text-error" />
					{{ t('dashboard.inbox.quarantine.title') }}
				</h1>
				<p class="text-text-secondary mt-1">
					{{ t('dashboard.inbox.quarantine.subtitle') }}
				</p>
			</div>
		</div>

		<!-- Loading / faulted / empty / list — a faulted query must NOT look like
		     an empty (all-clear) quarantine, which is the boundary's ordering. -->
		<UiQueryBoundary
			:loading="isLoading"
			:error="error"
			:empty="!quarantinedMessages || quarantinedMessages.length === 0"
			:error-title="t('dashboard.inbox.quarantine.errorTitle')"
			:error-message="t('dashboard.inbox.quarantine.errorMessage')"
			:loading-label="t('dashboard.inbox.quarantine.loading')"
		>
			<template #empty>
				<UiEmptyState
					icon="lucide:shield-check"
					:title="t('dashboard.inbox.quarantine.emptyTitle')"
					:description="t('dashboard.inbox.quarantine.emptyBody')"
				/>
			</template>

			<!-- Quarantined Messages -->
			<div class="space-y-4">
				<div v-for="message in quarantinedMessages" :key="message._id" class="card border-error/20">
					<div class="flex items-start justify-between mb-3">
						<div class="flex items-center gap-3">
							<div
								class="flex-shrink-0 w-10 h-10 rounded-full bg-error-subtle flex items-center justify-center"
							>
								<Icon name="lucide:shield-alert" class="w-5 h-5 text-error" />
							</div>
							<div>
								<p class="text-text-primary font-medium text-sm">{{ message.from }}</p>
								<p class="text-xs text-text-tertiary">
									{{ formatDateTime(message._creationTime) }}
								</p>
							</div>
						</div>
					</div>

					<!-- Outcome first, then the reasons, then the machine's own record. A
					     non-expert is making a security decision here, so the enum and the
					     confidence number are the LAST thing on the card, not the first. -->
					<InboxQuarantineReason class="mb-4" :flags="message.securityFlags" />

					<!-- Message preview -->
					<p v-if="message.subject" class="text-text-primary font-medium text-sm mb-1">
						{{ message.subject }}
					</p>
					<p class="text-text-secondary text-sm line-clamp-3 mb-4">
						{{ message.textBody || t('dashboard.inbox.quarantine.noTextContent') }}
					</p>

					<!-- Actions -->
					<div v-if="isAdmin" class="flex items-center gap-2 border-t border-border-subtle pt-4">
						<UiButton
							variant="secondary"
							size="sm"
							class="gap-1"
							:disabled="actionInProgress === message._id"
							@click="onRelease(message._id)"
						>
							<Icon name="lucide:check-circle" class="w-3 h-3" />
							{{ t('dashboard.inbox.quarantine.release') }}
						</UiButton>
						<UiButton
							variant="ghost"
							size="sm"
							class="gap-1 text-error hover:bg-error-subtle"
							:disabled="actionInProgress === message._id"
							@click="pendingBlock = { _id: message._id, from: message.from }"
						>
							<Icon name="lucide:ban" class="w-3 h-3" />
							{{ t('dashboard.inbox.quarantine.blockSender') }}
						</UiButton>
					</div>
				</div>
			</div>
		</UiQueryBoundary>

		<!-- Block confirmation — future mail from this sender is silently dropped -->
		<UiConfirmationDialog
			v-if="isAdmin"
			:open="!!pendingBlock"
			variant="danger"
			:title="t('dashboard.inbox.quarantine.blockDialogTitle')"
			:description="
				t('dashboard.inbox.quarantine.blockDialogDescription', { sender: pendingBlock?.from ?? '' })
			"
			:confirm-text="t('dashboard.inbox.quarantine.blockDialogConfirm')"
			:is-loading="!!pendingBlock && actionInProgress === pendingBlock._id"
			@update:open="
				(v: boolean) => {
					if (!v) pendingBlock = null;
				}
			"
			@confirm="confirmBlock"
		/>
	</div>
</template>
