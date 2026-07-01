<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	contactId: Id<'contacts'>;
}>();

const contactIdRef = computed(() => props.contactId);

const {
	filteredTimeline,
	latestThreadId,
	isLoading,
	channelFilter,
	channels,
	channelIcon,
	channelLabel,
	channelColor,
	directionIcon,
	directionLabel,
	formatTime,
	truncate,
} = useUnifiedContactTimeline(contactIdRef);

// Manual outbound compose. The non-email channels (sms/whatsapp/generic) have a
// fully-built provider dispatch (channels/outbound.ts) that, until now, only the
// AI agent reply path triggered — so an admin who configured SMS/WhatsApp/generic
// creds had no way to send through them. This composer is that user-initiated
// path: it calls `channels.outbound.sendChannelMessage`, which resolves/opens the
// thread and schedules the same fail-safe dispatch.
//
// Native `chat` is different: it has no provider/credentials and writes straight
// into Convex via `unifiedMessages.sendChatMessage` (keyed to a conversation
// thread). It's offered whenever the contact already has a thread to reply on —
// no channel config required. Both paths are admin-only (the backend re-checks
// `organization:manage`).
const OUTBOUND_CHANNELS = ['sms', 'whatsapp', 'generic'] as const;
type SendableChannel = (typeof OUTBOUND_CHANNELS)[number] | 'chat';

const { role } = useOrganizationContext();
const isAdmin = computed(() => role.value === 'owner' || role.value === 'admin');

const { data: channelConfigs } = useConvexQuery(api.unifiedMessages.getChannelConfigs, () => ({}));

// Provider channels the admin has enabled, plus native chat once a thread exists.
const sendableChannels = computed(() => {
	const list = (channelConfigs.value ?? [])
		.filter((c) => c.isEnabled && (OUTBOUND_CHANNELS as readonly string[]).includes(c.channel))
		.map((c) => ({ value: c.channel as SendableChannel, label: channelLabel(c.channel) }));
	if (latestThreadId.value !== null) {
		list.push({ value: 'chat', label: channelLabel('chat') });
	}
	return list;
});

const composeChannel = ref<SendableChannel | null>(null);
const composeText = ref('');

// Default the selected channel to the first sendable one once configs load.
watch(sendableChannels, (list) => {
	if (!composeChannel.value && list.length) composeChannel.value = list[0]!.value;
});

const { showToast } = useToast();
const { run: sendChannelMessage, isLoading: isSendingChannel } = useBackendOperation(
	api.channels.outbound.sendChannelMessage,
	{ label: 'Send channel message', type: 'action' },
);
const { run: sendChatMessage, isLoading: isSendingChat } = useBackendOperation(
	api.unifiedMessages.sendChatMessage,
	{ label: 'Send chat message', type: 'mutation' },
);

const isSending = computed(() => isSendingChannel.value || isSendingChat.value);

const canSend = computed(
	() => isAdmin.value && composeChannel.value !== null && composeText.value.trim().length > 0 && !isSending.value,
);

async function send() {
	if (!canSend.value || composeChannel.value === null) return;
	const text = composeText.value.trim();
	let result: unknown;
	if (composeChannel.value === 'chat') {
		// Native chat posts directly onto the contact's most recent thread.
		if (latestThreadId.value === null) return;
		result = await sendChatMessage({
			threadId: latestThreadId.value,
			text,
			contactId: props.contactId,
		});
	} else {
		result = await sendChannelMessage({
			contactId: props.contactId,
			channel: composeChannel.value,
			text,
		});
	}
	if (result === undefined) return; // useBackendOperation already surfaced the error
	composeText.value = '';
	showToast('Message sent', 'success');
}
</script>

