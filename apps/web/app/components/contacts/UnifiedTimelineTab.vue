<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { useChannelOutbound } from '~/composables/useChannelOutbound';
import type { SendableChannel } from '~/composables/useChannelOutbound';

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
	formatTime,
	truncate,
} = useUnifiedContactTimeline(contactIdRef);

// Manual outbound compose, over the shared send path (`useChannelOutbound`) the
// Team Inbox's per-message reply also uses. This surface's own job is only the
// target picker: every provider channel the admin has enabled, plus native chat
// once the contact has a thread to post on (chat needs no credentials, just a
// thread). Sending, gating and the toast belong to the composable.
const { isAdmin, enabledProviderChannels, isSending, send: sendOnChannel } = useChannelOutbound();

const { t, te } = useI18n();

// The channel set is closed in the shared config, but timeline rows carry
// whatever was stored — an unknown value falls back to the shared display label.
function channelName(channel: string): string {
	const key = `components.contacts.unifiedTimelineTab.channels.${channel}`;
	return te(key) ? t(key) : channelLabel(channel);
}

function directionName(direction: string): string {
	return t(
		direction === 'inbound'
			? 'components.contacts.unifiedTimelineTab.directions.inbound'
			: 'components.contacts.unifiedTimelineTab.directions.outbound'
	);
}

function statusName(status: string): string {
	const key = `components.contacts.unifiedTimelineTab.statuses.${status}`;
	return te(key) ? t(key) : status;
}

const sendableChannels = computed<Array<{ value: SendableChannel; label: string }>>(() => {
	const list: Array<{ value: SendableChannel; label: string }> = enabledProviderChannels.value.map(
		(channel) => ({ value: channel, label: channelName(channel) }),
	);
	if (latestThreadId.value !== null) {
		list.push({ value: 'chat', label: channelName('chat') });
	}
	return list;
});

const composeChannel = ref<SendableChannel | null>(null);
const composeText = ref('');

// Default the selected channel to the first sendable one once configs load.
watch(sendableChannels, (list) => {
	if (!composeChannel.value && list.length) composeChannel.value = list[0]!.value;
});

const canSend = computed(
	() => isAdmin.value && composeChannel.value !== null && composeText.value.trim().length > 0 && !isSending.value,
);

async function send() {
	if (!canSend.value || composeChannel.value === null) return;
	// Chat posts onto the contact's most recent thread; a provider channel lets
	// the backend resolve (or open) the thread for that channel.
	const sent = await sendOnChannel({
		channel: composeChannel.value,
		text: composeText.value,
		contactId: props.contactId,
		...(composeChannel.value === 'chat' ? { threadId: latestThreadId.value } : {}),
	});
	if (sent) composeText.value = '';
}
</script>

<template>
	<div class="card">
		<div class="flex items-center justify-between mb-4">
			<div>
				<h2 class="text-lg font-medium text-text-primary">{{ t('components.contacts.unifiedTimelineTab.title') }}</h2>
				<p class="text-text-tertiary text-sm mt-0.5">
					{{ t('components.contacts.unifiedTimelineTab.subtitle') }}
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
				{{ t('common.all') }}
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
				{{ channelName(ch) }}
			</button>
		</div>

		<!-- Manual outbound compose (admin-only, configured channels only) -->
		<div
			v-if="isAdmin && sendableChannels.length"
			class="mb-4 p-3 rounded-lg border border-border-subtle bg-bg-surface"
		>
			<div class="flex items-center gap-2 mb-2">
				<Icon name="lucide:send" class="w-4 h-4 text-text-tertiary" />
				<p class="text-sm font-medium text-text-primary">{{ t('components.contacts.unifiedTimelineTab.sendTitle') }}</p>
			</div>
			<div class="flex flex-col sm:flex-row gap-2">
				<div class="sm:w-44 shrink-0">
					<UiSelect
						v-model="composeChannel"
						:options="sendableChannels"
						size="sm"
						:placeholder="t('components.contacts.unifiedTimelineTab.channelPlaceholder')"
					/>
				</div>
				<UiTextarea
					v-model="composeText"
					:rows="2"
					size="sm"
					:placeholder="t('components.contacts.unifiedTimelineTab.messagePlaceholder')"
					class="flex-1"
				/>
			</div>
			<div class="flex justify-end mt-2">
				<UiButton size="sm" :disabled="!canSend" :loading="isSending" @click="send">
					<template #iconLeft>
						<Icon name="lucide:send" class="w-4 h-4" />
					</template>
					{{ t('common.send') }}
				</UiButton>
			</div>
		</div>

		<!-- Loading -->
		<div v-if="isLoading && !filteredTimeline.length" class="flex items-center justify-center py-8">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner size="md" />
				<p class="text-text-tertiary text-sm">{{ t('components.contacts.unifiedTimelineTab.loading') }}</p>
			</div>
		</div>

		<!-- Empty -->
		<div
			v-else-if="filteredTimeline.length === 0"
			class="flex flex-col items-center justify-center py-8 text-center"
		>
			<UiIconBox icon="lucide:message-square" size="lg" variant="surface" rounded="full" class="mb-3" />
			<p class="text-text-secondary text-sm">
				{{
					channelFilter
						? t('components.contacts.unifiedTimelineTab.emptyForChannel', {
								channel: channelName(channelFilter),
							})
						: t('components.contacts.unifiedTimelineTab.empty')
				}}
			</p>
			<p class="text-text-tertiary text-sm mt-1">
				{{ t('components.contacts.unifiedTimelineTab.emptyHint') }}
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
										? 'bg-info-subtle text-info'
										: 'bg-success-subtle text-success',
								]"
							>
								<Icon :name="directionIcon(item.direction)" class="w-3 h-3" />
								{{ directionName(item.direction) }}
							</span>

							<!-- Channel badge -->
							<UiBadge variant="neutral" size="sm">
								{{ channelName(item.channel) }}
							</UiBadge>

							<!-- Status -->
							<UiBadge
								v-if="item.status && item.status !== 'received' && item.status !== 'sent'"
								:variant="item.status === 'delivered' || item.status === 'read' ? 'success' : item.status === 'failed' ? 'error' : 'neutral'"
								size="sm"
							>
								{{ statusName(item.status) }}
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
