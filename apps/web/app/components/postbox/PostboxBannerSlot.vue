<script setup lang="ts">
/**
 * The list pane's one banner slot.
 *
 * The connectivity strip, the one-time sealed-mail nudge and the "waiting on
 * your reply" strip used to mount independently and stack, so a bad day put
 * three advisory rows between the folder title and the first message. Exactly
 * one renders now, by the priority in usePostboxBannerSlot (offline > sealed >
 * reply queue); the others take the slot the moment the one above them is
 * dismissed or resolves.
 */
import type { Id } from '@owlat/api/dataModel';
import { usePostboxBannerSlot } from '~/composables/postbox/usePostboxBanners';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	folderRole: string;
	isOffline: boolean;
	/** Sends waiting on this device (offline notice only). */
	queuedCount: number;
	/** Sends the reconnect drain could not deliver; still queued on-device. */
	failedCount: number;
	/** When the served offline-cache snapshot was persisted (ms), if any. */
	cachedAt?: number | null;
}>();

const emit = defineEmits<{
	/** Retry the failed queue (re-runs the drain). */
	retry: [];
}>();

const { active } = usePostboxBannerSlot({
	isOffline: computed(() => props.isOffline),
	failedCount: computed(() => props.failedCount),
	mailboxId: computed(() => props.mailboxId),
	folderRole: computed(() => props.folderRole),
});
</script>

<template>
	<PostboxOfflineBanners
		v-if="active === 'offline'"
		:is-offline="isOffline"
		:queued-count="queuedCount"
		:failed-count="failedCount"
		:cached-at="cachedAt"
		@retry="emit('retry')"
	/>
	<PostboxSealedMailNudge v-else-if="active === 'sealed'" />
	<PostboxReplyQueueStrip
		v-else-if="active === 'replyQueue'"
		:mailbox-id="mailboxId"
		:folder-role="folderRole"
	/>
</template>
