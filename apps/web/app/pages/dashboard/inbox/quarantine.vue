<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { formatDateTime } from '~/utils/formatters';

const { t, te } = useI18n();

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

// The injection taxonomy is a backend enum; an unrecognised value renders as
// stored rather than as a key path.
const getInjectionTypeLabel = (type: string) => {
	const key = `dashboard.inbox.quarantine.injectionTypes.${type}`;
	return te(key) ? t(key) : type;
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

		<!-- Loading -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">{{ t('dashboard.inbox.quarantine.loading') }}</p>
			</div>
		</div>

		<!-- Error — a faulted query must NOT look like an empty (all-clear) quarantine -->
		<UiErrorAlert
			v-else-if="error"
			:title="t('dashboard.inbox.quarantine.errorTitle')"
			:message="t('dashboard.inbox.quarantine.errorMessage')"
			class="my-8"
		/>

		<!-- Empty State -->
		<div
			v-else-if="!quarantinedMessages || quarantinedMessages.length === 0"
			class="flex flex-col items-center justify-center py-16 text-center"
		>
			<UiIconBox
				icon="lucide:shield-check"
				size="xl"
				variant="success"
				rounded="full"
				class="mb-4"
			/>
			<p class="text-text-secondary font-medium">
				{{ t('dashboard.inbox.quarantine.emptyTitle') }}
			</p>
			<p class="text-sm text-text-tertiary mt-1">
				{{ t('dashboard.inbox.quarantine.emptyBody') }}
			</p>
		</div>

		<!-- Quarantined Messages -->
		<div v-else class="space-y-4">
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

				<!-- Security flags -->
				<div v-if="message.securityFlags" class="mb-4 p-3 bg-error-subtle rounded-lg">
					<p class="text-xs text-error font-medium uppercase tracking-wider mb-2">
						{{ t('dashboard.inbox.quarantine.securityAlert') }}
					</p>
					<div class="space-y-1">
						<p v-if="message.securityFlags.injectionType" class="text-sm text-text-primary">
							<span class="font-medium">{{ t('dashboard.inbox.quarantine.typeLabel') }}</span>
							{{ getInjectionTypeLabel(message.securityFlags.injectionType) }}
						</p>
						<p class="text-sm text-text-primary">
							<span class="font-medium">{{ t('dashboard.inbox.quarantine.confidenceLabel') }}</span>
							{{
								t('dashboard.inbox.quarantine.confidenceValue', {
									percent: Math.round((message.securityFlags.confidence ?? 0) * 100),
								})
							}}
						</p>
						<p v-if="message.securityFlags.flaggedContent" class="text-sm text-text-secondary mt-2">
							<span class="font-medium text-text-primary">
								{{ t('dashboard.inbox.quarantine.flaggedContentLabel') }}
							</span>
							<code class="ml-1 px-1.5 py-0.5 bg-bg-surface rounded text-xs">
								{{ message.securityFlags.flaggedContent }}
							</code>
						</p>
					</div>
				</div>

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
