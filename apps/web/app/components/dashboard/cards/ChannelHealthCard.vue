<script setup lang="ts">
import { api } from '@owlat/api';

const { t } = useI18n();

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

/** Message keys, resolved per render so the labels follow the active locale. */
const CHANNEL_LABEL_KEYS: Record<string, string> = {
	email: 'components.dashboard.cards.channelHealth.channels.email',
	sms: 'components.dashboard.cards.channelHealth.channels.sms',
	whatsapp: 'components.dashboard.cards.channelHealth.channels.whatsapp',
	generic: 'components.dashboard.cards.channelHealth.channels.generic',
	chat: 'components.dashboard.cards.channelHealth.channels.chat',
};

function getChannelIcon(channel: string): string {
	return CHANNEL_ICONS[channel] ?? 'lucide:radio';
}

function getChannelName(channel: ChannelConfigRow): string {
	if (channel.displayName) return channel.displayName;
	const key = CHANNEL_LABEL_KEYS[channel.channel];
	return key ? t(key) : channel.channel;
}

function getStatusVariant(channel: ChannelConfigRow): 'success' | 'warning' | 'error' | 'neutral' {
	if (!channel.isEnabled) return 'neutral';
	if (channel.healthStatus === 'degraded') return 'warning';
	if (channel.healthStatus === 'down') return 'error';
	return 'success';
}

function getStatusLabel(channel: ChannelConfigRow): string {
	if (!channel.isEnabled) return t('common.disabled');
	if (channel.healthStatus === 'degraded')
		return t('components.dashboard.cards.channelHealth.status.degraded');
	if (channel.healthStatus === 'down')
		return t('components.dashboard.cards.channelHealth.status.down');
	return t('components.dashboard.cards.channelHealth.status.healthy');
}
</script>

<template>
	<UiCard class="h-full" padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center gap-2.5 mb-4">
				<UiIconBox icon="lucide:radio" size="sm" variant="surface" />
				<h3 class="text-sm font-semibold text-text-primary">
					{{ t('components.dashboard.cards.channelHealth.title') }}
				</h3>
			</div>

			<DashboardCardSkeleton v-if="isLoading" shape="list" :count="3" :avatar="false" />

			<div v-else-if="channelList.length === 0" class="py-4 text-center">
				<Icon name="lucide:radio" class="w-6 h-6 text-text-tertiary mx-auto mb-2" />
				<p class="text-sm text-text-tertiary">
					{{ t('components.dashboard.cards.channelHealth.empty') }}
				</p>
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
