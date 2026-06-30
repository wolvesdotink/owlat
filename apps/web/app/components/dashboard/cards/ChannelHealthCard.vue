<script setup lang="ts">
import { api } from '@owlat/api';

const { data: channels, isLoading } = useOrganizationQuery(api.unifiedMessages.getChannelConfigs);

interface ChannelConfigRow {
	_id: string;
	channel: 'email' | 'sms' | 'whatsapp' | 'generic' | 'chat';
	displayName?: string;
	isEnabled: boolean;
	healthStatus?: 'healthy' | 'degraded' | 'down';
}

const channelList = computed<ChannelConfigRow[]>(() => channels.value ?? []);

const CHANNEL_ICONS: Record<string, string> = {
	email: 'lucide:mail',
	sms: 'lucide:smartphone',
	whatsapp: 'lucide:message-circle',
	generic: 'lucide:webhook',
	chat: 'lucide:message-square',
};

const CHANNEL_LABELS: Record<string, string> = {
	email: 'Email',
	sms: 'SMS',
	whatsapp: 'WhatsApp',
	generic: 'Generic webhook',
	chat: 'Chat',
};

function getChannelIcon(channel: string): string {
	return CHANNEL_ICONS[channel] ?? 'lucide:radio';
}

function getChannelName(channel: ChannelConfigRow): string {
	return channel.displayName || CHANNEL_LABELS[channel.channel] || channel.channel;
}

function getStatusVariant(channel: ChannelConfigRow): 'success' | 'warning' | 'error' | 'neutral' {
	if (!channel.isEnabled) return 'neutral';
	if (channel.healthStatus === 'degraded') return 'warning';
	if (channel.healthStatus === 'down') return 'error';
	return 'success';
}

function getStatusLabel(channel: ChannelConfigRow): string {
	if (!channel.isEnabled) return 'Disabled';
	if (channel.healthStatus === 'degraded') return 'Degraded';
	if (channel.healthStatus === 'down') return 'Down';
	return 'Healthy';
}
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center gap-2.5 mb-4">
				<UiIconBox icon="lucide:radio" size="sm" variant="success" />
				<h3 class="text-sm font-semibold text-text-primary">Channel Health</h3>
			</div>

			<div v-if="isLoading" class="flex items-center justify-center py-6">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>

			<div v-else-if="channelList.length === 0" class="py-4 text-center">
				<p class="text-sm text-text-tertiary">No channels configured</p>
			</div>

			<div v-else class="space-y-2">
				<div
					v-for="channel in channelList"
					:key="channel._id"
					class="flex items-center justify-between rounded-lg bg-bg-surface px-3 py-2"
				>
					<div class="flex items-center gap-2.5">
						<Icon :name="getChannelIcon(channel.channel)" class="w-4 h-4 text-text-secondary" />
						<span class="text-sm text-text-primary">{{ getChannelName(channel) }}</span>
					</div>
					<UiBadge :variant="getStatusVariant(channel)" dot>
						{{ getStatusLabel(channel) }}
					</UiBadge>
				</div>
			</div>
		</div>
	</UiCard>
</template>
