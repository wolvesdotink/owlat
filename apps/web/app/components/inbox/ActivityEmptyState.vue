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
 *
 * Structure comes from the shared `UiEmptyState` ladder (eyebrow → heading →
 * one lead → one action); this component only decides the wording and who gets
 * the button.
 */
defineProps<{
	/** Human channel label when a filter is active (e.g. "SMS"), else null. */
	filterLabel?: string | null;
	/** Whether the current member can manage channels (owner/admin). */
	canManage: boolean;
}>();

const { t } = useI18n();
</script>

<template>
	<UiEmptyState
		icon="lucide:message-square"
		:title="
			filterLabel
				? t('components.inbox.activityEmptyState.emptyForChannel', { channel: filterLabel })
				: t('components.inbox.activityEmptyState.empty')
		"
		:description="t('components.inbox.activityEmptyState.description')"
	>
		<template v-if="canManage" #action>
			<UiButton
				to="/dashboard/admin/instance/channels"
				class="inline-flex items-center gap-1.5"
				data-testid="connect-channel-cta"
			>
				<Icon name="lucide:plus" class="w-4 h-4" />
				{{ t('components.inbox.activityEmptyState.connectChannel') }}
			</UiButton>
		</template>
	</UiEmptyState>
</template>
