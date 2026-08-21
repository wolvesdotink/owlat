<script setup lang="ts">
// The list pane's connectivity strip: a quiet offline notice while the device
// is offline (with the on-device queue depth, when anything is queued), and —
// back online — the post-drain "couldn't send" notice with its retry. Exactly
// one of the two shows. Extracted from PostboxLayout.vue to keep the layout
// under the file-size cap; the outbox itself stays mounted in the layout so the
// drain-on-reconnect watcher runs in Today mode too.
defineProps<{
	isOffline: boolean;
	/** Sends waiting on this device (offline notice only). */
	queuedCount: number;
	/** Sends the reconnect drain could not deliver; still queued on-device. */
	failedCount: number;
	/** When the served offline-cache snapshot was persisted (ms), if the list
	 * is currently showing cached rows. Drives the "cached at 14:32" clause —
	 * stale rows are only trustworthy once they carry their own age. */
	cachedAt?: number | null;
}>();

const emit = defineEmits<{
	/** Retry the failed queue (re-runs the drain). */
	retry: [];
}>();

const { t } = useI18n();
</script>

<template>
	<!-- Quiet offline banner: cached list + already-read bodies stay
	     readable; sends queue on this device and go out on reconnect. -->
	<div
		v-if="isOffline"
		class="flex items-center gap-2 px-4 py-2 bg-warning-subtle text-warning text-xs border-b border-border-subtle"
		role="status"
	>
		<Icon name="lucide:cloud-off" class="w-3.5 h-3.5 flex-shrink-0" />
		<span class="truncate">{{
			cachedAt
				? t('components.postbox.postboxOfflineBanners.offlineBannerCached', {
						time: new Date(cachedAt).toLocaleTimeString([], {
							hour: '2-digit',
							minute: '2-digit',
						}),
					})
				: queuedCount > 0
					? t('components.postbox.postboxOfflineBanners.offlineBannerQueued', {
							count: queuedCount,
						})
					: t('components.postbox.postboxOfflineBanners.offlineBanner')
		}}</span>
	</div>
	<!-- Post-drain honesty: items the reconnect drain could NOT send stay
	     queued on-device with their error — surface them, with a retry. -->
	<div
		v-else-if="failedCount > 0"
		class="flex items-center gap-2 px-4 py-2 bg-warning-subtle text-warning text-xs border-b border-border-subtle"
		role="status"
	>
		<Icon name="lucide:send" class="w-3.5 h-3.5 flex-shrink-0" />
		<span class="truncate">{{
			t(
				'components.postbox.postboxOfflineBanners.failedSendsBanner',
				{ count: failedCount },
				failedCount
			)
		}}</span>
		<button
			type="button"
			class="font-semibold underline hover:no-underline flex-shrink-0"
			@click="emit('retry')"
		>
			{{ t('components.postbox.postboxOfflineBanners.retryQueuedSends') }}
		</button>
	</div>
</template>
