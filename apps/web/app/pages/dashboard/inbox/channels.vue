<script setup lang="ts">
useHead({ title: 'Channels — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
});

// Global cross-channel inbox: the newest messages across every channel
// (email / sms / whatsapp / chat / generic), newest-first, with a server-side
// channel filter. This is the global counterpart to the per-contact unified
// timeline — it consumes `unifiedMessages.listRecent`. Each row links into its
// conversation thread.
const {
	timeline,
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
} = useChannelInbox();
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
			<div>
				<h1 class="text-2xl font-semibold text-text-primary">Channels</h1>
				<p class="text-text-secondary mt-1">
					Recent messages across every channel, newest first.
				</p>
			</div>
		</div>

		<!-- Channel filter pills -->
		<div class="flex flex-wrap gap-2 mb-6">
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

		<!-- Loading -->
		<div v-if="isLoading && !timeline.length" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<div class="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin" />
				<p class="text-text-secondary text-sm">Loading messages...</p>
			</div>
		</div>

		<!-- Empty -->
		<div
			v-else-if="timeline.length === 0"
			class="flex flex-col items-center justify-center py-16 text-center"
		>
			<UiIconBox icon="lucide:message-square" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">
				{{ channelFilter ? `No ${channelLabel(channelFilter)} messages` : 'No messages yet' }}
			</p>
			<p class="text-sm text-text-tertiary mt-1">
				Cross-channel messages will appear here as they are sent and received.
			</p>
		</div>

		<!-- Message list -->
		<div v-else class="space-y-2">
			<NuxtLink
				v-for="item in timeline"
				:key="item._id"
				:to="`/dashboard/inbox/${item.threadId}`"
				class="card !p-4 flex items-start gap-4 hover:border-brand transition-colors cursor-pointer block"
			>
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
					<p v-if="item.content.subject" class="text-text-primary text-sm font-medium">
						{{ item.content.subject }}
					</p>

					<!-- Content preview -->
					<p class="text-text-secondary text-sm mt-0.5">
						{{ truncate(item.content.text || '') }}
					</p>
				</div>

				<!-- Time -->
				<p class="flex-shrink-0 text-text-tertiary text-xs">
					{{ formatTime(item.createdAt) }}
				</p>
			</NuxtLink>
		</div>
	</div>
</template>
