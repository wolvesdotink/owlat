<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	contactId: Id<'contacts'>;
}>();

const contactIdRef = computed(() => props.contactId);

const { stats, statsLoading, channelIcon, channelLabel, channelColor } = useContactTimeline(contactIdRef);

const { t, te } = useI18n();

// Channels are a closed set in the shared config, but the counts map comes from
// stored messages — an unknown key falls back to the shared display label.
function channelName(channel: string): string {
	const key = `components.contacts.timelineStatsCard.channels.${channel}`;
	return te(key) ? t(key) : channelLabel(channel);
}
</script>

<template>
	<div class="card">
		<div class="flex items-center gap-3 mb-4">
			<UiIconBox icon="lucide:bar-chart-3" size="sm" variant="surface" />
			<h2 class="text-lg font-medium text-text-primary">{{ t('components.contacts.timelineStatsCard.title') }}</h2>
		</div>

		<!-- Loading -->
		<div v-if="statsLoading" class="flex items-center justify-center py-4">
			<UiSpinner size="sm" />
		</div>

		<template v-else-if="stats">
			<!-- Summary stats -->
			<div class="grid grid-cols-2 gap-3 mb-4">
				<div class="p-3 rounded-lg bg-bg-surface">
					<p class="text-lg font-semibold text-text-primary">{{ stats.totalMessages ?? 0 }}</p>
					<p class="text-xs text-text-tertiary">{{ t('components.contacts.timelineStatsCard.messages') }}</p>
				</div>
				<div class="p-3 rounded-lg bg-bg-surface">
					<p class="text-lg font-semibold text-text-primary">{{ stats.totalThreads ?? 0 }}</p>
					<p class="text-xs text-text-tertiary">{{ t('components.contacts.timelineStatsCard.threads') }}</p>
				</div>
			</div>

			<!-- Per-channel counts -->
			<div v-if="stats.channelCounts" class="space-y-2 mb-4">
				<p class="text-xs font-medium text-text-tertiary uppercase tracking-wider">{{ t('components.contacts.timelineStatsCard.byChannel') }}</p>
				<div
					v-for="(count, channel) in stats.channelCounts"
					:key="channel"
					class="flex items-center justify-between py-1.5"
				>
					<div class="flex items-center gap-2">
						<Icon :name="channelIcon(String(channel))" class="w-4 h-4" :class="channelColor(String(channel))" />
						<span class="text-sm text-text-secondary">{{ channelName(String(channel)) }}</span>
					</div>
					<span class="text-sm font-medium text-text-primary">{{ count }}</span>
				</div>
			</div>

			<!-- First/Last interaction -->
			<div class="space-y-2 pt-3 border-t border-border-subtle">
				<div v-if="stats.firstInteraction" class="flex items-center justify-between">
					<span class="text-xs text-text-tertiary">{{ t('components.contacts.timelineStatsCard.firstContact') }}</span>
					<span class="text-xs text-text-secondary">{{ formatDate(stats.firstInteraction) }}</span>
				</div>
				<div v-if="stats.lastInteraction" class="flex items-center justify-between">
					<span class="text-xs text-text-tertiary">{{ t('components.contacts.timelineStatsCard.lastContact') }}</span>
					<span class="text-xs text-text-secondary">{{ formatDate(stats.lastInteraction) }}</span>
				</div>
			</div>
		</template>

		<!-- No data -->
		<div v-else class="text-center py-4">
			<p class="text-text-tertiary text-sm">{{ t('components.contacts.timelineStatsCard.empty') }}</p>
		</div>
	</div>
</template>