<template>
	<div class="card">
		<div class="flex items-center justify-between mb-4">
			<div>
				<h2 class="text-lg font-medium text-text-primary">Unified Timeline</h2>
				<p class="text-text-tertiary text-sm mt-0.5">
					Every message across all channels, newest first.
				</p>
			</div>
		</div>

		<!-- Channel filter pills -->
		<div class="flex flex-wrap gap-2 mb-4">
			<button
				:class="[
					'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
					!channelFilter
						? 'bg-brand-subtle text-brand'
						: 'bg-bg-surface text-text-secondary hover:text-text-primary',
				]"
				@click="channelFilter = null"
			>
				All
			</button>
			<button
				v-for="ch in channels"
				:key="ch"
				:class="[
					'px-3 py-1.5 rounded-full text-xs font-medium transition-colors flex items-center gap-1.5',
					channelFilter === ch
						? 'bg-brand-subtle text-brand'
						: 'bg-bg-surface text-text-secondary hover:text-text-primary',
				]"
				@click="channelFilter = channelFilter === ch ? null : ch"
			>
				<Icon :name="channelIcon(ch)" class="w-3 h-3" />
				{{ channelLabel(ch) }}
			</button>
		</div>

		<!-- Manual outbound compose (admin-only, configured channels only) -->
		<div
			v-if="isAdmin && sendableChannels.length"
			class="mb-4 p-3 rounded-lg border border-border-subtle bg-bg-surface"
		>
			<div class="flex items-center gap-2 mb-2">
				<Icon name="lucide:send" class="w-4 h-4 text-text-tertiary" />
				<p class="text-sm font-medium text-text-primary">Send a message</p>
			</div>
			<div class="flex flex-col sm:flex-row gap-2">
				<div class="sm:w-44 shrink-0">
					<UiSelect
						v-model="composeChannel"
						:options="sendableChannels"
						size="sm"
						placeholder="Channel"
					/>
				</div>
				<UiTextarea
					v-model="composeText"
					:rows="2"
					size="sm"
					placeholder="Type a message to send on this channel…"
					class="flex-1"
				/>
			</div>
			<div class="flex justify-end mt-2">
				<UiButton size="sm" :disabled="!canSend" :loading="isSending" @click="send">
					<template #iconLeft>
						<Icon name="lucide:send" class="w-4 h-4" />
					</template>
					Send
				</UiButton>
			</div>
		</div>

		<!-- Loading -->
		<div v-if="isLoading && !filteredTimeline.length" class="flex items-center justify-center py-8">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner size="md" />
				<p class="text-text-tertiary text-sm">Loading timeline...</p>
			</div>
		</div>

		<!-- Empty -->
		<div
			v-else-if="filteredTimeline.length === 0"
			class="flex flex-col items-center justify-center py-8 text-center"
		>
			<UiIconBox icon="lucide:message-square" size="lg" variant="surface" rounded="full" class="mb-3" />
			<p class="text-text-secondary text-sm">
				{{ channelFilter ? `No ${channelLabel(channelFilter)} messages` : 'No messages yet' }}
			</p>
			<p class="text-text-tertiary text-sm mt-1">
				Cross-channel messages will appear here as they are sent and received.
			</p>
		</div>

		<!-- Timeline list -->
		<div v-else class="space-y-1">
			<div
				v-for="(item, index) in filteredTimeline"
				:key="item._id"
				class="relative"
			>
				<!-- Timeline connector -->
				<div
					v-if="index < filteredTimeline.length - 1"
					class="absolute left-5 top-10 bottom-0 w-px bg-border-subtle"
				/>

				<!-- Timeline item -->
				<div class="flex items-start gap-4 py-3">
					<!-- Channel icon -->
					<div
						class="flex-shrink-0 w-10 h-10 rounded-full bg-bg-surface flex items-center justify-center"
					>
						<Icon :name="channelIcon(item.channel)" class="w-5 h-5" :class="channelColor(item.channel)" />
					</div>

					<!-- Content -->
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2 mb-0.5">
							<!-- Direction badge -->
							<span
								:class="[
									'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium',
									item.direction === 'inbound'
										? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400'
										: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
								]"
							>
								<Icon :name="directionIcon(item.direction)" class="w-3 h-3" />
								{{ directionLabel(item.direction) }}
							</span>

							<!-- Channel badge -->
							<UiBadge variant="neutral" size="sm">
								{{ channelLabel(item.channel) }}
							</UiBadge>

							<!-- Status -->
							<UiBadge
								v-if="item.status && item.status !== 'received' && item.status !== 'sent'"
								:variant="item.status === 'delivered' || item.status === 'read' ? 'success' : item.status === 'failed' ? 'error' : 'neutral'"
								size="sm"
							>
								{{ item.status }}
							</UiBadge>
						</div>

						<!-- Subject (for email) -->
						<p
							v-if="item.content.subject"
							class="text-text-primary text-sm font-medium"
						>
							{{ item.content.subject }}
						</p>

						<!-- Content preview -->
						<p class="text-text-secondary text-sm mt-0.5">
							{{ truncate(item.content.text || '') }}
						</p>

						<!-- Time -->
						<p class="text-text-tertiary text-xs mt-1">
							{{ formatTime(item.createdAt) }}
						</p>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>
