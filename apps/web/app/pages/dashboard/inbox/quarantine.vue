<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Quarantine — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
});

// Fetch quarantined messages
const { data: quarantinedMessages, isLoading, error } = useConvexQuery(
	api.inbox.queries.getQuarantined,
	() => ({ limit: 50 }),
);

// Mutations
const { run: releaseFromQuarantine } = useBackendOperation(
	api.inbox.mutations.releaseFromQuarantine,
	{ label: 'Release message' }
);
const { run: blockSender } = useBackendOperation(api.inbox.mutations.blockSender, {
	label: 'Block sender',
});

const actionInProgress = ref<string | null>(null);

// Success toast
const { showToast } = useToast();

const onRelease = async (messageId: Id<'inboundMessages'>) => {
	actionInProgress.value = messageId;
	try {
		const result = await releaseFromQuarantine({ inboundMessageId: messageId });
		if (result === undefined) return;
		showToast('Message released to processing pipeline');
	} finally {
		actionInProgress.value = null;
	}
};

const onBlock = async (messageId: Id<'inboundMessages'>) => {
	actionInProgress.value = messageId;
	try {
		const result = await blockSender({ inboundMessageId: messageId });
		if (result === undefined) return;
		showToast('Sender blocked');
	} finally {
		actionInProgress.value = null;
	}
};

const getInjectionTypeLabel = (type: string) => {
	const labels: Record<string, string> = {
		direct_injection: 'Direct Injection',
		delimiter_attack: 'Delimiter Attack',
		role_impersonation: 'Role Impersonation',
		encoding_evasion: 'Encoding Evasion',
		instruction_smuggling: 'Instruction Smuggling',
		none: 'Unknown',
	};
	return labels[type] || type;
};

const formatTimestamp = (timestamp: number) => {
	return new Date(timestamp).toLocaleString();
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
					<Icon name="lucide:shield-alert" class="w-7 h-7 text-error" />
					Quarantine
				</h1>
				<p class="text-text-secondary mt-1">
					Messages flagged by the inbound security filter. Review before releasing to the pipeline.
				</p>
			</div>
		</div>

		<!-- Loading -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<div class="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin" />
				<p class="text-text-secondary text-sm">Loading quarantined messages...</p>
			</div>
		</div>

		<!-- Error — a faulted query must NOT look like an empty (all-clear) quarantine -->
		<UiErrorAlert
			v-else-if="error"
			title="Couldn't load quarantine"
			message="We hit an error loading quarantined messages. Reload the page to try again."
			class="my-8"
		/>

		<!-- Empty State -->
		<div
			v-else-if="!quarantinedMessages || quarantinedMessages.length === 0"
			class="flex flex-col items-center justify-center py-16 text-center"
		>
			<UiIconBox icon="lucide:shield-check" size="xl" variant="success" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">No quarantined messages</p>
			<p class="text-sm text-text-tertiary mt-1">
				All inbound messages passed the security filter.
			</p>
		</div>

		<!-- Quarantined Messages -->
		<div v-else class="space-y-4">
			<div
				v-for="message in quarantinedMessages"
				:key="message._id"
				class="card border-error/20"
			>
				<div class="flex items-start justify-between mb-3">
					<div class="flex items-center gap-3">
						<div class="flex-shrink-0 w-10 h-10 rounded-full bg-error-subtle flex items-center justify-center">
							<Icon name="lucide:shield-alert" class="w-5 h-5 text-error" />
						</div>
						<div>
							<p class="text-text-primary font-medium text-sm">{{ message.from }}</p>
							<p class="text-xs text-text-tertiary">
								{{ formatTimestamp(message._creationTime) }}
							</p>
						</div>
					</div>
				</div>

				<!-- Security flags -->
				<div
					v-if="message.securityFlags"
					class="mb-4 p-3 bg-error-subtle rounded-lg"
				>
					<p class="text-xs text-error font-medium uppercase tracking-wider mb-2">Security Alert</p>
					<div class="space-y-1">
						<p v-if="message.securityFlags.injectionType" class="text-sm text-text-primary">
							<span class="font-medium">Type:</span>
							{{ getInjectionTypeLabel(message.securityFlags.injectionType) }}
						</p>
						<p class="text-sm text-text-primary">
							<span class="font-medium">Confidence:</span>
							{{ Math.round((message.securityFlags.confidence ?? 0) * 100) }}%
						</p>
						<p v-if="message.securityFlags.flaggedContent" class="text-sm text-text-secondary mt-2">
							<span class="font-medium text-text-primary">Flagged content:</span>
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
					{{ message.textBody || '(No text content)' }}
				</p>

				<!-- Actions -->
				<div class="flex items-center gap-2 border-t border-border-subtle pt-4">
					<button
						class="btn btn-secondary btn-sm gap-1"
						:disabled="actionInProgress === message._id"
						@click="onRelease(message._id)"
					>
						<Icon name="lucide:check-circle" class="w-3 h-3" />
						Release (False Positive)
					</button>
					<button
						class="btn btn-ghost btn-sm gap-1 text-error hover:bg-error-subtle"
						:disabled="actionInProgress === message._id"
						@click="onBlock(message._id)"
					>
						<Icon name="lucide:ban" class="w-3 h-3" />
						Block Sender
					</button>
				</div>
			</div>
		</div>
	</div>
</template>
