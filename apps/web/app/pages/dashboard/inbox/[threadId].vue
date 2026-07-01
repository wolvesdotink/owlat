<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { useOrganization } from '~/composables/useOrganization';

useHead({ title: 'Thread — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
});

const route = useRoute();
const threadId = computed(() => route.params['threadId'] as Id<'conversationThreads'>);

const {
	thread,
	messages,
	contact,
	threadLoading,
	isEditingDraft,
	editedDraftResponse,
	editedDraftSubject,
	handleApprove,
	handleReject,
	handleRetry,
	startEditDraft,
	cancelEditDraft,
	saveEditedDraft,
	handleStatusChange,
	getProcessingStatusColor,
	getProcessingStatusLabel,
	getCategoryIcon,
	formatTimestamp,
	handleAssign,
} = useThreadDetail(threadId);

// Org members for the assignee picker (shared-inbox team triage).
const { members, fetchMembers } = useOrganization();
onMounted(() => {
	void fetchMembers();
});
const assignedMemberName = computed(() => {
	const id = thread.value?.assignedTo;
	if (!id) return null;
	const m = members.value.find((x) => x.userId === id);
	return m ? m.user.name || m.user.email : id;
});

// Actions state
const isApproving = ref(false);
const isRejecting = ref(false);
const isSavingEdit = ref(false);
const isRetrying = ref(false);
const rejectReason = ref('');
const showRejectModal = ref(false);
const actionMessageId = ref<Id<'inboundMessages'> | null>(null);

// Use the shared global toast. The underlying actions go through
// useBackendOperation, which already toasts any categorized failure — so we
// only emit the success toast here, and only when the operation truly
// succeeded (run resolves to `undefined` on failure, never throws).
const { showToast } = useToast();

const onApprove = async (messageId: Id<'inboundMessages'>) => {
	isApproving.value = true;
	try {
		const result = await handleApprove(messageId);
		if (result !== undefined) showToast('Draft approved and queued for sending');
	} finally {
		isApproving.value = false;
	}
};

const openRejectModal = (messageId: Id<'inboundMessages'>) => {
	actionMessageId.value = messageId;
	rejectReason.value = '';
	showRejectModal.value = true;
};

const onReject = async () => {
	if (!actionMessageId.value) return;
	isRejecting.value = true;
	try {
		const result = await handleReject(actionMessageId.value, rejectReason.value || undefined);
		if (result !== undefined) {
			showRejectModal.value = false;
			showToast('Draft rejected');
		}
	} finally {
		isRejecting.value = false;
	}
};

const onRetry = async (messageId: Id<'inboundMessages'>) => {
	isRetrying.value = true;
	try {
		const result = await handleRetry(messageId);
		if (result !== undefined) showToast('Message re-enqueued for processing');
	} finally {
		isRetrying.value = false;
	}
};

const onSaveEdit = async (messageId: Id<'inboundMessages'>) => {
	isSavingEdit.value = true;
	try {
		const result = await saveEditedDraft(messageId);
		if (result !== undefined) showToast('Draft saved, approved and queued for sending');
	} finally {
		isSavingEdit.value = false;
	}
};

const statusOptions = ['open', 'waiting', 'resolved', 'closed'] as const;

// Chat integration: surface existing chat channels that already discuss this
// thread, and offer to spin up a new one. Only active when the chat flag is
// enabled — the query throws FEATURE_DISABLED otherwise.
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const chatEnabled = computed(() => isFeatureEnabled('chat'));

const { data: discussionChannelsData } = useConvexQuery(
	api.chat.emailLink.findChannelsForInboxThread,
	() => (chatEnabled.value ? { inboxThreadId: threadId.value } : 'skip'),
);
const discussionChannels = computed(() => discussionChannelsData.value ?? []);

