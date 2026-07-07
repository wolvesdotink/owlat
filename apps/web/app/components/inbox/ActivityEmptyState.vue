<script setup lang="ts">
/**
 * Guided empty state for the All-activity feed.
 *
 * The feed is empty until a messaging channel is connected, so instead of a
 * dead-end message this surfaces the next task: connecting a channel. The
 * explanation is shown to everyone; the "Connect a channel" CTA links to
 * Settings → Messaging channels and is gated to admins (`canManage`) — the
 * settings mutations require `organization:manage`, so an editor should never
 * see an affordance that 403s. When a channel filter is active the copy
 * narrows to that channel but keeps the same guidance.
 */
defineProps<{
	/** Human channel label when a filter is active (e.g. "SMS"), else null. */
	filterLabel?: string | null;
	/** Whether the current member can manage channels (owner/admin). */
	canManage: boolean;
}>();
</script>

<template>
	<div class="flex flex-col items-center justify-center py-16 text-center">
		<UiIconBox
			icon="lucide:message-square"
			size="xl"
			variant="surface"
			rounded="full"
			class="mb-4"
		/>
		<p class="text-text-primary font-medium">
			{{ filterLabel ? `No ${filterLabel} messages yet` : 'No messages yet' }}
		</p>
		<p class="text-sm text-text-tertiary mt-1 max-w-sm">
			Cross-channel messages appear here once a channel is connected.
		</p>
		<NuxtLink
			v-if="canManage"
			to="/dashboard/settings/channels"
			class="btn btn-primary mt-5 inline-flex items-center gap-1.5"
			data-testid="connect-channel-cta"
		>
			<Icon name="lucide:plus" class="w-4 h-4" />
			Connect a channel
		</NuxtLink>
	</div>
</template>