const showNewChannel = ref(false);
const router = useRouter();
const { linkChannelToInboxThread } = useChatActions();
const onChannelCreated = async (roomId: Id<'chatRooms'>) => {
	// Channel was just created — link it to this inbox thread, then jump.
	// run() toasts its own failure and returns undefined; only navigate into the
	// channel when the link actually persisted.
	const result = await linkChannelToInboxThread(roomId, threadId.value);
	showNewChannel.value = false;
	if (result === undefined) {
		showToast('Channel created, but linking failed', 'error');
		return;
	}
	router.push(`/dashboard/chat/${roomId}`);
};
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Back Navigation -->
		<NuxtLink
			to="/dashboard/inbox"
			class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-6"
		>
			<Icon name="lucide:arrow-left" class="w-4 h-4" />
			Back to Inbox
		</NuxtLink>

		<!-- Loading -->
		<div v-if="threadLoading && !thread" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading thread...</p>
			</div>
		</div>

		<!-- Not Found -->
		<div v-else-if="!thread" class="flex flex-col items-center justify-center py-16 text-center">
			<UiIconBox icon="lucide:alert-circle" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">Thread not found</p>
			<NuxtLink to="/dashboard/inbox" class="btn btn-secondary mt-6">Back to Inbox</NuxtLink>
		</div>

		<!-- Thread Content -->
		<template v-else>
			<!-- Header -->
			<div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
				<div>
					<h1 class="text-2xl font-semibold text-text-primary">
						{{ thread.subject || 'No subject' }}
					</h1>
					<div class="flex items-center gap-3 mt-2">
						<span
							class="text-xs px-2 py-0.5 rounded-full font-medium"
							:class="{
								'text-brand bg-brand-subtle': thread.status === 'open',
								'text-warning bg-warning/10': thread.status === 'waiting',
								'text-success bg-success-subtle': thread.status === 'resolved',
								'text-text-tertiary bg-bg-surface': thread.status === 'closed',
							}"
						>
							{{ thread.status }}
						</span>
						<span v-if="contact" class="text-sm text-text-secondary">
							{{ contact.email }}
						</span>
						<span class="text-sm text-text-tertiary">
							{{ thread.messageCount ?? 0 }} messages
						</span>
					</div>
				</div>

				<!-- Status actions -->
				<div class="flex items-center gap-2">
					<div v-if="chatEnabled" class="flex items-center gap-1">
						<NuxtLink
							v-for="channel in discussionChannels"
							:key="channel._id"
							:to="`/dashboard/chat/${channel._id}`"
							class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-brand-subtle text-brand hover:bg-brand-subtle/70 transition-colors"
							:title="`Discuss in ${channel.name}`"
						>
							<Icon name="lucide:message-circle" class="w-3.5 h-3.5" />
							#{{ channel.name }}
						</NuxtLink>
						<button
							v-if="discussionChannels.length === 0"
							class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-bg-surface border border-border-subtle text-text-secondary hover:text-text-primary transition-colors"
							@click="showNewChannel = true"
						>
							<Icon name="lucide:message-circle-plus" class="w-3.5 h-3.5" />
							Discuss in channel
						</button>
					</div>
					<select
						:value="thread.status"
						class="input w-auto text-sm"
						@change="handleStatusChange(($event.target as HTMLSelectElement).value as 'open' | 'waiting' | 'resolved' | 'closed')"
					>
						<option v-for="s in statusOptions" :key="s" :value="s">
							{{ s.charAt(0).toUpperCase() + s.slice(1) }}
						</option>
					</select>
				</div>
			</div>

			<ChatNewChannelDialog
				v-if="showNewChannel"
				@close="showNewChannel = false"
				@created="onChannelCreated"
			/>

			<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
				<!-- Messages Timeline -->
				<div class="lg:col-span-2 space-y-4">
					<div
						v-for="message in messages"
						:key="message._id"
						class="card"
					>
						<!-- Message Header -->
						<div class="flex items-center justify-between mb-4">
							<div class="flex items-center gap-3">
								<UiIconBox icon="lucide:mail" size="sm" variant="surface" rounded="full" />
								<div>
									<p class="text-text-primary font-medium text-sm">{{ message.from }}</p>
									<p class="text-xs text-text-tertiary">
										{{ formatTimestamp(message._creationTime) }}
									</p>
								</div>
							</div>
							<span
								class="text-xs px-2 py-0.5 rounded-full"
								:class="getProcessingStatusColor(message.processingStatus)"
							>
								{{ getProcessingStatusLabel(message.processingStatus) }}
							</span>
						</div>

						<!-- Subject -->
						<p v-if="message.subject" class="text-text-primary font-medium mb-2">
							{{ message.subject }}
						</p>

						<!-- Message Body -->
						<div class="text-text-secondary text-sm whitespace-pre-wrap border-t border-border-subtle pt-4">
							{{ message.textBody || '(No text content)' }}
						</div>

						<!-- Classification -->
						<div
							v-if="message.classification"
							class="mt-4 p-3 bg-bg-surface rounded-lg"
						>
							<p class="text-xs text-text-tertiary mb-2 font-medium uppercase tracking-wider">
								AI Classification
							</p>
							<div class="flex flex-wrap gap-2">
								<span class="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-brand-subtle text-brand">
									<Icon :name="getCategoryIcon(message.classification.category)" class="w-3 h-3" />
									{{ message.classification.category }}
								</span>
								<span class="text-xs px-2 py-1 rounded-full bg-bg-elevated text-text-secondary">
									{{ message.classification.priority }} priority
								</span>
								<span class="text-xs px-2 py-1 rounded-full bg-bg-elevated text-text-secondary">
									{{ message.classification.sentiment }}
								</span>
								<span class="text-xs px-2 py-1 rounded-full bg-bg-elevated text-text-secondary font-mono">
									{{ Math.round((message.classification.confidence ?? 0) * 100) }}% confidence
								</span>
							</div>
						</div>

						<!-- Failure reason + manual retry (terminal 'failed' state) -->
						<div
							v-if="message.processingStatus === 'failed'"
							class="mt-4 p-3 bg-error-subtle rounded-lg"
						>
							<p class="text-xs text-error font-medium uppercase tracking-wider mb-2">
								Processing failed
							</p>
							<p v-if="message.errorMessage" class="text-sm text-text-primary break-words mb-3">
								{{ message.errorMessage }}
							</p>
							<p v-else class="text-sm text-text-secondary mb-3">
								No error detail was recorded.
							</p>
							<button
								class="btn btn-secondary btn-sm gap-1"
								:disabled="isRetrying"
								@click="onRetry(message._id)"
							>
								<Icon name="lucide:refresh-cw" class="w-3 h-3" />
								Retry processing
							</button>
						</div>

						<!-- Agent processing trace -->
						<InboxAgentActionTimeline :inbound-message-id="message._id" />

						<!-- Draft Response -->
						<div
							v-if="message.draftResponse && message.processingStatus === 'draft_ready'"
							class="mt-4 border-t border-border-subtle pt-4"
						>
							<div class="flex items-center gap-2 mb-3">
								<Icon name="lucide:bot" class="w-4 h-4 text-brand" />
								<p class="text-sm font-medium text-brand">Agent Draft</p>
							</div>

							<!-- Editing mode -->
							<template v-if="isEditingDraft">
								<div class="space-y-3">
									<input
										v-model="editedDraftSubject"
										type="text"
										class="input w-full text-sm"
										placeholder="Subject (optional)"
									/>
									<textarea
										v-model="editedDraftResponse"
										rows="8"
										class="input w-full text-sm resize-y"
									/>
									<div class="flex items-center gap-2">
										<button
											class="btn btn-primary btn-sm gap-1"
											:disabled="isSavingEdit"
											@click="onSaveEdit(message._id)"
										>
											<Icon name="lucide:save" class="w-3 h-3" />
											Save & Approve
										</button>
										<button class="btn btn-ghost btn-sm" @click="cancelEditDraft">
											Cancel
										</button>
									</div>
								</div>
							</template>

							<!-- View mode -->
							<template v-else>
								<div class="text-text-primary text-sm whitespace-pre-wrap bg-brand-subtle/30 rounded-lg p-4">
									{{ message.draftResponse }}
								</div>

								<!-- Action Buttons -->
								<div class="flex items-center gap-2 mt-4">
									<button
										class="btn btn-primary btn-sm gap-1"
										:disabled="isApproving"
										@click="onApprove(message._id)"
									>
										<div
											v-if="isApproving"
											class="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"
										/>
										<Icon v-else name="lucide:check" class="w-3 h-3" />
										Approve & Send
									</button>
									<button
										class="btn btn-secondary btn-sm gap-1"
										@click="startEditDraft(message)"
									>
										<Icon name="lucide:pencil" class="w-3 h-3" />
										Edit
									</button>
									<button
										class="btn btn-ghost btn-sm gap-1 text-error hover:bg-error-subtle"
										@click="openRejectModal(message._id)"
									>
										<Icon name="lucide:x" class="w-3 h-3" />
										Reject
									</button>
								</div>
							</template>
						</div>
					</div>

					<!-- Empty messages -->
					<div v-if="messages.length === 0" class="card text-center py-8">
						<p class="text-text-tertiary">No messages in this thread yet.</p>
					</div>
				</div>

				<!-- Sidebar -->
				<div class="space-y-6">
					<!-- Contact Card -->
					<div v-if="contact" class="card">
						<h2 class="text-lg font-medium text-text-primary mb-4">Contact</h2>
						<div class="space-y-3">
							<div class="flex items-center gap-3">
								<UiIconBox icon="lucide:user" size="sm" variant="surface" rounded="full" />
								<div>
									<p class="text-text-primary text-sm font-medium">
										{{ contact.firstName || contact.lastName
											? `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim()
											: contact.email
										}}
									</p>
									<p class="text-xs text-text-tertiary">{{ contact.email }}</p>
								</div>
							</div>
							<NuxtLink
								:to="`/dashboard/audience/contacts/${contact._id}`"
								class="text-sm text-brand hover:underline"
							>
								View contact profile
							</NuxtLink>
						</div>
					</div>

					<!-- Thread Details -->
					<div class="card">
						<h2 class="text-lg font-medium text-text-primary mb-4">Details</h2>
						<div class="space-y-3">
							<div>
								<p class="text-xs text-text-tertiary">Status</p>
								<p class="text-text-primary capitalize">{{ thread.status }}</p>
							</div>
							<div>
								<p class="text-xs text-text-tertiary">Messages</p>
								<p class="text-text-primary">{{ thread.messageCount ?? 0 }}</p>
							</div>
							<div>
								<p class="text-xs text-text-tertiary mb-1">Assigned To</p>
								<select
									class="w-full text-sm border border-border-subtle rounded-lg px-2 py-1.5 bg-bg-surface text-text-primary"
									:value="thread.assignedTo ?? ''"
									aria-label="Assign thread to a teammate"
									@change="(e) => handleAssign((e.target as HTMLSelectElement).value || undefined)"
								>
									<option value="">Unassigned</option>
									<option v-for="m in members" :key="m.userId" :value="m.userId">
										{{ m.user.name || m.user.email }}
									</option>
								</select>
								<p v-if="assignedMemberName && !members.length" class="text-text-tertiary text-xs mt-1">
									Currently: {{ assignedMemberName }}
								</p>
							</div>
							<div v-if="thread.lastMessageAt">
								<p class="text-xs text-text-tertiary">Last Message</p>
								<p class="text-text-primary text-sm">{{ formatTimestamp(thread.lastMessageAt) }}</p>
							</div>
						</div>
					</div>

					<!-- Cross-channel unified timeline for this thread -->
					<InboxThreadChannelTimeline :thread-id="threadId" />
				</div>
			</div>
		</template>

		<!-- Reject Modal -->
		<UiModal
			:open="showRejectModal"
			title="Reject Draft"
			:closable="!isRejecting"
			:persistent="isRejecting"
			@update:open="(v: boolean) => !v && (showRejectModal = false)"
		>
			<p class="text-sm text-text-secondary mb-4">
				Optionally provide a reason. This feedback helps improve future drafts.
			</p>
			<textarea
				v-model="rejectReason"
				rows="3"
				class="input w-full resize-y"
				placeholder="Reason for rejection (optional)"
				:disabled="isRejecting"
			/>

			<template #footer>
				<UiButton variant="secondary" :disabled="isRejecting" @click="showRejectModal = false">
					Cancel
				</UiButton>
				<UiButton variant="danger" :loading="isRejecting" @click="onReject">
					{{ isRejecting ? 'Rejecting...' : 'Reject Draft' }}
				</UiButton>
			</template>
		</UiModal>
	</div>
</template>
